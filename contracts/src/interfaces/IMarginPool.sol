// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IMarginPool
 * @notice The shared pool of ETH that liquidity providers (LPs) supply and traders borrow against.
 *
 * Money flow (implemented in Phase 2):
 *   LP        --deposit()-->        pool            LPs receive pool shares
 *   pool      --borrow()-->         MarginTrading   only the MarginTrading contract may borrow
 *   trading   --repay()-->          pool            principal back, plus 5% of any realized profit as an LP reward
 *   trading   --absorbLoss()-->     pool            if a price gap loses more than the collateral covered
 *   LP        --withdraw()/claimRewards()-->  LP    withdrawals may not push utilization above the 90% cap
 *
 * Accounting: LP shares are proportional claims on `totalDeposits` (the pool's assets, lent out or not). Losses lower
 * `totalDeposits`, so every LP absorbs them pro rata. The 5% profit share accrues per share as separate, claimable
 * rewards, so it is split proportionally and never dilutes a later depositor. All accounting is internal (never
 * `address(this).balance`), so ETH forced into the contract cannot distort share prices.
 */
interface IMarginPool {
    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice An LP supplied ETH and received `shares`.
    event Deposited(address indexed lp, uint256 amount, uint256 shares);

    /// @notice An LP burned `shares` and received `amount` ETH.
    event Withdrawn(address indexed lp, uint256 amount, uint256 shares);

    /// @notice MarginTrading drew `amount` ETH from the pool to fund a position.
    event Borrowed(uint256 amount);

    /// @notice MarginTrading returned `principal` and paid `lpReward` (the 5% profit share) for the LPs.
    event Repaid(uint256 principal, uint256 lpReward);

    /// @notice A position lost more than its collateral; LPs absorbed `amount`.
    event LossAbsorbed(uint256 amount);

    /// @notice An LP took their accrued profit-share rewards.
    event RewardsClaimed(address indexed lp, uint256 amount);

    /// @notice Leftover equity from a liquidated position was added to the pool (raises every LP share value).
    event EquityAdded(uint256 amount);

    /// @notice The MarginTrading contract was wired to the pool (once, at deployment).
    event MarginTradingSet(address indexed marginTrading);

    /*//////////////////////////////////////////////////////////////
                              VIEWS (implemented)
    //////////////////////////////////////////////////////////////*/

    /// @notice The only address allowed to borrow, repay and absorb losses.
    function marginTrading() external view returns (address);

    /// @notice All ETH LPs have supplied (lent out or not).
    function totalDeposits() external view returns (uint256);

    /// @notice ETH currently lent out to open positions.
    function totalBorrowed() external view returns (uint256);

    /// @notice Total LP shares in existence.
    function totalShares() external view returns (uint256);

    /// @notice An LP's share balance.
    function sharesOf(address lp) external view returns (uint256);

    /// @notice ETH set aside for LP rewards that have not been claimed yet.
    function rewardReserve() external view returns (uint256);

    /// @notice What an LP's shares are worth in ETH right now (rounded down).
    function assetsOf(address lp) external view returns (uint256);

    /// @notice An LP's unclaimed profit-share rewards.
    function pendingRewardsOf(address lp) external view returns (uint256);

    /// @notice The most this LP could withdraw right now: their assets, the un-lent ETH, and the 90% cap all apply.
    function maxWithdrawable(address lp) external view returns (uint256);

    /// @notice The LP share (5%) of a realized profit, rounded down.
    function profitShare(uint256 profit) external pure returns (uint256);

    /// @notice ETH not currently lent out (`totalDeposits - totalBorrowed`, never negative).
    function availableLiquidity() external view returns (uint256);

    /// @notice `totalBorrowed / totalDeposits` in basis points (0 when the pool is empty).
    function utilizationBps() external view returns (uint256);

    /// @notice The most that could be borrowed right now without breaking the 90% utilization cap.
    function maxBorrowable() external view returns (uint256);

    /*//////////////////////////////////////////////////////////////
                          LP ACTIONS (PHASE 2)
    //////////////////////////////////////////////////////////////*/

    /// @notice Supply `msg.value` ETH (at least 0.01) and receive proportional shares.
    function deposit() external payable;

    /// @notice Take out `amount` ETH, burning the shares it is worth. Only un-lent ETH can leave, and never so much
    ///         that utilization would exceed 90%.
    function withdraw(uint256 amount) external;

    /// @notice Take the caller's accrued profit-share rewards.
    function claimRewards() external;

    /*//////////////////////////////////////////////////////////////
                   MARGINTRADING-ONLY ACTIONS (PHASE 2)
    //////////////////////////////////////////////////////////////*/

    /// @notice MarginTrading only. Send `amount` ETH to MarginTrading to fund a position. Reverts above the 90% cap.
    function borrow(uint256 amount) external;

    /// @notice MarginTrading only. Return `principal` and pay the LP share of `realizedProfit`.
    /// @dev `msg.value` must equal `principal + profitShare(realizedProfit)` exactly; the pool computes the 5% itself.
    function repay(uint256 principal, uint256 realizedProfit) external payable;

    /// @notice MarginTrading only. Write off `amount` of lent-out principal that will not come back. All LPs absorb it
    ///         pro rata through a lower share price.
    function absorbLoss(uint256 amount) external;

    /// @notice MarginTrading only. Add `msg.value` (liquidation leftovers) to the pool assets, shared pro rata.
    function addEquity() external payable;
}
