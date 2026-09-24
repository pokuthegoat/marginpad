// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {InvalidRiskConfig, NoPrice, NotUpdater, PriceFrozen, RenounceDisabled, ZeroAddress, ZeroPrice} from "../Errors.sol";

/**
 * @title OwnerPriceOracle
 * @notice A CENTRALIZED, keeper-updated price feed. It is a single trusted party: whoever controls the `updater` key
 *         controls prices and can drain the pool until the price-move guard stops them. It is NOT a decentralized
 *         oracle. Use it only with a small pool you can afford to lose, until it is replaced by a real feed that
 *         implements `IPriceOracle` (then call `RiskManager.setOracle`).
 *
 * Roles
 *  - owner (admin, ideally a multisig): rotates the updater, sets the move limit, pauses.
 *  - updater (keeper hot key): the only account that may push prices or mark a market graduated. It defaults to the
 *    owner at deployment, so rotate it to a dedicated keeper key.
 *
 * Protections
 *  - Per-update move limit (`maxMoveBps`): an update that moves a price more than that fraction away from the current
 *    price is REJECTED (price unchanged, `PriceRejected` emitted, `false` returned). The keeper then steps toward the
 *    target with further updates, so a single manipulated read can never move the price far in one step.
 *  - Pause: while paused no update is accepted and `getPrice` reports no price, so everything that needs a price
 *    (open, close, liquidate) halts.
 *  - Freshness: `getPrice` returns the update time; the consumer (RiskManager) rejects prices older than its max age.
 *  - Graduation: a market whose price source has become invalid (a Pons token graduating off its bonding curve) is
 *    marked graduated. Its price is then frozen at the final value, no more updates are accepted, and RiskManager
 *    refuses new positions on it and treats the frozen value only as a one-time settlement price.
 *
 * Prices are wei per one whole token (1e18-scaled).
 */
contract OwnerPriceOracle is IPriceOracle, Ownable2Step, Pausable {
    struct Price {
        uint128 price;
        uint40 updatedAt;
        bool graduated;
    }

    /// @dev Largest allowed value for the move limit: 1000x. Lower is safer.
    uint256 public constant MAX_MOVE_BPS_CEILING = 10_000_000;
    uint256 private constant BPS = 10_000;

    /// @notice Account allowed to push prices and mark markets graduated.
    address public updater;

    /// @notice Largest allowed change of a price in one update, in basis points of the current price (2_000 = 20%).
    uint256 public maxMoveBps = 2_000;

    mapping(address market => Price) private _prices;

    event PriceUpdated(address indexed market, uint256 price);
    /// @param reason 1 = move larger than `maxMoveBps`.
    event PriceRejected(address indexed market, uint256 attemptedPrice, uint256 currentPrice, uint8 reason);
    event UpdaterChanged(address indexed previousUpdater, address indexed newUpdater);
    event MaxMoveChanged(uint256 maxMoveBps);
    event MarketGraduated(address indexed market, uint256 finalPrice);

    modifier onlyUpdater() {
        if (msg.sender != updater) revert NotUpdater();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {
        updater = initialOwner;
        emit UpdaterChanged(address(0), initialOwner);
    }

    /*//////////////////////////////////////////////////////////////
                                  ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Owner only. Rotate the keeper account.
    function setUpdater(address newUpdater) external onlyOwner {
        if (newUpdater == address(0)) revert ZeroAddress();
        emit UpdaterChanged(updater, newUpdater);
        updater = newUpdater;
    }

    /// @notice Owner only. Set the per-update move limit (100 = 1%).
    function setMaxMoveBps(uint256 newMaxMoveBps) external onlyOwner {
        if (newMaxMoveBps == 0 || newMaxMoveBps > MAX_MOVE_BPS_CEILING) revert InvalidRiskConfig();
        maxMoveBps = newMaxMoveBps;
        emit MaxMoveChanged(newMaxMoveBps);
    }

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
                                UPDATER
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Updater only. Set the price of `market`.
     * @return accepted false if the update was rejected for moving the price too far (the price is unchanged and
     *         `PriceRejected` is emitted). Everything else that is wrong reverts.
     * @dev The first price of a market has nothing to compare against and is always accepted.
     */
    function setPrice(address market, uint128 price) external onlyUpdater whenNotPaused returns (bool accepted) {
        if (market == address(0)) revert ZeroAddress();
        if (price == 0) revert ZeroPrice();
        Price memory current = _prices[market];
        if (current.graduated) revert PriceFrozen(market);

        if (current.price != 0) {
            uint256 diff = price > current.price ? price - current.price : current.price - price;
            if (diff * BPS > uint256(current.price) * maxMoveBps) {
                emit PriceRejected(market, price, current.price, 1);
                return false;
            }
        }

        // forge-lint: disable-next-line(unsafe-typecast)
        _prices[market] = Price(price, uint40(block.timestamp), false);
        emit PriceUpdated(market, price);
        return true;
    }

    /**
     * @notice Updater only. Declare that `market` no longer has a valid price source (its Pons curve graduated).
     *         The last price becomes the frozen final price. Irreversible.
     */
    function markGraduated(address market) external onlyUpdater whenNotPaused {
        Price storage p = _prices[market];
        if (p.price == 0) revert NoPrice(market);
        p.graduated = true;
        emit MarketGraduated(market, p.price);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IPriceOracle
    /// @dev Returns (0, 0) for a market that never had a price, and for every market while paused. Callers must treat
    ///      that as "no price".
    function getPrice(address market) external view override returns (uint256, uint256) {
        if (paused()) return (0, 0);
        Price memory p = _prices[market];
        return (p.price, p.updatedAt);
    }

    /// @notice Whether the market was marked graduated (its price is frozen at the final value).
    function graduated(address market) external view returns (bool) {
        return _prices[market].graduated;
    }
}
