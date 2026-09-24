// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRiskManager} from "../src/interfaces/IRiskManager.sol";
import {IMarginTrading} from "../src/interfaces/IMarginTrading.sol";
import {Position, PositionStatus, Side} from "../src/Types.sol";
import {
    InvalidRiskConfig,
    LeverageTooLow,
    NotLiquidatable,
    NoPrice,
    PositionNotOpen,
    StalePrice
} from "../src/Errors.sol";
import {BaseTest} from "./BaseTest.sol";

contract LiquidationTest is BaseTest {
    address internal tide = makeAddr("TIDE"); // demo market: 7x max, 5% maintenance, 90 ETH borrow cap
    address internal lp = makeAddr("lp");
    address internal keeper = makeAddr("keeper");
    uint256 internal constant P0 = 1 ether;

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        risk.setMarketRisk(tide, IRiskManager.MarketRisk(true, 70_000, 500, 90 ether));
        vm.deal(owner, 100 ether);
        trading.fundReserve{value: 100 ether}();
        vm.stopPrank();

        vm.deal(lp, 500 ether);
        vm.prank(lp);
        pool.deposit{value: 500 ether}();

        oracle.setPrice(tide, P0);
        vm.deal(alice, 1_000 ether);
    }

    function _open(Side side, uint256 collateral, uint256 lev) internal returns (uint256 id) {
        vm.prank(alice);
        id = trading.openPosition{value: collateral}(tide, side, lev);
    }

    function _liquidate(uint256 id) internal {
        vm.prank(keeper);
        trading.liquidate(id);
    }

    function _assertBooksBalance() internal view {
        assertEq(pool.totalBorrowed(), 0);
        assertEq(address(pool).balance, pool.totalDeposits() + pool.rewardReserve(), "pool books");
        assertEq(address(trading).balance, trading.reserve(), "trading holds only the reserve");
    }

    /*//////////////////////////////// liquidation price ////////////////////////////////*/

    function test_liquidationPrice_math() public view {
        // buffer = 1/leverage - maintenance
        assertEq(risk.liquidationPrice(tide, Side.Long, 20_000, 1 ether), 0.55 ether, "2x long: -45%");
        assertEq(risk.liquidationPrice(tide, Side.Short, 20_000, 1 ether), 1.45 ether, "2x short: +45%");
        assertEq(risk.liquidationPrice(tide, Side.Long, 10_000, 1 ether), 0.05 ether, "1x long: -95%");
        assertEq(risk.liquidationPrice(tide, Side.Long, 70_000, 1 ether), 0.9072 ether, "7x long");
        assertEq(risk.liquidationPrice(tide, Side.Short, 70_000, 2 ether), 2 * 1.0928 ether, "scales with entry");
    }

    function test_liquidationPrice_bufferGone_liquidatesAtEntry() public {
        // Maintenance raised past 1/leverage after opening: no buffer left.
        vm.prank(owner);
        risk.setMarketRisk(tide, IRiskManager.MarketRisk(false, 20_000, 5_000, 90 ether)); // disabled markets are stored as given
        assertEq(risk.liquidationPrice(tide, Side.Long, 20_000, 1 ether), 1 ether);
        assertEq(risk.liquidationPrice(tide, Side.Short, 20_000, 1 ether), 1 ether);
    }

    function test_liquidationPrice_rejectsLeverageBelow1x() public {
        vm.expectRevert(abi.encodeWithSelector(LeverageTooLow.selector, 9_999));
        risk.liquidationPrice(tide, Side.Long, 9_999, 1 ether);
    }

    /*//////////////////////////////// isLiquidatable ////////////////////////////////*/

    function test_isLiquidatable_boundaryAndSides() public {
        uint256 l = _open(Side.Long, 2 ether, 20_000);
        uint256 s = _open(Side.Short, 2 ether, 20_000);

        oracle.setPrice(tide, 0.56 ether);
        assertFalse(risk.isLiquidatable(trading.getPosition(l)));
        oracle.setPrice(tide, 0.55 ether); // exactly at the level
        assertTrue(risk.isLiquidatable(trading.getPosition(l)));
        assertFalse(risk.isLiquidatable(trading.getPosition(s)), "a falling price cannot hurt the short");

        oracle.setPrice(tide, 1.44 ether);
        assertFalse(risk.isLiquidatable(trading.getPosition(s)));
        oracle.setPrice(tide, 1.45 ether);
        assertTrue(risk.isLiquidatable(trading.getPosition(s)));
    }

    function test_isLiquidatable_falseForNoneClosedOrLiquidated() public {
        Position memory none;
        assertFalse(risk.isLiquidatable(none));

        uint256 id = _open(Side.Long, 2 ether, 20_000);
        vm.prank(alice);
        trading.closePosition(id);
        assertFalse(risk.isLiquidatable(trading.getPosition(id)));
    }

    /*//////////////////////////////// liquidating ////////////////////////////////*/

    function test_liquidateLong_repaysPool_andSendsLeftoverEquityToPool() public {
        uint256 id = _open(Side.Long, 2 ether, 20_000); // size 4, borrowed 2
        oracle.setPrice(tide, 0.55 ether); // loss 1.8 -> value 2.2

        uint256 assetsBefore = pool.assetsOf(lp);
        uint256 traderBefore = alice.balance;
        uint256 reserveBefore = trading.reserve();

        vm.expectEmit(true, true, true, true, address(trading));
        emit IMarginTrading.PositionLiquidated(id, alice, keeper, 0.55 ether, 0.2 ether, 0);
        _liquidate(id);

        assertEq(uint8(trading.getPosition(id).status), uint8(PositionStatus.Liquidated));
        assertEq(pool.totalBorrowed(), 0, "principal repaid first");
        assertEq(pool.totalDeposits(), 500.2 ether, "leftover equity 0.2 added to the pool");
        assertEq(pool.assetsOf(lp), assetsBefore + 0.2 ether);
        assertEq(trading.reserve(), reserveBefore + 1.8 ether, "the trader loss goes to the reserve");
        assertEq(trading.marketBorrowed(tide), 0);
        assertEq(alice.balance, traderBefore, "a liquidated trader gets nothing back");
        assertEq(keeper.balance, 0, "no keeper reward in this version");
        _assertBooksBalance();
    }

    function test_liquidateShort_atTheUpperLevel() public {
        uint256 id = _open(Side.Short, 2 ether, 20_000);
        oracle.setPrice(tide, 1.45 ether);
        _liquidate(id);
        assertEq(uint8(trading.getPosition(id).status), uint8(PositionStatus.Liquidated));
        assertEq(pool.totalDeposits(), 500.2 ether);
        _assertBooksBalance();
    }

    function test_liquidate_priceGap_poolAbsorbsTheShortfall() public {
        uint256 id = _open(Side.Long, 1 ether, 70_000); // size 7, borrowed 6
        oracle.setPrice(tide, 0.5 ether); // price gapped through the level: loss 3.5 -> value 3.5 < 6 owed
        vm.expectEmit(true, true, true, true, address(trading));
        emit IMarginTrading.PositionLiquidated(id, alice, keeper, 0.5 ether, 0, 2.5 ether);
        _liquidate(id);

        assertEq(pool.totalBorrowed(), 0, "the debt is cleared");
        assertEq(pool.totalDeposits(), 497.5 ether, "LPs absorb only the 2.5 ETH the collateral could not cover");
        assertEq(pool.assetsOf(lp), 497.5 ether);
        assertEq(trading.reserve(), 100 ether + 3.5 ether);
        _assertBooksBalance();
    }

    function test_liquidate_totalWipeout_shortRisingPastDouble() public {
        uint256 id = _open(Side.Short, 1 ether, 20_000); // size 2, borrowed 1
        oracle.setPrice(tide, 5 ether); // loss = 2 * 400% = 8 > size: nothing left
        _liquidate(id);
        assertEq(pool.totalDeposits(), 499 ether, "pool loses the whole 1 ETH borrowed");
        assertEq(trading.reserve(), 102 ether, "the reserve keeps everything the position held");
        _assertBooksBalance();
    }

    function test_liquidate_oneXPosition_hasNothingToRepay() public {
        uint256 id = _open(Side.Long, 1 ether, 10_000);
        oracle.setPrice(tide, 0.05 ether);
        _liquidate(id);
        assertEq(pool.totalDeposits(), 500 ether + 0.05 ether);
        _assertBooksBalance();
    }

    function test_liquidate_lpsShareTheEquityProRata() public {
        address lp2 = makeAddr("lp2");
        vm.deal(lp2, 500 ether);
        vm.prank(lp2);
        pool.deposit{value: 500 ether}();
        uint256 id = _open(Side.Long, 2 ether, 20_000);
        oracle.setPrice(tide, 0.55 ether);
        _liquidate(id);
        assertEq(pool.assetsOf(lp), 500.1 ether);
        assertEq(pool.assetsOf(lp2), 500.1 ether);
    }

    /*//////////////////////////////// not liquidatable ////////////////////////////////*/

    function test_liquidate_healthyPositionReverts() public {
        uint256 id = _open(Side.Long, 2 ether, 20_000);
        oracle.setPrice(tide, 0.56 ether); // just above the level
        vm.prank(keeper);
        vm.expectRevert(NotLiquidatable.selector);
        trading.liquidate(id);
        assertEq(uint8(trading.getPosition(id).status), uint8(PositionStatus.Open));
    }

    function test_liquidate_unchangedAndProfitablePositionsRevert() public {
        uint256 id = _open(Side.Short, 2 ether, 20_000);
        vm.prank(keeper);
        vm.expectRevert(NotLiquidatable.selector);
        trading.liquidate(id);
        oracle.setPrice(tide, 0.6 ether); // the short is in profit
        vm.prank(keeper);
        vm.expectRevert(NotLiquidatable.selector);
        trading.liquidate(id);
    }

    function test_liquidate_ownersCannotLiquidateAHealthyPosition() public {
        uint256 id = _open(Side.Long, 2 ether, 20_000);
        oracle.setPrice(tide, 0.8 ether);
        vm.prank(owner); // protocol owner
        vm.expectRevert(NotLiquidatable.selector);
        trading.liquidate(id);
        vm.prank(alice); // the trader
        vm.expectRevert(NotLiquidatable.selector);
        trading.liquidate(id);
    }

    function test_liquidate_cannotLiquidateTwice_orAfterClose_orUnknown() public {
        uint256 id = _open(Side.Long, 2 ether, 20_000);
        oracle.setPrice(tide, 0.5 ether);
        _liquidate(id);
        vm.prank(keeper);
        vm.expectRevert(PositionNotOpen.selector);
        trading.liquidate(id);
        vm.prank(alice);
        vm.expectRevert(PositionNotOpen.selector);
        trading.closePosition(id);

        uint256 id2 = _open(Side.Long, 2 ether, 20_000);
        oracle.setPrice(tide, 1 ether);
        vm.prank(alice);
        trading.closePosition(id2);
        vm.prank(keeper);
        vm.expectRevert(PositionNotOpen.selector);
        trading.liquidate(id2);
        vm.prank(keeper);
        vm.expectRevert(PositionNotOpen.selector);
        trading.liquidate(12_345);
    }

    /*//////////////////////////////// staleness ////////////////////////////////*/

    function test_staleOracle_isRejectedEverywhere() public {
        uint256 id = _open(Side.Long, 2 ether, 20_000);
        oracle.setPrice(tide, 0.5 ether); // would be liquidatable...
        uint256 pushed = block.timestamp;
        vm.warp(pushed + 1 hours + 1); // ...but the price is now too old to act on

        bytes memory stale = abi.encodeWithSelector(StalePrice.selector, tide, pushed);
        vm.prank(keeper);
        vm.expectRevert(stale);
        trading.liquidate(id);
        vm.prank(alice);
        vm.expectRevert(stale);
        trading.closePosition(id);
        vm.prank(alice);
        vm.expectRevert(stale);
        trading.openPosition{value: 1 ether}(tide, Side.Long, 20_000);
        Position memory pos = trading.getPosition(id);
        vm.expectRevert(stale);
        risk.isLiquidatable(pos);
        vm.expectRevert(stale);
        risk.validPrice(tide);

        oracle.setPrice(tide, 0.5 ether); // a fresh push unlocks it
        _liquidate(id);
    }

    function test_staleness_boundaryIsInclusive_andConfigurable() public {
        uint256 pushed = block.timestamp;
        vm.warp(pushed + 1 hours);
        assertEq(risk.validPrice(tide), P0, "exactly maxPriceAge old is still valid");

        vm.prank(owner);
        risk.setMaxPriceAge(10 minutes);
        vm.expectRevert(abi.encodeWithSelector(StalePrice.selector, tide, pushed));
        risk.validPrice(tide);
    }

    function test_maxPriceAge_ownerOnly_nonZero() public {
        assertEq(risk.maxPriceAge(), 1 hours);
        vm.prank(alice);
        vm.expectRevert();
        risk.setMaxPriceAge(1);
        vm.prank(owner);
        vm.expectRevert(InvalidRiskConfig.selector);
        risk.setMaxPriceAge(0);
    }

    function test_validPrice_missingPrice() public {
        address unknown = makeAddr("unknown");
        vm.expectRevert(abi.encodeWithSelector(NoPrice.selector, unknown));
        risk.validPrice(unknown);
    }

    /*//////////////////////////////// fuzz ////////////////////////////////*/

    /// @dev Whatever the leverage, side and price: liquidate when allowed, otherwise close. Either way the pool debt
    ///      is cleared, LPs only ever lose the price-gap shortfall, and the books balance.
    function testFuzz_liquidateOrClose_poolProtected(uint96 collateral, uint32 lev, bool long, uint96 exitPrice)
        public
    {
        collateral = uint96(bound(collateral, 0.01 ether, 12 ether));
        lev = uint32(bound(lev, 10_000, 70_000));
        exitPrice = uint96(bound(exitPrice, 1, 5 ether));

        uint256 id = _open(long ? Side.Long : Side.Short, collateral, lev);
        oracle.setPrice(tide, exitPrice);

        uint256 borrowed = trading.getPosition(id).borrowed;
        bool liquidatable = risk.isLiquidatable(trading.getPosition(id));
        if (liquidatable) {
            _liquidate(id);
            assertGe(pool.totalDeposits() + borrowed, 500 ether, "LPs lose at most the borrowed amount");
            assertLe(pool.totalDeposits(), 500 ether + collateral, "and gain at most the collateral");
        } else {
            vm.prank(keeper);
            vm.expectRevert(NotLiquidatable.selector);
            trading.liquidate(id);
            vm.prank(alice);
            trading.closePosition(id);
            assertEq(pool.totalDeposits(), 500 ether, "a normal close never costs the pool anything");
        }
        _assertBooksBalance();
    }
}
