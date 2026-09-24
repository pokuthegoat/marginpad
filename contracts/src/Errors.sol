// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Shared custom errors (cheaper than revert strings, and easy to match in tests and the frontend).

error ZeroAddress();

/// @dev Only the configured MarginTrading contract may call this on the pool.
error NotMarginTrading();

/// @dev The pool's MarginTrading address can be set once. Redeploy the pool to change it.
error MarginTradingAlreadySet();

/// @dev A market's risk settings are inconsistent (see RiskManager.setMarketRisk).
error InvalidRiskConfig();

/// @dev Ownership can be handed over (two steps) but never abandoned: a renounced owner could no longer pause.
error RenounceDisabled();

/*//////////////////////////////////////////////////////////////
                          MarginPool
//////////////////////////////////////////////////////////////*/

error ZeroAmount();
error BelowMinimumDeposit();
/// @dev The action would push pool utilization above the 90% cap.
error ExceedsUtilizationCap();
/// @dev More ETH asked for than is currently un-lent.
error InsufficientLiquidity();
error InsufficientShares();
error NothingToClaim();
/// @dev `msg.value` did not equal `principal + the 5% LP share of the profit`.
error InvalidRepayment();
error RepayExceedsBorrowed();
error LossExceedsBorrowed();
/// @dev Rewards arrived but no LP holds shares to receive them.
error NoShares();
error ZeroPrice();
/// @dev Every LP asset was written off while shares remain. A fresh pool must be deployed.
error PoolWiped();

/*//////////////////////////////////////////////////////////////
                        RiskManager.validateOpen
//////////////////////////////////////////////////////////////*/

error MarketDisabled(address market);
error LeverageTooLow(uint256 requested);
error LeverageTooHigh(uint256 requested, uint256 max);
error MarketBorrowCapExceeded(uint256 wanted, uint256 room);
error PoolUtilizationCapExceeded(uint256 wanted, uint256 room);

/*//////////////////////////////////////////////////////////////
                          MarginTrading
//////////////////////////////////////////////////////////////*/

/// @dev MarginTrading only accepts plain ETH from its pool (the funds it lends).
error OnlyPool();
error BelowMinimumCollateral();
error OracleNotSet();
/// @dev The oracle has no price for this market.
error NoPrice(address market);
error NotPositionOwner();
error PositionNotOpen();
error ReserveTooLarge();

/*//////////////////////////////////////////////////////////////
                          Liquidation
//////////////////////////////////////////////////////////////*/

/// @dev The oracle price is older than the allowed maximum age.
error StalePrice(address market, uint256 updatedAt);
error NotLiquidatable();
