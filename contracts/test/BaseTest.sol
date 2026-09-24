// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {MarginPool} from "../src/MarginPool.sol";
import {MarginTrading} from "../src/MarginTrading.sol";
import {RiskManager} from "../src/RiskManager.sol";
import {MockPriceOracle} from "./mocks/MockPriceOracle.sol";

/// @notice Deploys and wires the three contracts the way script/Deploy.s.sol does, for every test contract to reuse.
abstract contract BaseTest is Test {
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockPriceOracle internal oracle;
    RiskManager internal risk;
    MarginPool internal pool;
    MarginTrading internal trading;

    function setUp() public virtual {
        oracle = new MockPriceOracle();
        risk = new RiskManager(owner, oracle);
        pool = new MarginPool(owner);
        trading = new MarginTrading(pool, risk, owner);
        vm.prank(owner);
        pool.setMarginTrading(address(trading));
    }
}
