// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {RenounceDisabled, ZeroAddress, ZeroPrice} from "../Errors.sol";

/**
 * @title OwnerPriceOracle
 * @notice CENTRALIZED TESTNET ORACLE. A single owner account pushes prices by hand. Whoever holds that key controls
 *         every price, and so could drain the pool. That is acceptable ONLY on a testnet with worthless ETH.
 *         Before any real funds: replace it with a decentralized feed (Chainlink or similar) that implements
 *         `IPriceOracle`, then call `RiskManager.setOracle`. Nothing else has to change.
 *
 * Prices are wei per one whole token (1e18-scaled). `updatedAt` is the block timestamp of the push, so consumers
 * can reject stale prices.
 */
contract OwnerPriceOracle is IPriceOracle, Ownable2Step {
    struct Price {
        uint128 price;
        uint40 updatedAt;
    }

    mapping(address market => Price) private _prices;

    event PriceUpdated(address indexed market, uint256 price);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Owner only. Set the price of `market`.
    function setPrice(address market, uint128 price) external onlyOwner {
        if (market == address(0)) revert ZeroAddress();
        if (price == 0) revert ZeroPrice();
        // forge-lint: disable-next-line(unsafe-typecast)
        _prices[market] = Price(price, uint40(block.timestamp));
        emit PriceUpdated(market, price);
    }

    /// @inheritdoc IPriceOracle
    /// @dev Returns (0, 0) for a market that never had a price; callers must treat that as unusable.
    function getPrice(address market) external view override returns (uint256, uint256) {
        Price memory p = _prices[market];
        return (p.price, p.updatedAt);
    }

    /// @dev Disabled: see RenounceDisabled.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}
