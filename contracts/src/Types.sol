// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Direction of a leveraged position.
enum Side {
    Long,
    Short
}

/// @notice Lifecycle of a position. `None` is the zero value, so an unknown id reads as "no position".
enum PositionStatus {
    None,
    Open,
    Closed,
    Liquidated
}

/**
 * @notice One leveraged position.
 * @dev Amounts are in wei (native ETH). Leverage is in basis points where 10_000 = 1x, so 1.5x = 15_000 and the
 *      10x protocol ceiling = 100_000. Position size is `collateral + borrowed`.
 *
 *      `entryPrice` is the oracle price (wei per whole token, 1e18-scaled) when the position was opened. Profit and
 *      loss are the ratio of the current price to it, so only the ratio matters, not the unit.
 *
 *      Timing uses `block.timestamp`. On Robinhood Chain (an Arbitrum chain) `block.number` is only an estimate of the
 *      Ethereum block number, so it must never be used to measure time.
 */
struct Position {
    address owner; // the trader
    Side side;
    PositionStatus status;
    uint32 leverageBps;
    uint40 openedAt; // block.timestamp
    address market; // the token being traded (a token launched through Pons, in a later phase)
    uint128 collateral; // the trader's own ETH
    uint128 borrowed; // ETH drawn from the pool
    uint128 entryPrice;
}
