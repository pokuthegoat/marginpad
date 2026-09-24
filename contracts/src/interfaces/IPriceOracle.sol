// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IPriceOracle
 * @notice Where a market's price comes from. PLACEHOLDER interface: the real source (and its safety checks) is a
 *         Phase 2+ decision, because a manipulable price would let someone drain the pool.
 */
interface IPriceOracle {
    /// @notice The price of one whole `market` token in wei (1e18-scaled), and when it was last updated.
    /// @dev Callers must treat a stale `updatedAt` as unusable (see RiskManager, later phase).
    function getPrice(address market) external view returns (uint256 price, uint256 updatedAt);
}
