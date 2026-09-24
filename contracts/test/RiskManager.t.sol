// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {IRiskManager} from "../src/interfaces/IRiskManager.sol";
import {ProtocolParams} from "../src/ProtocolParams.sol";
import {InvalidRiskConfig, ZeroAddress} from "../src/Errors.sol";
import {BaseTest} from "./BaseTest.sol";

contract RiskManagerTest is BaseTest {
    address internal market = address(0xBEEF);

    function _cfg(bool enabled, uint32 lev, uint16 maint, uint128 cap) internal pure returns (IRiskManager.MarketRisk memory) {
        return IRiskManager.MarketRisk({enabled: enabled, maxLeverageBps: lev, maintenanceBps: maint, maxBorrow: cap});
    }

    function _set(IRiskManager.MarketRisk memory r) internal {
        vm.prank(owner);
        risk.setMarketRisk(market, r);
    }

    function _reverts(IRiskManager.MarketRisk memory r) internal {
        vm.prank(owner);
        vm.expectRevert(InvalidRiskConfig.selector);
        risk.setMarketRisk(market, r);
    }

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    function test_setMarketRisk_storesAndEmits() public {
        vm.expectEmit(true, false, false, true, address(risk));
        emit IRiskManager.MarketRiskUpdated(market, true, 40_000, 600, 45 ether);
        _set(_cfg(true, 40_000, 600, 45 ether));

        IRiskManager.MarketRisk memory got = risk.marketRisk(market);
        assertTrue(got.enabled);
        assertEq(got.maxLeverageBps, 40_000);
        assertEq(got.maintenanceBps, 600);
        assertEq(got.maxBorrow, 45 ether);
    }

    function test_setMarketRisk_ownerOnly_andRejectsZeroMarket() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        risk.setMarketRisk(market, _cfg(true, 20_000, 700, 1 ether));

        vm.prank(owner);
        vm.expectRevert(ZeroAddress.selector);
        risk.setMarketRisk(address(0), _cfg(true, 20_000, 700, 1 ether));
    }

    function test_setMarketRisk_canReplaceAndDisable() public {
        _set(_cfg(true, 20_000, 700, 12 ether));
        _set(_cfg(false, 0, 0, 0));
        assertFalse(risk.marketRisk(market).enabled);
    }

    function test_disabledMarket_isStoredAsGiven_soItCanAlwaysBeSwitchedOff() public {
        _set(_cfg(false, 999_999, 0, 0)); // junk values are fine while disabled
        assertEq(risk.marketRisk(market).maxLeverageBps, 999_999);
    }

    /*//////////////////////////////////////////////////////////////
                              THE RULES
    //////////////////////////////////////////////////////////////*/

    function test_leverageMustBeBetween1xAnd10x() public {
        _reverts(_cfg(true, 9_999, 100, 1 ether)); // just under 1x
        _reverts(_cfg(true, 0, 100, 1 ether));
        _reverts(_cfg(true, 100_001, 100, 1 ether)); // just over the 10x ceiling
        _set(_cfg(true, 10_000, 100, 1 ether)); // exactly 1x
        _set(_cfg(true, 100_000, 100, 1 ether)); // exactly 10x
    }

    function test_maintenanceMustLeaveAPositiveLiquidationBuffer() public {
        // Rule: maintenance < 1 / maxLeverage, i.e. maintenanceBps * maxLeverageBps < 10_000^2.
        _reverts(_cfg(true, 20_000, 0, 1 ether)); // zero maintenance is never valid
        _reverts(_cfg(true, 100_000, 1_000, 1 ether)); // 10x with 10% maintenance: buffer is exactly zero
        _set(_cfg(true, 100_000, 999, 1 ether)); // 9.99%: just inside
        _reverts(_cfg(true, 20_000, 5_000, 1 ether)); // 2x with 50%: exactly zero buffer
        _set(_cfg(true, 20_000, 4_999, 1 ether));
        _reverts(_cfg(true, 10_000, 10_000, 1 ether)); // 1x with 100%
        _set(_cfg(true, 10_000, 9_999, 1 ether));
    }

    /// @dev Every market the demo app ships (src/store/market.ts) must be a valid on-chain config.
    function test_everyDemoMarketIsAValidConfig() public {
        uint32[5] memory lev = [uint32(15_000), 20_000, 40_000, 70_000, 100_000]; // PLNK FERRY LCAT TIDE PONSW
        uint16[5] memory maint = [uint16(800), 700, 600, 500, 500];
        uint128[5] memory cap = [uint128(3 ether), 12 ether, 45 ether, 90 ether, 160 ether];
        for (uint256 i; i < 5; ++i) {
            address m = address(uint160(0x1000 + i));
            vm.prank(owner);
            risk.setMarketRisk(m, _cfg(true, lev[i], maint[i], cap[i]));
            assertTrue(risk.marketRisk(m).enabled);
        }
    }

    /// @dev For ANY input the manager either accepts a config that satisfies every rule, or reverts with
    ///      InvalidRiskConfig. It never stores a config that breaks the rules.
    function testFuzz_setMarketRisk_enforcesTheRules(bool enabled, uint32 lev, uint16 maint, uint128 cap) public {
        bool valid = !enabled
            || (lev >= ProtocolParams.MIN_LEVERAGE_BPS && lev <= ProtocolParams.MAX_LEVERAGE_BPS && maint != 0
                && uint256(maint) * lev < ProtocolParams.BPS * ProtocolParams.BPS);

        if (valid) {
            _set(_cfg(enabled, lev, maint, cap));
            IRiskManager.MarketRisk memory got = risk.marketRisk(market);
            assertEq(got.enabled, enabled);
            assertEq(got.maxLeverageBps, lev);
            assertEq(got.maintenanceBps, maint);
            assertEq(got.maxBorrow, cap);
            if (got.enabled) {
                assertLe(got.maxLeverageBps, ProtocolParams.MAX_LEVERAGE_BPS, "never above 10x");
                assertLt(uint256(got.maintenanceBps) * got.maxLeverageBps, ProtocolParams.BPS * ProtocolParams.BPS);
            }
        } else {
            _reverts(_cfg(enabled, lev, maint, cap));
            assertFalse(risk.marketRisk(market).enabled, "a rejected config stores nothing");
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 ORACLE
    //////////////////////////////////////////////////////////////*/

    function test_setOracle_ownerOnly_andEmits() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        risk.setOracle(IPriceOracle(address(0x1234)));

        vm.expectEmit(true, false, false, false, address(risk));
        emit IRiskManager.OracleUpdated(address(0x1234));
        vm.prank(owner);
        risk.setOracle(IPriceOracle(address(0x1234)));
        assertEq(address(risk.oracle()), address(0x1234));
    }

    function test_oraclePriceIsReadableThroughTheRiskManager() public {
        oracle.setPrice(market, 2 ether);
        (uint256 price, uint256 updatedAt) = risk.oracle().getPrice(market);
        assertEq(price, 2 ether);
        assertEq(updatedAt, block.timestamp);
    }
}
