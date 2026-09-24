// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ProtocolParams
 * @notice The protocol's fixed numbers. They mirror the demo app's rules (src/store/store.ts) so the on-chain
 *         behaviour matches what users have already seen.
 * @dev Anything a market may tune (its max leverage, maintenance margin, borrow cap) is NOT here: it lives in
 *      RiskManager per market. These are the global ceilings and shares.
 */
library ProtocolParams {
    /// @dev Basis-point denominator: 10_000 = 100% (and, for leverage, 1x).
    uint256 internal constant BPS = 10_000;

    /// @dev New borrowing and withdrawals may not push pool utilization above this. Demo: MAX_UTILIZATION = 0.9.
    uint256 internal constant MAX_UTILIZATION_BPS = 9_000;

    /// @dev Share of a position's realized profit routed to liquidity providers. Demo: LP_PROFIT_SHARE = 0.05.
    uint256 internal constant LP_PROFIT_SHARE_BPS = 500;

    /// @dev Leverage bounds, in basis points (1x = 10_000). The 10x ceiling is the product's hard limit.
    uint256 internal constant MIN_LEVERAGE_BPS = 10_000;
    uint256 internal constant MAX_LEVERAGE_BPS = 100_000;

    /// @dev Smallest collateral a trader may post, and the smallest LP deposit. Demo: 0.01 ETH each.
    uint256 internal constant MIN_COLLATERAL = 0.01 ether;
    uint256 internal constant MIN_DEPOSIT = 0.01 ether;
}
