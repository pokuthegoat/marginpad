// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Position, Side} from "../Types.sol";
import {IPriceOracle} from "./IPriceOracle.sol";

/**
 * @title IRiskManager
 * @notice Decides how much leverage each market supports and whether a position may stay open.
 *
 * The frontend demo derives these numbers from market cap, liquidity, volume and volatility. On chain, that policy
 * is expressed as a small per-market config the owner sets (`MarketRisk`) plus the rules below.
 *
 * Rules (implemented in Phase 2/3), mirroring the demo in src/store/market.ts:
 *   - a position is opened only if the market is enabled, leverage is within [1x, market max], the borrow fits the
 *     market's borrow cap, and the pool has room under its utilization cap;
 *   - liquidation price:  long  = entry * (1 - (1/leverage - maintenance))
 *                         short = entry * (1 + (1/leverage - maintenance));
 *   - a position is liquidatable once its price crosses that level, before the borrowed ETH is at risk.
 */
interface IRiskManager {
    /**
     * @notice Risk settings for one market.
     * @param enabled Whether new positions may be opened on this market.
     * @param maxLeverageBps Highest leverage allowed (10_000 = 1x, 100_000 = 10x).
     * @param maintenanceBps Maintenance margin, as basis points of position size. Must leave a positive liquidation
     *        buffer: `maintenanceBps * maxLeverageBps < 10_000 * 10_000`.
     * @param maxBorrow Most ETH (wei) this market may have borrowed from the pool at once.
     */
    struct MarketRisk {
        bool enabled;
        uint32 maxLeverageBps;
        uint16 maintenanceBps;
        uint128 maxBorrow;
    }

    event MarketRiskUpdated(
        address indexed market, bool enabled, uint32 maxLeverageBps, uint16 maintenanceBps, uint128 maxBorrow
    );
    event OracleUpdated(address indexed oracle);
    event MaxPriceAgeUpdated(uint256 maxAge);

    /*//////////////////////////////////////////////////////////////
                         CONFIG (implemented)
    //////////////////////////////////////////////////////////////*/

    /// @notice The price source used for entry prices, profit and loss, and liquidation checks.
    function oracle() external view returns (IPriceOracle);

    /// @notice A market's risk settings. All zero (disabled) for a market that was never configured.
    function marketRisk(address market) external view returns (MarketRisk memory);

    /// @notice Owner only. Set or replace a market's risk settings. Reverts with `InvalidRiskConfig` if inconsistent.
    function setMarketRisk(address market, MarketRisk calldata risk) external;

    /// @notice Oldest oracle price (in seconds) the protocol will act on.
    function maxPriceAge() external view returns (uint256);

    /// @notice The current oracle price for `market`. Reverts if there is no oracle, no price, or the price is stale.
    function validPrice(address market) external view returns (uint256);

    /// @notice Whether the market price source is gone (graduated). No new positions; the price is a frozen final value.
    function isGraduated(address market) external view returns (bool);

    /// @notice Owner only. Set how old an oracle price may be (10 seconds to 7 days).
    function setMaxPriceAge(uint256 newMaxAge) external;

    /// @notice Owner only. Point the manager at a price source. `address(0)` means "not set yet".
    function setOracle(IPriceOracle newOracle) external;

    /*//////////////////////////////////////////////////////////////
                           RULES (PHASE 2 / 3)
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Check a new position and return how much ETH it must borrow from the pool.
     * @param market The token being traded.
     * @param collateral The trader's ETH.
     * @param leverageBps Requested leverage.
     * @param poolMaxBorrowable What the pool can lend right now (`IMarginPool.maxBorrowable()`).
     * @param marketBorrowed What this market has already borrowed.
     * @return borrowAmount `collateral * (leverageBps - 1x) / 1x`. Reverts if any rule is broken.
     */
    function validateOpen(
        address market,
        uint256 collateral,
        uint256 leverageBps,
        uint256 poolMaxBorrowable,
        uint256 marketBorrowed
    ) external view returns (uint256 borrowAmount);

    /// @notice The price at which a position with these terms becomes liquidatable.
    function liquidationPrice(address market, Side side, uint256 leverageBps, uint256 entryPrice)
        external
        view
        returns (uint256);

    /// @notice Whether an open position can be liquidated right now (reverts on a missing or stale price).
    function isLiquidatable(Position calldata position) external view returns (bool);
}
