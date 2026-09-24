// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMarginPool} from "./interfaces/IMarginPool.sol";
import {ProtocolParams} from "./ProtocolParams.sol";
import {
    BelowMinimumDeposit,
    ExceedsUtilizationCap,
    InsufficientLiquidity,
    InsufficientShares,
    InvalidRepayment,
    LossExceedsBorrowed,
    MarginTradingAlreadySet,
    NoShares,
    NotMarginTrading,
    NothingToClaim,
    PoolWiped,
    RenounceDisabled,
    RepayExceedsBorrowed,
    ZeroAddress,
    ZeroAmount
} from "./Errors.sol";

/**
 * @title MarginPool
 * @notice The shared ETH pool. LPs supply ETH; the MarginTrading contract borrows it to fund leveraged positions.
 *
 * Accounting (all internal, never `address(this).balance`, so force-sent ETH cannot skew share prices):
 *  - `totalDeposits` is what LPs collectively own (lent out or not). Shares are proportional claims on it.
 *  - A loss lowers `totalDeposits` and `totalBorrowed` together, so every LP absorbs it pro rata.
 *  - The 5% profit share is NOT added to deposits: it accrues per share (`accRewardPerShare`) and is claimed
 *    separately, so a later depositor never receives profit earned before they joined.
 *  - Balance identity: address(this).balance >= totalDeposits - totalBorrowed + rewardReserve.
 *  - Only un-lent ETH can be withdrawn, and never so much that utilization would exceed 90%.
 *  - No receive()/fallback(): ETH only enters through deposit() and repay().
 *
 * TESTNET ONLY. Not audited.
 */
contract MarginPool is IMarginPool, Ownable2Step, Pausable, ReentrancyGuard {
    uint256 private constant PRECISION = 1e27;

    /// @inheritdoc IMarginPool
    address public override marginTrading;

    /// @inheritdoc IMarginPool
    uint256 public override totalDeposits;

    /// @inheritdoc IMarginPool
    uint256 public override totalBorrowed;

    /// @inheritdoc IMarginPool
    uint256 public override totalShares;

    /// @inheritdoc IMarginPool
    mapping(address => uint256) public override sharesOf;

    /// @inheritdoc IMarginPool
    uint256 public override rewardReserve;

    /// @notice Cumulative profit-share rewards per share, scaled by 1e27.
    uint256 public accRewardPerShare;

    mapping(address => uint256) private _rewardDebt;
    mapping(address => uint256) private _settledRewards;

    modifier onlyMarginTrading() {
        if (msg.sender != marginTrading) revert NotMarginTrading();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    /*//////////////////////////////////////////////////////////////
                                  ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Wire the MarginTrading contract that may borrow from this pool. Owner only, and only once.
    function setMarginTrading(address trading) external onlyOwner {
        if (trading == address(0)) revert ZeroAddress();
        if (marginTrading != address(0)) revert MarginTradingAlreadySet();
        marginTrading = trading;
        emit MarginTradingSet(trading);
    }

    /// @notice Emergency stop for every state-changing entry point.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Disabled: see RenounceDisabled.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMarginPool
    function availableLiquidity() public view override returns (uint256) {
        uint256 deposits = totalDeposits;
        uint256 borrowed = totalBorrowed;
        return deposits > borrowed ? deposits - borrowed : 0;
    }

    /// @inheritdoc IMarginPool
    function utilizationBps() public view override returns (uint256) {
        uint256 deposits = totalDeposits;
        if (deposits == 0) return 0;
        return (totalBorrowed * ProtocolParams.BPS) / deposits;
    }

    /// @inheritdoc IMarginPool
    function maxBorrowable() public view override returns (uint256) {
        uint256 cap = (totalDeposits * ProtocolParams.MAX_UTILIZATION_BPS) / ProtocolParams.BPS;
        uint256 borrowed = totalBorrowed;
        return cap > borrowed ? cap - borrowed : 0;
    }

    /// @inheritdoc IMarginPool
    function assetsOf(address lp) public view override returns (uint256) {
        uint256 supply = totalShares;
        return supply == 0 ? 0 : (sharesOf[lp] * totalDeposits) / supply;
    }

    /// @inheritdoc IMarginPool
    function pendingRewardsOf(address lp) public view override returns (uint256) {
        return _settledRewards[lp] + (sharesOf[lp] * accRewardPerShare) / PRECISION - _rewardDebt[lp];
    }

    /// @inheritdoc IMarginPool
    function maxWithdrawable(address lp) external view override returns (uint256) {
        uint256 deposits = totalDeposits;
        // Smallest deposits that keep utilization at or under the cap (rounded up).
        uint256 minDeposits = _ceilDiv(totalBorrowed * ProtocolParams.BPS, ProtocolParams.MAX_UTILIZATION_BPS);
        uint256 capRoom = deposits > minDeposits ? deposits - minDeposits : 0;
        return _min(_min(assetsOf(lp), availableLiquidity()), capRoom);
    }

    /// @inheritdoc IMarginPool
    function profitShare(uint256 profit) public pure override returns (uint256) {
        return (profit * ProtocolParams.LP_PROFIT_SHARE_BPS) / ProtocolParams.BPS;
    }

    /*//////////////////////////////////////////////////////////////
                                LP ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMarginPool
    function deposit() external payable override nonReentrant whenNotPaused {
        if (msg.value < ProtocolParams.MIN_DEPOSIT) revert BelowMinimumDeposit();
        uint256 supply = totalShares;
        uint256 deposits = totalDeposits;
        uint256 shares;
        if (supply == 0) {
            shares = msg.value;
        } else {
            if (deposits == 0) revert PoolWiped();
            shares = (msg.value * supply) / deposits;
            if (shares == 0) revert ZeroAmount();
        }

        _settle(msg.sender);
        totalDeposits = deposits + msg.value;
        totalShares = supply + shares;
        sharesOf[msg.sender] += shares;
        _resetDebt(msg.sender);

        emit Deposited(msg.sender, msg.value, shares);
    }

    /// @inheritdoc IMarginPool
    function withdraw(uint256 amount) external override nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 deposits = totalDeposits;
        uint256 supply = totalShares;
        if (amount > availableLiquidity()) revert InsufficientLiquidity();
        // Burn rounds up so a withdrawal never takes more value than the shares it burns.
        uint256 shares = _ceilDiv(amount * supply, deposits);
        if (shares > sharesOf[msg.sender]) revert InsufficientShares();
        // The pool that remains must still respect the utilization cap.
        if (totalBorrowed * ProtocolParams.BPS > (deposits - amount) * ProtocolParams.MAX_UTILIZATION_BPS) {
            revert ExceedsUtilizationCap();
        }

        _settle(msg.sender);
        totalDeposits = deposits - amount;
        totalShares = supply - shares;
        sharesOf[msg.sender] -= shares;
        _resetDebt(msg.sender);

        emit Withdrawn(msg.sender, amount, shares);
        Address.sendValue(payable(msg.sender), amount);
    }

    /// @inheritdoc IMarginPool
    function claimRewards() external override nonReentrant whenNotPaused {
        _settle(msg.sender);
        uint256 amount = _settledRewards[msg.sender];
        if (amount == 0) revert NothingToClaim();
        _settledRewards[msg.sender] = 0;
        // Per-LP rounding can overshoot the reserve by a few wei in total; never let that block the last claimer.
        uint256 reserve = rewardReserve;
        if (amount > reserve) amount = reserve;
        rewardReserve = reserve - amount;

        emit RewardsClaimed(msg.sender, amount);
        Address.sendValue(payable(msg.sender), amount);
    }

    /*//////////////////////////////////////////////////////////////
                        MARGINTRADING-ONLY ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMarginPool
    function borrow(uint256 amount) external override nonReentrant onlyMarginTrading whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (amount > maxBorrowable()) revert ExceedsUtilizationCap();
        totalBorrowed += amount;

        emit Borrowed(amount);
        Address.sendValue(payable(msg.sender), amount);
    }

    /// @inheritdoc IMarginPool
    function repay(uint256 principal, uint256 realizedProfit)
        external
        payable
        override
        nonReentrant
        onlyMarginTrading
        whenNotPaused
    {
        if (principal > totalBorrowed) revert RepayExceedsBorrowed();
        uint256 reward = profitShare(realizedProfit);
        if (msg.value != principal + reward) revert InvalidRepayment();

        totalBorrowed -= principal;
        if (reward > 0) {
            uint256 supply = totalShares;
            if (supply == 0) revert NoShares();
            accRewardPerShare += (reward * PRECISION) / supply;
            rewardReserve += reward;
        }

        emit Repaid(principal, reward);
    }

    /// @inheritdoc IMarginPool
    function absorbLoss(uint256 amount) external override nonReentrant onlyMarginTrading whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (amount > totalBorrowed) revert LossExceedsBorrowed();
        totalBorrowed -= amount;
        totalDeposits -= amount;

        emit LossAbsorbed(amount);
    }

    /// @inheritdoc IMarginPool
    function addEquity() external payable override nonReentrant onlyMarginTrading whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        if (totalShares == 0) revert NoShares();
        totalDeposits += msg.value;
        emit EquityAdded(msg.value);
    }

    /*//////////////////////////////////////////////////////////////
                                 INTERNALS
    //////////////////////////////////////////////////////////////*/

    /// @dev Bank an LP's accrued rewards. Call before their share balance changes.
    function _settle(address lp) private {
        _settledRewards[lp] = pendingRewardsOf(lp);
        _resetDebt(lp);
    }

    /// @dev Also call after their share balance changes.
    function _resetDebt(address lp) private {
        _rewardDebt[lp] = (sharesOf[lp] * accRewardPerShare) / PRECISION;
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
