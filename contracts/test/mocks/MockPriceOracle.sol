// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";

/// @notice TEST ONLY. A price feed the test sets by hand. Not a design for the real oracle.
contract MockPriceOracle is IPriceOracle {
    mapping(address market => uint256) public price;
    mapping(address market => uint256) public updatedAt;

    function setPrice(address market, uint256 newPrice) external {
        price[market] = newPrice;
        updatedAt[market] = block.timestamp;
    }

    function getPrice(address market) external view returns (uint256, uint256) {
        return (price[market], updatedAt[market]);
    }
}
