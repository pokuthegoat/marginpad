// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRiskManager} from "../src/interfaces/IRiskManager.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {Position, PositionStatus, Side} from "../src/Types.sol";
import {
    BelowMinimumCollateral,
    LeverageTooHigh,
    LeverageTooLow,
    MarketBorrowCapExceeded,
    MarketDisabled,
    NoPrice,
    NotPositionOwner,
    OnlyPool,
    OracleNotSet,
    PoolUtilizationCapExceeded,
    PositionNotOpen,
    ReserveTooLarge
} from "../src/Errors.sol";
import {BaseTest} from "./BaseTest.sol";

contract MarginTradingTest is BaseTest {
    address internal tide = makeAddr("TIDE"); // demo market: 7x, 5% maintenance, 90 ETH borrow cap
    address internal lp = makeAddr("lp");
    uint256 internal constant P0 = 1 ether; // entry price (wei per token)

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        risk.setMarketRisk(tide, IRiskManager.MarketRisk(true, 70_000, 500, 90 ether));
        vm.deal(owner, 100 ether);
        trading.fundReserve{value: 100 ether}(); // testnet settlement reserve
        vm.stopPrank();

        vm.deal(lp, 500 ether); // the demo pool starts at 500 ETH
        vm.prank(lp);
        pool.deposit{value: 500 ether}();

        oracle.setPrice(tide, P0);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
    }

    function _open(address who, Side side, uint256 collateral, uint256 lev) internal returns (uint256 id) {
        vm.prank(who);
        id = trading.openPosition{value: collateral}(tide, side, lev);
    }

    function _close(address who, uint256 id) internal returns (uint256 received) {
        uint256 before = who.balance;
        vm.prank(who);
        trading.closePosition(id);
        received = who.balance - before;
    }

    /*//////////////////////////////// opening ////////////////////////////////*/

    function test_openLong_recordsPositionAndBorrowsFromPool() public {
        vm.warp(5_000);
        oracle.setPrice(tide, P0); // re-push so the price is fresh at the new time
        uint256 id = _open(alice, Side.Long, 2 ether, 20_000); // 2 ETH at 2x
        assertEq(id, 1);
        assertEq(trading.nextPositionId(), 2);

        Position memory p = trading.getPosition(id);
        assertEq(p.owner, alice);
        assertEq(uint8(p.side), uint8(Side.Long));
        assertEq(uint8(p.status), uint8(PositionStatus.Open));
        assertEq(p.leverageBps, 20_000);
        assertEq(p.openedAt, 5_000);
        assertEq(p.market, tide);
        assertEq(p.collateral, 2 ether);
        assertEq(p.borrowed, 2 ether, "borrowed = collateral * (leverage - 1)");
        assertEq(p.entryPrice, P0);

        assertEq(uint256(p.collateral) + p.borrowed, 4 ether, "position size");
        assertEq(pool.totalBorrowed(), 2 ether);
        assertEq(trading.marketBorrowed(tide), 2 ether);
        assertEq(address(trading).balance, 100 ether + 4 ether, "reserve + collateral + borrowed");
    }

    function test_openShort_recordsSide() public {
        uint256 id = _open(bob, Side.Short, 1 ether, 50_000);
        Position memory p = trading.getPosition(id);
        assertEq(uint8(p.side), uint8(Side.Short));
        assertEq(p.borrowed, 4 ether);
        assertEq(p.owner, bob);
    }

    function test_open_entryPriceComesFromTheOracle() public {
        oracle.setPrice(tide, 0.0037 ether);
        uint256 id = _open(alice, Side.Long, 1 ether, 20_000);
        assertEq(trading.getPosition(id).entryPrice, 0.0037 ether);
    }

    function test_open_oneXBorrowsNothing() public {
        uint256 id = _open(alice, Side.Long, 1 ether, 10_000);
        assertEq(trading.getPosition(id).borrowed, 0);
        assertEq(pool.totalBorrowed(), 0);
    }

    function test_open_leverageLimits() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(LeverageTooHigh.selector, 70_001, 70_000));
        trading.openPosition{value: 1 ether}(tide, Side.Long, 70_001);
        vm.expectRevert(abi.encodeWithSelector(LeverageTooLow.selector, 9_999));
        trading.openPosition{value: 1 ether}(tide, Side.Long, 9_999);
        trading.openPosition{value: 1 ether}(tide, Side.Long, 70_000); // exactly max is fine
        vm.stopPrank();
    }

    function test_open_invalidOrDisabledMarket() public {
        address unknown = makeAddr("unknown");
        oracle.setPrice(unknown, P0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MarketDisabled.selector, unknown));
        trading.openPosition{value: 1 ether}(unknown, Side.Long, 20_000);

        vm.prank(owner);
        risk.setMarketRisk(tide, IRiskManager.MarketRisk(false, 70_000, 500, 90 ether));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MarketDisabled.selector, tide));
        trading.openPosition{value: 1 ether}(tide, Side.Long, 20_000);
    }

    function test_open_belowMinimumCollateral() public {
        vm.prank(alice);
        vm.expectRevert(BelowMinimumCollateral.selector);
        trading.openPosition{value: 0.0099 ether}(tide, Side.Long, 20_000);
    }

    function test_open_marketBorrowCap() public {
        _open(alice, Side.Long, 10 ether, 70_000); // borrows 60 of the 90 cap
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MarketBorrowCapExceeded.selector, 60 ether, 30 ether));
        trading.openPosition{value: 10 ether}(tide, Side.Long, 70_000);
    }

    function test_open_poolUtilizationLimit() public {
        // Two more markets so only the pool limit (450 ETH of 500) binds.
        address m2 = makeAddr("m2");
        vm.prank(owner);
        risk.setMarketRisk(m2, IRiskManager.MarketRisk(true, 70_000, 500, 1_000 ether));
        oracle.setPrice(m2, P0);
        vm.prank(alice);
        trading.openPosition{value: 70 ether}(m2, Side.Long, 70_000); // borrows 420
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PoolUtilizationCapExceeded.selector, 60 ether, 30 ether));
        trading.openPosition{value: 10 ether}(m2, Side.Long, 70_000);
    }

    function test_open_needsAnOraclePrice() public {
        address noPrice = makeAddr("noPrice");
        vm.prank(owner);
        risk.setMarketRisk(noPrice, IRiskManager.MarketRisk(true, 70_000, 500, 90 ether));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NoPrice.selector, noPrice));
        trading.openPosition{value: 1 ether}(noPrice, Side.Long, 20_000);

        vm.prank(owner);
        risk.setOracle(IPriceOracle(address(0)));
        vm.prank(alice);
        vm.expectRevert(OracleNotSet.selector);
        trading.openPosition{value: 1 ether}(tide, Side.Long, 20_000);
    }

    /*//////////////////////////////// closing: profit ////////////////////////////////*/

    function test_closeLong_profit_matchesTheDemoExample() public {
        uint256 id = _open(alice, Side.Long, 2 ether, 20_000); // 2 ETH at 2x = 4 ETH position
        oracle.setPrice(tide, 1.1 ether); // +10%

        uint256 reserveBefore = trading.reserve();
        uint256 received = _close(alice, id);

        assertEq(received, 2.38 ether, "collateral 2 + profit 0.4 - 5% LP share 0.02");
        assertEq(pool.totalBorrowed(), 0, "principal repaid");
        assertEq(pool.rewardReserve(), 0.02 ether, "5% of the profit goes to LPs");
        assertEq(pool.pendingRewardsOf(lp), 0.02 ether);
        assertEq(pool.totalDeposits(), 500 ether);
        assertEq(reserveBefore - trading.reserve(), 0.4 ether, "the profit came out of the reserve");
        assertEq(uint8(trading.getPosition(id).status), uint8(PositionStatus.Closed));
        assertEq(trading.marketBorrowed(tide), 0);
    }

    function test_closeShort_profit_whenPriceFalls() public {
        uint256 id = _open(alice, Side.Short, 2 ether, 20_000);
        oracle.setPrice(tide, 0.9 ether); // -10%
        assertEq(_close(alice, id), 2.38 ether);
        assertEq(pool.rewardReserve(), 0.02 ether);
    }

    function test_close_lpRewardsAreSplitProRataAcrossLps() public {
        address lp2 = makeAddr("lp2");
        vm.deal(lp2, 500 ether);
        vm.prank(lp2);
        pool.deposit{value: 500 ether}();
        uint256 id = _open(alice, Side.Long, 2 ether, 20_000);
        oracle.setPrice(tide, 1.1 ether);
        _close(alice, id);
        assertEq(pool.pendingRewardsOf(lp), 0.01 ether);
        assertEq(pool.pendingRewardsOf(lp2), 0.01 ether);
    }

    function test_close_profitIsCappedAtTheReserve() public {
        vm.prank(owner);
        trading.withdrawReserve(99.9 ether); // 0.1 ETH left, but the profit would be 0.4
        uint256 id = _open(alice, Side.Long, 2 ether, 20_000);
        oracle.setPrice(tide, 1.1 ether);
        uint256 received = _close(alice, id);
        assertEq(received, 2 ether + 0.1 ether - 0.005 ether);
        assertEq(pool.totalBorrowed(), 0, "the pool is still repaid in full");
        assertEq(pool.rewardReserve(), 0.005 ether);
        assertEq(trading.reserve(), 0);
    }

    /*//////////////////////////////// closing: loss ////////////////////////////////*/

    function test_closeLong_loss_collateralAbsorbsIt() public {
        uint256 id = _open(alice, Side.Long, 2 ether, 20_000);
        oracle.setPrice(tide, 0.9 ether); // -10% of a 4 ETH position = -0.4
        uint256 reserveBefore = trading.reserve();
        uint256 received = _close(alice, id);

        assertEq(received, 1.6 ether);
        assertEq(pool.totalBorrowed(), 0);
        assertEq(pool.totalDeposits(), 500 ether, "LPs lose nothing");
        assertEq(pool.rewardReserve(), 0, "no LP share on a loss");
        assertEq(trading.reserve(), reserveBefore + 0.4 ether, "the loss stays behind as reserve");
    }

    function test_closeShort_loss_whenPriceRises() public {
        uint256 id = _open(alice, Side.Short, 2 ether, 20_000);
        oracle.setPrice(tide, 1.1 ether);
        assertEq(_close(alice, id), 1.6 ether);
    }

    function test_close_lossBeyondCollateral_isCapped_poolStillRepaid() public {
        uint256 id = _open(alice, Side.Long, 2 ether, 20_000);
        oracle.setPrice(tide, 0.4 ether); // -60% of 4 ETH = -2.4 > 2 ETH collateral
        assertEq(_close(alice, id), 0, "the trader loses all collateral, no more");
        assertEq(pool.totalBorrowed(), 0);
        assertEq(pool.totalDeposits(), 500 ether, "no unpaid debt for the pool");
    }

    function test_close_unchangedPrice_returnsCollateral() public {
        uint256 id = _open(alice, Side.Long, 3 ether, 40_000);
        assertEq(_close(alice, id), 3 ether);
        assertEq(pool.rewardReserve(), 0);
    }

    /*//////////////////////////////// ownership & state ////////////////////////////////*/

    function test_close_onlyThePositionOwner() public {
        uint256 id = _open(alice, Side.Long, 2 ether, 20_000);
        vm.prank(bob);
        vm.expectRevert(NotPositionOwner.selector);
        trading.closePosition(id);
        vm.prank(owner);
        vm.expectRevert(NotPositionOwner.selector);
        trading.closePosition(id);
    }

    function test_close_cannotCloseTwiceOrUnknown() public {
        uint256 id = _open(alice, Side.Long, 2 ether, 20_000);
        _close(alice, id);
        vm.prank(alice);
        vm.expectRevert(PositionNotOpen.selector);
        trading.closePosition(id);
        vm.prank(alice);
        vm.expectRevert(PositionNotOpen.selector);
        trading.closePosition(999);
    }

    function test_close_usesTheCurrentOraclePrice_notTheEntryPrice() public {
        uint256 id = _open(alice, Side.Long, 2 ether, 20_000);
        oracle.setPrice(tide, 1.5 ether);
        oracle.setPrice(tide, 1.1 ether); // the latest push is the one that counts
        assertEq(_close(alice, id), 2.38 ether);
    }

    function test_positionsAreIndependent() public {
        uint256 a = _open(alice, Side.Long, 2 ether, 20_000);
        uint256 b = _open(bob, Side.Short, 1 ether, 30_000);
        assertEq(pool.totalBorrowed(), 4 ether);
        assertEq(trading.marketBorrowed(tide), 4 ether);
        oracle.setPrice(tide, 1.1 ether);
        _close(alice, a);
        assertEq(pool.totalBorrowed(), 2 ether);
        assertEq(uint8(trading.getPosition(b).status), uint8(PositionStatus.Open));
        assertEq(_close(bob, b), 1 ether - 0.3 ether); // short of 3 ETH loses 10% = 0.3
    }

    /*//////////////////////////////// reserve, ETH handling ////////////////////////////////*/

    function test_reserve_ownerOnly_andBounded() public {
        vm.prank(alice);
        vm.expectRevert();
        trading.fundReserve{value: 1 ether}();
        vm.prank(owner);
        vm.expectRevert(ReserveTooLarge.selector);
        trading.withdrawReserve(101 ether);
    }

    function test_plainEth_onlyFromThePool() public {
        vm.prank(alice);
        (bool ok,) = address(trading).call{value: 1 ether}("");
        assertFalse(ok);
        vm.prank(alice);
        vm.expectRevert(OnlyPool.selector);
        payable(address(trading)).transfer(1 ether);
    }

    /*//////////////////////////////// fuzz ////////////////////////////////*/

    /// @dev Any leverage, side and exit price: the pool is always repaid, the books balance, and the trader never
    ///      receives more than collateral + reserve-backed profit.
    function testFuzz_openClose_poolAlwaysWhole(uint96 collateral, uint32 lev, bool long, uint96 exitPrice) public {
        collateral = uint96(bound(collateral, 0.01 ether, 12 ether));
        lev = uint32(bound(lev, 10_000, 70_000));
        exitPrice = uint96(bound(exitPrice, 1, 5 ether));

        uint256 id = _open(alice, long ? Side.Long : Side.Short, collateral, lev);
        oracle.setPrice(tide, exitPrice);
        uint256 reserveBefore = trading.reserve();
        uint256 received = _close(alice, id);

        assertEq(pool.totalBorrowed(), 0, "pool debt fully repaid");
        assertEq(pool.totalDeposits(), 500 ether, "LP principal untouched");
        assertEq(trading.marketBorrowed(tide), 0);
        assertEq(address(pool).balance, 500 ether + pool.rewardReserve(), "pool holds deposits + rewards");
        assertEq(address(trading).balance, trading.reserve(), "nothing left behind after the only position closes");
        assertLe(received, uint256(collateral) + reserveBefore);
        assertLe(pool.rewardReserve(), reserveBefore / 20 + 1, "LP share is at most 5% of what the reserve paid");
    }
}
