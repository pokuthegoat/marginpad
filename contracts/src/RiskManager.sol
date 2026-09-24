// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IRiskManager} from "./interfaces/IRiskManager.sol";
import {ProtocolParams} from "./ProtocolParams.sol";
import {Position, PositionStatus, Side} from "./Types.sol";
import {
    InvalidRiskConfig,
    LeverageTooHigh,
    LeverageTooLow,
    MarketBorrowCapExceeded,
    MarketDisabled,
    NoPrice,
    OracleNotSet,
    StalePrice,
    PoolUtilizationCapExceeded,
    RenounceDisabled,
    ZeroAddress
} from "./Errors.sol";

/**
 * @title RiskManager
 * @notice Holds each market's risk settings and (from Phase 2/3) decides whether a position may be opened, and
 *         whether it can remain open or must be liquidated.
 *
 * PHASE 1 (this file): per-market config with validation, oracle pointer, admin.
 * PHASE 2 (this file): validateOpen.
 * PHASE 4 (this file): liquidationPrice, isLiquidatable, oracle staleness check.
 *
 * It holds no funds and moves none, so it can be upgraded by simply deploying a new one and pointing MarginTrading
 * at it in a later phase.
 */
contract RiskManager is IRiskManager, Ownable2Step {
    /// @inheritdoc IRiskManager
    IPriceOracle public override oracle;

    /// @inheritdoc IRiskManager
    uint256 public override maxPriceAge = 1 hours; // testnet default; older oracle prices are rejected

    mapping(address market => MarketRisk) private _marketRisk;

    constructor(address initialOwner, IPriceOracle initialOracle) Ownable(initialOwner) {
        // The oracle may be left unset (address(0)) at deployment and configured once its design is settled.
        oracle = initialOracle;
        if (address(initialOracle) != address(0)) emit OracleUpdated(address(initialOracle));
    }

    /*//////////////////////////////////////////////////////////////
                             CONFIG (implemented)
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IRiskManager
    function marketRisk(address market) external view override returns (MarketRisk memory) {
        return _marketRisk[market];
    }

    /// @inheritdoc IRiskManager
    /// @dev An enabled market must have leverage in [1x, 10x] and a maintenance margin that leaves a positive
    ///      liquidation buffer at its max leverage (`maintenance < 1 / maxLeverage`, the same rule the demo relies
    ///      on: without it a position would be liquidatable the moment it opened). A disabled market is stored as
    ///      given, so an owner can always switch a market off.
    function setMarketRisk(address market, MarketRisk calldata risk) external override onlyOwner {
        if (market == address(0)) revert ZeroAddress();
        if (risk.enabled) {
            if (risk.maxLeverageBps < ProtocolParams.MIN_LEVERAGE_BPS) revert InvalidRiskConfig();
            if (risk.maxLeverageBps > ProtocolParams.MAX_LEVERAGE_BPS) revert InvalidRiskConfig();
            if (risk.maintenanceBps == 0) revert InvalidRiskConfig();
            if (uint256(risk.maintenanceBps) * risk.maxLeverageBps >= ProtocolParams.BPS * ProtocolParams.BPS) {
                revert InvalidRiskConfig();
            }
        }
        _marketRisk[market] = risk;
        emit MarketRiskUpdated(market, risk.enabled, risk.maxLeverageBps, risk.maintenanceBps, risk.maxBorrow);
    }

    /// @inheritdoc IRiskManager
    function validPrice(address market) public view override returns (uint256 price) {
        if (address(oracle) == address(0)) revert OracleNotSet();
        uint256 updatedAt;
        (price, updatedAt) = oracle.getPrice(market);
        if (price == 0) revert NoPrice(market);
        if (block.timestamp > updatedAt + maxPriceAge) revert StalePrice(market, updatedAt);
    }

    /// @inheritdoc IRiskManager
    function setMaxPriceAge(uint256 newMaxAge) external override onlyOwner {
        if (newMaxAge == 0) revert InvalidRiskConfig();
        maxPriceAge = newMaxAge;
        emit MaxPriceAgeUpdated(newMaxAge);
    }

    /// @inheritdoc IRiskManager
    function setOracle(IPriceOracle newOracle) external override onlyOwner {
        oracle = newOracle;
        emit OracleUpdated(address(newOracle));
    }

    /// @dev Disabled: see RenounceDisabled.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /*//////////////////////////////////////////////////////////////
                        RULES (PLACEHOLDERS, LATER PHASES)
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IRiskManager
    /// @dev Checks, in order: market enabled; leverage within [1x, market max]; borrow within the market's remaining
    ///      cap; borrow within what the pool can lend under its 90% utilization cap.
    function validateOpen(
        address market,
        uint256 collateral,
        uint256 leverageBps,
        uint256 poolMaxBorrowable,
        uint256 marketBorrowed
    ) external view override returns (uint256 borrowAmount) {
        MarketRisk memory r = _marketRisk[market];
        if (!r.enabled) revert MarketDisabled(market);
        if (leverageBps < ProtocolParams.MIN_LEVERAGE_BPS) revert LeverageTooLow(leverageBps);
        if (leverageBps > r.maxLeverageBps) revert LeverageTooHigh(leverageBps, r.maxLeverageBps);

        borrowAmount = (collateral * (leverageBps - ProtocolParams.MIN_LEVERAGE_BPS)) / ProtocolParams.MIN_LEVERAGE_BPS;

        uint256 marketRoom = r.maxBorrow > marketBorrowed ? r.maxBorrow - marketBorrowed : 0;
        if (borrowAmount > marketRoom) revert MarketBorrowCapExceeded(borrowAmount, marketRoom);
        if (borrowAmount > poolMaxBorrowable) revert PoolUtilizationCapExceeded(borrowAmount, poolMaxBorrowable);
    }

    /// @inheritdoc IRiskManager
    /// @dev buffer = 1/leverage - maintenance (in bps of position size). Long liquidates at entry * (1 - buffer),
    ///      short at entry * (1 + buffer). If the market maintenance was raised after the position opened so that
    ///      the buffer is gone, the position is liquidatable at its entry price.
    function liquidationPrice(address market, Side side, uint256 leverageBps, uint256 entryPrice)
        public
        view
        override
        returns (uint256)
    {
        if (leverageBps < ProtocolParams.MIN_LEVERAGE_BPS) revert LeverageTooLow(leverageBps);
        uint256 invLeverage = (ProtocolParams.BPS * ProtocolParams.BPS) / leverageBps;
        uint256 maintenance = _marketRisk[market].maintenanceBps;
        uint256 buffer = invLeverage > maintenance ? invLeverage - maintenance : 0;
        return side == Side.Long
            ? (entryPrice * (ProtocolParams.BPS - buffer)) / ProtocolParams.BPS
            : (entryPrice * (ProtocolParams.BPS + buffer)) / ProtocolParams.BPS;
    }

    /// @inheritdoc IRiskManager
    /// @dev Reverts (rather than answering) if the oracle price is missing or stale.
    function isLiquidatable(Position calldata position) external view override returns (bool) {
        if (position.status != PositionStatus.Open) return false;
        uint256 price = validPrice(position.market);
        uint256 liqPrice = liquidationPrice(position.market, position.side, position.leverageBps, position.entryPrice);
        return position.side == Side.Long ? price <= liqPrice : price >= liqPrice;
    }
}
