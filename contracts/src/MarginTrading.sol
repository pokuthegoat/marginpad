// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IMarginPool} from "./interfaces/IMarginPool.sol";
import {IMarginTrading} from "./interfaces/IMarginTrading.sol";
import {IRiskManager} from "./interfaces/IRiskManager.sol";
import {ProtocolParams} from "./ProtocolParams.sol";
import {Position, PositionStatus, Side} from "./Types.sol";
import {
    BelowMinimumCollateral,
    NotLiquidatable,
    NotPositionOwner,
    OnlyPool,
    PositionNotOpen,
    RenounceDisabled,
    ReserveTooLarge,
    ZeroAddress,
    ZeroAmount
} from "./Errors.sol";

/**
 * @title MarginTrading
 * @notice Opens and closes leveraged positions: the trader's collateral plus ETH borrowed from the MarginPool.
 *
 * Open: the trader's ETH is the collateral; `collateral * (leverage - 1)` is borrowed from the pool; the position
 * (size = collateral + borrowed) is recorded at the current oracle price.
 * Close (owner only): P&L = size * (price move) in the position's direction.
 *   profit -> 5% goes to the LPs via pool.repay(); the trader gets collateral + profit - 5%.
 *   loss   -> the collateral absorbs it (capped at the collateral); the trader gets the rest.
 *   The borrowed ETH always goes back to the pool in the same transaction.
 *
 * TESTNET SETTLEMENT RESERVE: positions are synthetic (no token is bought), so a profit needs a counterparty.
 * The owner funds `reserve` with test ETH; profits are paid from it and losses are added to it. A profit is capped
 * at the reserve so a close can never fail or leave the pool unpaid. Real funding comes with the Pons integration.
 *
 * Liquidation: anyone may liquidate a position past its liquidation price. The pool is repaid first; a price-gap
 * shortfall is written off with absorbLoss. All prices come from RiskManager.validPrice (rejects stale prices).
 *
 * TESTNET ONLY. Not audited.
 */
contract MarginTrading is IMarginTrading, Ownable2Step, Pausable, ReentrancyGuard {
    /// @inheritdoc IMarginTrading
    IMarginPool public immutable override pool;

    /// @inheritdoc IMarginTrading
    IRiskManager public immutable override riskManager;

    /// @inheritdoc IMarginTrading
    uint256 public override nextPositionId = 1;

    /// @inheritdoc IMarginTrading
    mapping(address market => uint256) public override marketBorrowed;

    /// @notice Test ETH held to pay trader profits (and credited with trader losses). Not pool money.
    uint256 public reserve;

    mapping(uint256 id => Position) private _positions;

    constructor(IMarginPool pool_, IRiskManager riskManager_, address initialOwner) Ownable(initialOwner) {
        if (address(pool_) == address(0) || address(riskManager_) == address(0)) revert ZeroAddress();
        pool = pool_;
        riskManager = riskManager_;
    }

    /*//////////////////////////////////////////////////////////////
                                  ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Emergency stop for every state-changing entry point.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Owner only. Add test ETH to the settlement reserve.
    function fundReserve() external payable onlyOwner {
        if (msg.value == 0) revert ZeroAmount();
        reserve += msg.value;
    }

    /// @notice Owner only. Take test ETH back out of the reserve.
    function withdrawReserve(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > reserve) revert ReserveTooLarge();
        reserve -= amount;
        Address.sendValue(payable(msg.sender), amount);
    }

    /// @dev Only the pool may send plain ETH (the funds it lends). Everything else is rejected.
    receive() external payable {
        if (msg.sender != address(pool)) revert OnlyPool();
    }

    /// @dev Disabled: see RenounceDisabled.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMarginTrading
    function getPosition(uint256 id) external view override returns (Position memory) {
        return _positions[id];
    }

    /*//////////////////////////////////////////////////////////////
                               TRADER ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMarginTrading
    function openPosition(address market, Side side, uint256 leverageBps)
        external
        payable
        override
        nonReentrant
        whenNotPaused
        returns (uint256 id)
    {
        if (msg.value < ProtocolParams.MIN_COLLATERAL) revert BelowMinimumCollateral();

        uint256 borrowAmount =
            riskManager.validateOpen(market, msg.value, leverageBps, pool.maxBorrowable(), marketBorrowed[market]);
        uint256 entryPrice = riskManager.validPrice(market);

        id = nextPositionId++;
        marketBorrowed[market] += borrowAmount;
        _positions[id] = Position({
            owner: msg.sender,
            side: side,
            status: PositionStatus.Open,
            leverageBps: SafeCast.toUint32(leverageBps),
            openedAt: SafeCast.toUint40(block.timestamp),
            market: market,
            collateral: SafeCast.toUint128(msg.value),
            borrowed: SafeCast.toUint128(borrowAmount),
            entryPrice: SafeCast.toUint128(entryPrice)
        });
        emit PositionOpened(id, msg.sender, market, side, msg.value, borrowAmount, leverageBps, entryPrice);

        if (borrowAmount > 0) pool.borrow(borrowAmount);
    }

    /// @inheritdoc IMarginTrading
    function closePosition(uint256 id) external override nonReentrant whenNotPaused {
        Position storage p = _positions[id];
        if (p.status != PositionStatus.Open) revert PositionNotOpen();
        if (p.owner != msg.sender) revert NotPositionOwner();

        uint256 collateral = p.collateral;
        uint256 borrowed = p.borrowed;
        uint256 exitPrice = riskManager.validPrice(p.market);
        (uint256 profit, uint256 loss) = _pnl(p.side, p.entryPrice, exitPrice, collateral + borrowed);

        uint256 lpShare;
        uint256 payout;
        if (profit > 0) {
            if (profit > reserve) profit = reserve; // testnet: pay only what the reserve can back
            lpShare = pool.profitShare(profit);
            reserve -= profit;
            payout = collateral + profit - lpShare;
        } else {
            if (loss > collateral) loss = collateral; // the collateral absorbs the loss, never more
            reserve += loss;
            payout = collateral - loss;
        }

        p.status = PositionStatus.Closed;
        marketBorrowed[p.market] -= borrowed;
        emit PositionClosed(id, msg.sender, exitPrice, int256(profit) - int256(loss), lpShare, payout);

        if (borrowed > 0 || lpShare > 0) pool.repay{value: borrowed + lpShare}(borrowed, profit);
        if (payout > 0) Address.sendValue(payable(msg.sender), payout);
    }

    /// @inheritdoc IMarginTrading
    /// @dev Anyone may call, but only if RiskManager says the position is past its liquidation price at a fresh
    ///      oracle price. The position holds `size` ETH (collateral + borrowed); after the trader loss the
    ///      remaining value V is paid out pool-first: principal back to the pool, any shortfall written off through
    ///      `absorbLoss`, and whatever is left over added to the pool. The trader receives nothing. The loss part
    ///      (size - V) goes to the settlement reserve, exactly as on a normal losing close.
    function liquidate(uint256 id) external override nonReentrant whenNotPaused {
        Position storage p = _positions[id];
        if (p.status != PositionStatus.Open) revert PositionNotOpen();
        if (!riskManager.isLiquidatable(p)) revert NotLiquidatable();

        uint256 borrowed = p.borrowed;
        uint256 size = uint256(p.collateral) + borrowed;
        uint256 exitPrice = riskManager.validPrice(p.market);
        (, uint256 loss) = _pnl(p.side, p.entryPrice, exitPrice, size);

        uint256 value = loss >= size ? 0 : size - loss; // ETH still backing the position
        uint256 repayAmount = value < borrowed ? value : borrowed;
        uint256 shortfall = borrowed - repayAmount; // price gap: the pool eats this
        uint256 equity = value - repayAmount;

        p.status = PositionStatus.Liquidated;
        marketBorrowed[p.market] -= borrowed;
        reserve += size - value;
        emit PositionLiquidated(id, p.owner, msg.sender, exitPrice, equity, shortfall);

        if (repayAmount > 0) pool.repay{value: repayAmount}(repayAmount, 0);
        if (shortfall > 0) pool.absorbLoss(shortfall);
        if (equity > 0) {
            if (pool.totalShares() == 0) reserve += equity; // nobody to credit
            else pool.addEquity{value: equity}();
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 INTERNALS
    //////////////////////////////////////////////////////////////*/

    /// @dev Profit (rounded down) or loss (rounded up, so it never favors the trader) of a position of `size`.
    function _pnl(Side side, uint256 entry, uint256 exitPrice, uint256 size)
        private
        pure
        returns (uint256 profit, uint256 loss)
    {
        bool up = exitPrice >= entry;
        uint256 move = up ? exitPrice - entry : entry - exitPrice;
        bool gain = (side == Side.Long) == up;
        if (gain) profit = (size * move) / entry;
        else loss = (size * move + entry - 1) / entry;
    }
}
