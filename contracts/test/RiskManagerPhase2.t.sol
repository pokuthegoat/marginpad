// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRiskManager} from "../src/interfaces/IRiskManager.sol";
import {OwnerPriceOracle} from "../src/oracles/OwnerPriceOracle.sol";
import {
    LeverageTooHigh,
    LeverageTooLow,
    MarketBorrowCapExceeded,
    MarketDisabled,
    PoolUtilizationCapExceeded,
    ZeroPrice
} from "../src/Errors.sol";
import {BaseTest} from "./BaseTest.sol";

contract RiskManagerPhase2Test is BaseTest {
    address internal tide = makeAddr("TIDE");

    function setUp() public override {
        super.setUp();
        // Demo market TIDE: 7x max, 5% maintenance, 90 ETH borrow cap.
        vm.prank(owner);
        risk.setMarketRisk(tide, IRiskManager.MarketRisk(true, 70_000, 500, 90 ether));
    }

    function test_validateOpen_returnsBorrowFromLeverage() public view {
        // borrowed = collateral * (leverage - 1)
        assertEq(risk.validateOpen(tide, 1 ether, 50_000, 1_000 ether, 0), 4 ether);
        assertEq(risk.validateOpen(tide, 2 ether, 10_000, 1_000 ether, 0), 0, "1x borrows nothing");
        assertEq(risk.validateOpen(tide, 10 ether, 70_000, 1_000 ether, 30 ether), 60 ether, "exactly max leverage");
    }

    function test_validateOpen_marketMustBeEnabled() public {
        address unknown = makeAddr("unknown");
        vm.expectRevert(abi.encodeWithSelector(MarketDisabled.selector, unknown));
        risk.validateOpen(unknown, 1 ether, 20_000, 1_000 ether, 0);

        vm.prank(owner);
        risk.setMarketRisk(tide, IRiskManager.MarketRisk(false, 70_000, 500, 90 ether));
        vm.expectRevert(abi.encodeWithSelector(MarketDisabled.selector, tide));
        risk.validateOpen(tide, 1 ether, 20_000, 1_000 ether, 0);
    }

    function test_validateOpen_leverageBounds() public {
        vm.expectRevert(abi.encodeWithSelector(LeverageTooHigh.selector, 70_001, 70_000));
        risk.validateOpen(tide, 1 ether, 70_001, 1_000 ether, 0);
        vm.expectRevert(abi.encodeWithSelector(LeverageTooLow.selector, 9_999));
        risk.validateOpen(tide, 1 ether, 9_999, 1_000 ether, 0);
    }

    function test_validateOpen_marketBorrowCap() public {
        // Cap 90: 10 ETH at 7x borrows 60; with 31 already borrowed only 59 is left.
        vm.expectRevert(abi.encodeWithSelector(MarketBorrowCapExceeded.selector, 60 ether, 59 ether));
        risk.validateOpen(tide, 10 ether, 70_000, 1_000 ether, 31 ether);
        assertEq(risk.validateOpen(tide, 10 ether, 70_000, 1_000 ether, 30 ether), 60 ether, "exactly at the cap");
    }

    function test_validateOpen_poolUtilizationLimit() public {
        vm.expectRevert(abi.encodeWithSelector(PoolUtilizationCapExceeded.selector, 60 ether, 59 ether));
        risk.validateOpen(tide, 10 ether, 70_000, 59 ether, 0);
    }

    function test_validateOpen_usesRealPoolRoom() public {
        vm.deal(alice, 100 ether);
        vm.prank(alice);
        pool.deposit{value: 100 ether}();
        assertEq(pool.maxBorrowable(), 90 ether);
        assertEq(risk.validateOpen(tide, 10 ether, 70_000, pool.maxBorrowable(), 0), 60 ether);
        vm.expectRevert(abi.encodeWithSelector(PoolUtilizationCapExceeded.selector, 90 ether, 60 ether));
        risk.validateOpen(tide, 15 ether, 70_000, 60 ether, 0);
    }

    function testFuzz_validateOpen_neverExceedsAnyLimit(uint96 collateral, uint32 lev, uint96 poolRoom, uint96 used)
        public
        view
    {
        try risk.validateOpen(tide, collateral, lev, poolRoom, used) returns (uint256 b) {
            assertLe(lev, 70_000);
            assertGe(lev, 10_000);
            assertLe(b, poolRoom);
            assertTrue(b == 0 || b + used <= 90 ether);
            assertLe(b, uint256(collateral) * 6);
        } catch {}
    }
}

contract OwnerPriceOracleTest is BaseTest {
    address internal token = makeAddr("token");

    function test_oracle_ownerSetsPrice_withTimestamp() public {
        OwnerPriceOracle o = new OwnerPriceOracle(owner);
        vm.warp(1_000);
        vm.prank(owner);
        o.setPrice(token, 0.0021 ether);
        (uint256 price, uint256 at) = o.getPrice(token);
        assertEq(price, 0.0021 ether);
        assertEq(at, 1_000);
    }

    function test_oracle_unsetMarketReturnsZero() public {
        OwnerPriceOracle o = new OwnerPriceOracle(owner);
        (uint256 price, uint256 at) = o.getPrice(token);
        assertEq(price, 0);
        assertEq(at, 0);
    }

    function test_oracle_onlyOwner_noZeroPrice() public {
        OwnerPriceOracle o = new OwnerPriceOracle(owner);
        vm.prank(alice);
        vm.expectRevert();
        o.setPrice(token, 1);
        vm.prank(owner);
        vm.expectRevert(ZeroPrice.selector);
        o.setPrice(token, 0);
    }

    function test_oracle_plugsIntoRiskManager() public {
        OwnerPriceOracle o = new OwnerPriceOracle(owner);
        vm.prank(owner);
        risk.setOracle(o);
        assertEq(address(risk.oracle()), address(o));
    }
}
