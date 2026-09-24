// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IMarginPool} from "../src/interfaces/IMarginPool.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {IMarginTrading} from "../src/interfaces/IMarginTrading.sol";
import {IRiskManager} from "../src/interfaces/IRiskManager.sol";
import {MarginPool} from "../src/MarginPool.sol";
import {MarginTrading} from "../src/MarginTrading.sol";
import {RiskManager} from "../src/RiskManager.sol";
import {ProtocolParams} from "../src/ProtocolParams.sol";
import {Side} from "../src/Types.sol";
import {MarginTradingAlreadySet, RenounceDisabled, ZeroAddress} from "../src/Errors.sol";
import {BaseTest} from "./BaseTest.sol";

/// @notice Proves the toolchain works and the contracts are wired and locked down as designed.
contract WiringTest is BaseTest {
    function _ownable2Step() internal view returns (Ownable2Step[3] memory list) {
        list = [Ownable2Step(address(pool)), Ownable2Step(address(trading)), Ownable2Step(address(risk))];
    }

    function _notOwner(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who);
    }

    /*//////////////////////////////////////////////////////////////
                                  WIRING
    //////////////////////////////////////////////////////////////*/

    function test_wiring() public view {
        assertEq(pool.marginTrading(), address(trading), "pool -> trading");
        assertEq(address(trading.pool()), address(pool), "trading -> pool");
        assertEq(address(trading.riskManager()), address(risk), "trading -> risk");
        assertEq(address(risk.oracle()), address(oracle), "risk -> oracle");
        assertEq(pool.owner(), owner);
        assertEq(trading.owner(), owner);
        assertEq(risk.owner(), owner);
    }

    function test_contractsAreUsableThroughTheirInterfaces() public view {
        IMarginPool p = IMarginPool(address(pool));
        IMarginTrading t = IMarginTrading(address(trading));
        IRiskManager r = IRiskManager(address(risk));

        assertEq(p.totalDeposits(), 0);
        assertEq(p.totalBorrowed(), 0);
        assertEq(p.totalShares(), 0);
        assertEq(p.sharesOf(alice), 0);
        assertEq(p.availableLiquidity(), 0);
        assertEq(p.utilizationBps(), 0);
        assertEq(p.maxBorrowable(), 0);
        assertEq(t.nextPositionId(), 1, "ids start at 1 so 0 can mean 'no position'");
        assertEq(t.marketBorrowed(address(0xBEEF)), 0);
        assertEq(uint8(t.getPosition(1).status), 0, "an unknown id reads as PositionStatus.None");
        assertFalse(r.marketRisk(address(0xBEEF)).enabled, "unconfigured markets are disabled");
    }

    function test_setMarginTrading_isOwnerOnly() public {
        MarginPool fresh = new MarginPool(owner);
        vm.prank(alice);
        vm.expectRevert(_notOwner(alice));
        fresh.setMarginTrading(alice);
    }

    function test_setMarginTrading_rejectsZeroAddress() public {
        MarginPool fresh = new MarginPool(owner);
        vm.prank(owner);
        vm.expectRevert(ZeroAddress.selector);
        fresh.setMarginTrading(address(0));
    }

    function test_setMarginTrading_canOnlyBeSetOnce() public {
        vm.prank(owner);
        vm.expectRevert(MarginTradingAlreadySet.selector);
        pool.setMarginTrading(alice);
        assertEq(pool.marginTrading(), address(trading), "unchanged");
    }

    function test_setMarginTrading_emitsEvent() public {
        MarginPool fresh = new MarginPool(owner);
        vm.expectEmit(true, false, false, false, address(fresh));
        emit IMarginPool.MarginTradingSet(address(trading));
        vm.prank(owner);
        fresh.setMarginTrading(address(trading));
    }

    function test_constructors_rejectZeroAddresses() public {
        vm.expectRevert(ZeroAddress.selector);
        new MarginTrading(IMarginPool(address(0)), risk, owner);
        vm.expectRevert(ZeroAddress.selector);
        new MarginTrading(pool, IRiskManager(address(0)), owner);
        // Ownable itself refuses a zero owner.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new MarginPool(address(0));
    }

    function test_riskManager_canBeDeployedWithoutAnOracle() public {
        RiskManager noOracle = new RiskManager(owner, IPriceOracle(address(0)));
        assertEq(address(noOracle.oracle()), address(0));
    }

    /*//////////////////////////////////////////////////////////////
                              OWNERSHIP + PAUSE
    //////////////////////////////////////////////////////////////*/

    function test_ownership_isTwoStep_onEveryContract() public {
        Ownable2Step[3] memory list = _ownable2Step();
        for (uint256 i; i < list.length; ++i) {
            vm.prank(owner);
            list[i].transferOwnership(alice);
            assertEq(list[i].owner(), owner, "still the old owner until accepted");
            assertEq(list[i].pendingOwner(), alice);

            vm.prank(bob);
            vm.expectRevert(_notOwner(bob));
            list[i].acceptOwnership();

            vm.prank(alice);
            list[i].acceptOwnership();
            assertEq(list[i].owner(), alice);
        }
    }

    function test_ownership_cannotBeRenounced() public {
        Ownable2Step[3] memory list = _ownable2Step();
        for (uint256 i; i < list.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(RenounceDisabled.selector);
            list[i].renounceOwnership();
            assertEq(list[i].owner(), owner);
        }
    }

    function test_pause_isOwnerOnly() public {
        vm.startPrank(alice);
        vm.expectRevert(_notOwner(alice));
        pool.pause();
        vm.expectRevert(_notOwner(alice));
        trading.pause();
        vm.stopPrank();
    }

    function test_pause_stopsEveryStateChangingEntryPoint_andUnpauseRestoresThem() public {
        vm.startPrank(owner);
        pool.pause();
        trading.pause();
        vm.stopPrank();
        vm.deal(alice, 10 ether);

        vm.startPrank(alice);
        bytes memory paused = abi.encodeWithSelector(Pausable.EnforcedPause.selector);
        vm.expectRevert(paused);
        pool.deposit{value: 1 ether}();
        vm.expectRevert(paused);
        pool.withdraw(1);
        vm.expectRevert(paused);
        pool.claimRewards();
        vm.expectRevert(paused);
        trading.openPosition{value: 1 ether}(address(0xBEEF), Side.Long, 20_000);
        vm.expectRevert(paused);
        trading.closePosition(1);
        vm.expectRevert(paused);
        trading.liquidate(1);
        vm.stopPrank();

        // The pool's MarginTrading-only functions are stopped too.
        vm.prank(address(trading));
        vm.expectRevert(paused);
        pool.borrow(1);

        vm.startPrank(owner);
        pool.unpause();
        trading.unpause();
        vm.stopPrank();

        vm.prank(alice);
        pool.deposit{value: 1 ether}(); // reachable again after unpause
        assertEq(pool.totalDeposits(), 1 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                   ETH
    //////////////////////////////////////////////////////////////*/

    function test_plainEthTransfers_areRejected() public {
        vm.deal(alice, 3 ether);
        address[3] memory targets = [address(pool), address(trading), address(risk)];
        for (uint256 i; i < targets.length; ++i) {
            vm.prank(alice);
            (bool ok,) = targets[i].call{value: 1 ether}("");
            assertFalse(ok, "no receive()/fallback(): nothing can be stranded");
            assertEq(targets[i].balance, 0);
        }
        assertEq(alice.balance, 3 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                  PARAMS
    //////////////////////////////////////////////////////////////*/

    /// @dev These must equal the demo app's numbers in src/store/store.ts, so on-chain behaviour matches the UI.
    function test_protocolParams_mirrorTheDemoApp() public pure {
        assertEq(ProtocolParams.BPS, 10_000);
        assertEq(ProtocolParams.MAX_UTILIZATION_BPS, 9_000, "demo MAX_UTILIZATION = 0.9");
        assertEq(ProtocolParams.LP_PROFIT_SHARE_BPS, 500, "demo LP_PROFIT_SHARE = 0.05");
        assertEq(ProtocolParams.MIN_LEVERAGE_BPS, ProtocolParams.BPS, "1x");
        assertEq(ProtocolParams.MAX_LEVERAGE_BPS, 10 * ProtocolParams.BPS, "10x ceiling");
        assertEq(ProtocolParams.MIN_COLLATERAL, 0.01 ether, "demo MIN_COLLATERAL");
        assertEq(ProtocolParams.MIN_DEPOSIT, 0.01 ether, "demo MIN_DEPOSIT");
    }
}
