// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Position, Side} from "../Types.sol";
import {IMarginPool} from "./IMarginPool.sol";
import {IRiskManager} from "./IRiskManager.sol";

/**
 * @title IMarginTrading
 * @notice Opens and closes leveraged positions using the trader's collateral plus ETH borrowed from the MarginPool.
 *
 * Lifecycle (implemented in Phase 2/3):
 *   openPosition:  trader sends collateral as msg.value -> RiskManager.validateOpen() says how much to borrow ->
 *                  pool.borrow() -> position stored with the current oracle price as its entry price.
 *   closePosition: settle at the current price. Profit: 5% goes to LPs, the rest to the trader. Loss: the trader's
 *                  collateral absorbs it first. The borrowed ETH always goes back to the pool.
 *   liquidate:     anyone may close a position RiskManager says is liquidatable, before the pool's ETH is at risk.
 *
 * `liquidate` closes positions past their liquidation price, pool first.
 */
interface IMarginTrading {
    event PositionOpened(
        uint256 indexed id,
        address indexed owner,
        address indexed market,
        Side side,
        uint256 collateral,
        uint256 borrowed,
        uint256 leverageBps,
        uint256 entryPrice
    );

    /// @param pnl Profit (positive) or loss (negative) in wei, before the LP share.
    /// @param lpShare The part of a profit sent to LPs (5%).
    /// @param payout ETH paid to the trader.
    event PositionClosed(
        uint256 indexed id, address indexed owner, uint256 exitPrice, int256 pnl, uint256 lpShare, uint256 payout
    );

    /// @param toPool Leftover equity sent to the pool after repaying the borrowed ETH.
    /// @param poolLoss Loss the pool absorbed if a price gap went through the collateral.
    event PositionLiquidated(
        uint256 indexed id,
        address indexed owner,
        address indexed liquidator,
        uint256 exitPrice,
        uint256 toPool,
        uint256 poolLoss
    );

    /*//////////////////////////////////////////////////////////////
                         VIEWS (implemented)
    //////////////////////////////////////////////////////////////*/

    function pool() external view returns (IMarginPool);

    function riskManager() external view returns (IRiskManager);

    /// @notice The id the next opened position will get. Ids start at 1; 0 means "no position".
    function nextPositionId() external view returns (uint256);

    /// @notice ETH a market currently has borrowed from the pool (checked against its borrow cap).
    function marketBorrowed(address market) external view returns (uint256);

    /// @notice A position by id. An unknown id returns an empty position with `PositionStatus.None`.
    function getPosition(uint256 id) external view returns (Position memory);

    /*//////////////////////////////////////////////////////////////
                    TRADER / KEEPER ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Open a position on `market`. `msg.value` is the trader's collateral.
    /// @return id The new position's id.
    function openPosition(address market, Side side, uint256 leverageBps) external payable returns (uint256 id);

    /// @notice Close the caller's own position at the current price.
    function closePosition(uint256 id) external;

    /// @notice PHASE 4. Close a position that RiskManager says is liquidatable. Anyone may call.
    function liquidate(uint256 id) external;
}
