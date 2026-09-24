// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IRiskManager} from "../src/interfaces/IRiskManager.sol";
import {MarginPool} from "../src/MarginPool.sol";
import {MarginTrading} from "../src/MarginTrading.sol";
import {RiskManager} from "../src/RiskManager.sol";
import {OwnerPriceOracle} from "../src/oracles/OwnerPriceOracle.sol";
import {Position, PositionStatus, Side} from "../src/Types.sol";
import {
    HoldPeriodNotElapsed,
    InvalidRiskConfig,
    MarketDisabled,
    MarketIsGraduated,
    MarketNotGraduated,
    NoPrice,
    NotLiquidatable,
    NotUpdater,
    PriceFrozen,
    StalePrice,
    ZeroAddress
} from "../src/Errors.sol";

/// @notice Production protections: keeper-updated oracle, freshness, move limit, pause, graduation, hold time, reserve.
///         Uses the REAL OwnerPriceOracle end to end (the older test files use a mock).
contract ProductionHardeningTest is Test {
    OwnerPriceOracle internal oracle;
    RiskManager internal risk;
    MarginPool internal pool;
    MarginTrading internal trading;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal lp = makeAddr("lp");
    address internal market = makeAddr("PONS_TOKEN");

    uint256 internal constant P0 = 1 ether;

    event PriceUpdated(address indexed market, uint256 price);
    event PriceRejected(address indexed market, uint256 attemptedPrice, uint256 currentPrice, uint8 reason);
    event UpdaterChanged(address indexed previousUpdater, address indexed newUpdater);
    event MarketGraduated(address indexed market, uint256 finalPrice);
    event ReserveFunded(address indexed by, uint256 amount, uint256 reserveAfter);
    event ReserveWithdrawn(address indexed to, uint256 amount, uint256 reserveAfter);
    event ProfitCapped(uint256 indexed id, uint256 wanted, uint256 paid);

    function setUp() public {
        oracle = new OwnerPriceOracle(owner);
        risk = new RiskManager(owner, oracle);
        pool = new MarginPool(owner);
        trading = new MarginTrading(pool, risk, owner);
        vm.startPrank(owner);
        pool.setMarginTrading(address(trading));
        oracle.setUpdater(keeper); // production shape: the owner is not the price pusher
        // Conservative Pons market: 2x max, 8% maintenance, 5 ETH cap.
        risk.setMarketRisk(market, IRiskManager.MarketRisk(true, 20_000, 800, 5 ether));
        trading.setMinHoldSeconds(300);
        vm.deal(owner, 50 ether);
        trading.fundReserve{value: 10 ether}();
        vm.stopPrank();

        vm.deal(lp, 100 ether);
        vm.prank(lp);
        pool.deposit{value: 100 ether}();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);

        vm.prank(keeper);
        oracle.setPrice(market, uint128(P0));
    }

    function _push(uint256 price) internal returns (bool ok) {
        vm.prank(keeper);
        ok = oracle.setPrice(market, uint128(price));
    }

    function _open(address who, Side side) internal returns (uint256 id) {
        vm.prank(who);
        id = trading.openPosition{value: 1 ether}(market, side, 20_000);
    }

    /*//////////////////////////////// updater role ////////////////////////////////*/

    function test_unauthorizedUpdaterRejected_evenTheOwner() public {
        vm.prank(alice);
        vm.expectRevert(NotUpdater.selector);
        oracle.setPrice(market, 1);
        vm.prank(owner);
        vm.expectRevert(NotUpdater.selector);
        oracle.setPrice(market, 1);
        vm.prank(alice);
        vm.expectRevert(NotUpdater.selector);
        oracle.markGraduated(market);
    }

    function test_authorizedUpdaterSucceeds_andEmits() public {
        vm.expectEmit(true, false, false, true, address(oracle));
        emit PriceUpdated(market, 1.1 ether);
        assertTrue(_push(1.1 ether));
        (uint256 price, uint256 at) = oracle.getPrice(market);
        assertEq(price, 1.1 ether);
        assertEq(at, block.timestamp);
    }

    function test_updaterRotation() public {
        address newKeeper = makeAddr("newKeeper");
        vm.prank(alice);
        vm.expectRevert(); // only the owner rotates
        oracle.setUpdater(newKeeper);
        vm.prank(owner);
        vm.expectRevert(ZeroAddress.selector);
        oracle.setUpdater(address(0));

        vm.expectEmit(true, true, false, false, address(oracle));
        emit UpdaterChanged(keeper, newKeeper);
        vm.prank(owner);
        oracle.setUpdater(newKeeper);

        assertFalse(_tryPush(keeper), "the old keeper is locked out");
        vm.prank(newKeeper);
        assertTrue(oracle.setPrice(market, 1.05 ether));
    }

    function _tryPush(address who) internal returns (bool ok) {
        vm.prank(who);
        try oracle.setPrice(market, 1.01 ether) returns (bool) {
            return true;
        } catch {
            return false;
        }
    }

    /*//////////////////////////////// move limit ////////////////////////////////*/

    function test_excessiveMove_isRejected_priceUnchanged_eventEmitted() public {
        vm.expectEmit(true, false, false, true, address(oracle));
        emit PriceRejected(market, 1.3 ether, P0, 1); // +30% > 20% limit
        assertFalse(_push(1.3 ether));
        (uint256 price,) = oracle.getPrice(market);
        assertEq(price, P0, "a rejected update changes nothing");

        vm.expectEmit(true, false, false, true, address(oracle));
        emit PriceRejected(market, 0.7 ether, P0, 1); // -30%
        assertFalse(_push(0.7 ether));

        assertTrue(_push(1.2 ether), "exactly at the limit is accepted");
        assertTrue(_push(0.96 ether), "and so is a 20% drop");
    }

    function test_priceCanStepTowardATarget_notJumpToIt() public {
        // A pump to 2x cannot land in one update; it takes several bounded steps.
        assertFalse(_push(2 ether));
        uint256 steps;
        uint256 p = P0;
        while (p < 2 ether) {
            p = (p * 12) / 10;
            assertTrue(_push(p));
            ++steps;
        }
        assertGe(steps, 4);
    }

    function test_firstPriceOfAMarketHasNothingToCompareAgainst() public {
        address fresh = makeAddr("fresh");
        vm.prank(keeper);
        assertTrue(oracle.setPrice(fresh, 123));
    }

    function test_maxMove_isOwnerOnly_andBounded() public {
        vm.prank(alice);
        vm.expectRevert();
        oracle.setMaxMoveBps(500);
        vm.startPrank(owner);
        vm.expectRevert(InvalidRiskConfig.selector);
        oracle.setMaxMoveBps(0);
        vm.expectRevert(InvalidRiskConfig.selector);
        oracle.setMaxMoveBps(10_000_001);
        oracle.setMaxMoveBps(500); // 5%
        vm.stopPrank();
        assertFalse(_push(1.06 ether));
        assertTrue(_push(1.05 ether));
    }

    function testFuzz_priceNeverMovesMoreThanTheLimit(uint128 attempted) public {
        attempted = uint128(bound(attempted, 1, type(uint128).max));
        vm.prank(keeper);
        bool ok = oracle.setPrice(market, attempted);
        (uint256 price,) = oracle.getPrice(market);
        if (ok) {
            uint256 diff = attempted > P0 ? attempted - P0 : P0 - attempted;
            assertLe(diff * 10_000, P0 * oracle.maxMoveBps());
            assertEq(price, attempted);
        } else {
            assertEq(price, P0);
        }
    }

    /*//////////////////////////////// pause ////////////////////////////////*/

    function test_oraclePause_stopsUpdatesAndHaltsPricing_thenResumes() public {
        vm.prank(owner);
        oracle.pause();
        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        oracle.setPrice(market, 1.05 ether);
        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        oracle.markGraduated(market);
        (uint256 price,) = oracle.getPrice(market);
        assertEq(price, 0, "paused = no price");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NoPrice.selector, market));
        trading.openPosition{value: 1 ether}(market, Side.Long, 20_000);

        vm.prank(owner);
        oracle.unpause();
        _open(alice, Side.Long); // reopens once the oracle is back
    }

    function test_onlyOwnerPausesTheOracle() public {
        vm.prank(keeper);
        vm.expectRevert();
        oracle.pause();
    }

    /*//////////////////////////////// staleness ////////////////////////////////*/

    function test_stalePrice_rejectedOnOpen_thenReopensAfterAValidUpdate() public {
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StalePrice.selector, market, block.timestamp - 1 hours - 1));
        trading.openPosition{value: 1 ether}(market, Side.Long, 20_000);

        assertTrue(_push(1.05 ether)); // a valid, fresh update
        _open(alice, Side.Long);
    }

    function test_stalePrice_rejectedOnLiquidation_andClose() public {
        uint256 id = _open(alice, Side.Long);
        // walk the price down in bounded steps until the long is past its liquidation price (2x, 8%: -42%)
        uint256 p = P0;
        while (p > 0.55 ether) {
            p = (p * 85) / 100;
            assertTrue(_push(p));
        }
        uint256 pushedAt = block.timestamp;
        vm.warp(pushedAt + 1 hours + 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(StalePrice.selector, market, pushedAt));
        trading.liquidate(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StalePrice.selector, market, pushedAt));
        trading.closePosition(id);

        assertTrue(_push(p)); // fresh again
        vm.prank(bob);
        trading.liquidate(id);
    }

    function test_maxPriceAge_isBounded() public {
        vm.startPrank(owner);
        vm.expectRevert(InvalidRiskConfig.selector);
        risk.setMaxPriceAge(9);
        vm.expectRevert(InvalidRiskConfig.selector);
        risk.setMaxPriceAge(7 days + 1);
        risk.setMaxPriceAge(60);
        vm.stopPrank();
        vm.warp(block.timestamp + 61);
        vm.expectRevert();
        risk.validPrice(market);
    }

    /*//////////////////////////////// disabled market ////////////////////////////////*/

    function test_disabledMarket_blocksOpening_reenableReopens() public {
        vm.prank(owner);
        risk.setMarketRisk(market, IRiskManager.MarketRisk(false, 20_000, 800, 5 ether));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MarketDisabled.selector, market));
        trading.openPosition{value: 1 ether}(market, Side.Long, 20_000);

        vm.prank(owner);
        risk.setMarketRisk(market, IRiskManager.MarketRisk(true, 20_000, 800, 5 ether));
        _open(alice, Side.Long);
    }

    /*//////////////////////////////// graduation ////////////////////////////////*/

    function test_nonGraduatedMarket_tradesNormally() public {
        assertFalse(risk.isGraduated(market));
        uint256 id = _open(alice, Side.Long);
        vm.warp(block.timestamp + 301);
        assertTrue(_push(1.1 ether));
        vm.prank(alice);
        trading.closePosition(id);
    }

    function test_graduation_isUpdaterOnly_andNeedsAPrice() public {
        vm.prank(alice);
        vm.expectRevert(NotUpdater.selector);
        oracle.markGraduated(market);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(NoPrice.selector, address(0xDEAD)));
        oracle.markGraduated(address(0xDEAD)); // no price ever set: not a valid graduation
    }

    function test_graduated_blocksNewPositions_andFurtherPriceUpdates() public {
        vm.expectEmit(true, false, false, true, address(oracle));
        emit MarketGraduated(market, P0);
        vm.prank(keeper);
        oracle.markGraduated(market);
        assertTrue(risk.isGraduated(market));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MarketIsGraduated.selector, market));
        trading.openPosition{value: 1 ether}(market, Side.Long, 20_000);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PriceFrozen.selector, market));
        oracle.setPrice(market, 1.1 ether);
    }

    function test_graduated_priceIsAFrozenFinalValue_notAStaleLivePrice() public {
        vm.prank(keeper);
        oracle.markGraduated(market);
        vm.warp(block.timestamp + 30 days);
        assertEq(risk.validPrice(market), P0, "explicit frozen settlement price, never a silent stale read");
        // ...whereas a NON-graduated market with the same age is rejected:
        address other = makeAddr("other");
        vm.prank(keeper);
        oracle.setPrice(other, 5);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert();
        risk.validPrice(other);
    }

    function test_graduated_openPositionsCloseWithoutHoldTime_andAnyoneCanSettle() public {
        uint256 a = _open(alice, Side.Long);
        uint256 b = _open(bob, Side.Short);
        vm.prank(keeper);
        oracle.markGraduated(market);

        // The owner may exit immediately (no hold period on a graduated market)...
        vm.prank(alice);
        trading.closePosition(a);
        // ...and a stranger can settle the other position, but the money goes to its owner.
        uint256 before = bob.balance;
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        trading.settleGraduated(b);
        assertEq(bob.balance, before + 1 ether, "unchanged price: collateral back");
        assertEq(stranger.balance, 0);
        assertEq(uint8(trading.getPosition(b).status), uint8(PositionStatus.Closed));
        assertEq(pool.totalBorrowed(), 0);
    }

    function test_settleGraduated_rejectsLiveMarkets() public {
        uint256 id = _open(alice, Side.Long);
        vm.expectRevert(abi.encodeWithSelector(MarketNotGraduated.selector, market));
        trading.settleGraduated(id);
    }

    /*//////////////////////////////// hold time / manipulation ////////////////////////////////*/

    function test_minimumHold_blocksImmediateClose() public {
        uint256 id = _open(alice, Side.Long);
        uint256 readyAt = block.timestamp + 300;
        assertTrue(_push(1.2 ether)); // the "pumped" price arrives right after opening
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HoldPeriodNotElapsed.selector, readyAt));
        trading.closePosition(id);

        vm.warp(readyAt);
        assertTrue(_push(1.2 ether));
        vm.prank(alice);
        trading.closePosition(id);
    }

    function test_holdPeriod_doesNotDelayLiquidation() public {
        uint256 id = _open(alice, Side.Long);
        uint256 p = P0;
        while (p > 0.55 ether) {
            p = (p * 85) / 100;
            assertTrue(_push(p));
        }
        vm.prank(bob);
        trading.liquidate(id); // immediately, well inside the hold period
        assertEq(uint8(trading.getPosition(id).status), uint8(PositionStatus.Liquidated));
    }

    function test_pumpAndClose_cannotBeDoneInOneStep() public {
        // Attack: open, pump the thin curve, oracle jumps, close. The jump is rejected outright,
        // and the multi-step path is slower than the hold period.
        uint256 id = _open(alice, Side.Long);
        assertFalse(_push(2 ether));
        vm.prank(alice);
        vm.expectRevert();
        trading.closePosition(id);
    }

    function test_minHold_setter_isOwnerOnly_andBounded() public {
        vm.prank(alice);
        vm.expectRevert();
        trading.setMinHoldSeconds(1);
        vm.prank(owner);
        vm.expectRevert(InvalidRiskConfig.selector);
        trading.setMinHoldSeconds(1 days + 1);
        vm.prank(owner);
        trading.setMinHoldSeconds(0);
        uint256 id = _open(alice, Side.Long);
        vm.prank(alice);
        trading.closePosition(id); // no hold: immediate close works
    }

    /*//////////////////////////////// settlement reserve ////////////////////////////////*/

    function test_reserve_funding_andWithdrawal_areOwnerOnly_andEmitEvents() public {
        vm.deal(alice, 5 ether);
        vm.prank(alice);
        vm.expectRevert();
        trading.fundReserve{value: 1 ether}();
        vm.prank(alice);
        vm.expectRevert();
        trading.withdrawReserve(1);

        vm.expectEmit(true, false, false, true, address(trading));
        emit ReserveFunded(owner, 2 ether, 12 ether);
        vm.prank(owner);
        trading.fundReserve{value: 2 ether}();
        vm.expectEmit(true, false, false, true, address(trading));
        emit ReserveWithdrawn(owner, 3 ether, 9 ether);
        vm.prank(owner);
        trading.withdrawReserve(3 ether);
    }

    function test_profit_cannotExceedTheReserve_poolStillRepaid() public {
        vm.prank(owner);
        trading.withdrawReserve(9.9 ether); // 0.1 ETH left
        uint256 id = _open(alice, Side.Long);
        vm.warp(block.timestamp + 301);
        assertTrue(_push(1.2 ether)); // +20% of a 2 ETH position = 0.4 ETH wanted

        vm.expectEmit(true, false, false, true, address(trading));
        emit ProfitCapped(id, 0.4 ether, 0.1 ether);
        uint256 before = alice.balance;
        vm.prank(alice);
        trading.closePosition(id);

        assertEq(alice.balance - before, 1 ether + 0.1 ether - 0.005 ether, "collateral + reserve-backed profit - 5% LP share");
        assertEq(trading.reserve(), 0);
        assertEq(pool.totalBorrowed(), 0, "pool principal repaid in full");
        assertEq(pool.totalDeposits(), 100 ether);
        assertEq(address(trading).balance, trading.reserve());
    }

    function test_booksBalance_afterMixedSettlements() public {
        uint256 a = _open(alice, Side.Long);
        uint256 b = _open(bob, Side.Short);
        vm.warp(block.timestamp + 301);
        assertTrue(_push(1.1 ether));
        vm.prank(alice);
        trading.closePosition(a);
        vm.prank(bob);
        trading.closePosition(b);
        assertEq(pool.totalBorrowed(), 0);
        assertEq(address(pool).balance, pool.totalDeposits() + pool.rewardReserve());
        assertEq(address(trading).balance, trading.reserve());
    }

    /*//////////////////////////////// normal flow ////////////////////////////////*/

    function test_normalOpenAndClose_stillWorks() public {
        uint256 id = _open(alice, Side.Long);
        assertEq(trading.getPosition(id).borrowed, 1 ether);
        vm.warp(block.timestamp + 301);
        assertTrue(_push(P0)); // keep the price fresh
        uint256 before = alice.balance;
        vm.prank(alice);
        trading.closePosition(id);
        assertEq(alice.balance - before, 1 ether);
    }

    function test_healthyPositionCannotBeLiquidated() public {
        uint256 id = _open(alice, Side.Long);
        vm.prank(bob);
        vm.expectRevert(NotLiquidatable.selector);
        trading.liquidate(id);
    }
}
