// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {MarginPool} from "../src/MarginPool.sol";
import {
    BelowMinimumDeposit,
    ExceedsUtilizationCap,
    InsufficientLiquidity,
    InsufficientShares,
    InvalidRepayment,
    LossExceedsBorrowed,
    NotMarginTrading,
    NothingToClaim,
    RepayExceedsBorrowed,
    ZeroAmount
} from "../src/Errors.sol";

/// @dev Stands in for MarginTrading: it can receive ETH and forwards calls to the pool.
contract Borrower {
    MarginPool public immutable pool;

    constructor(MarginPool p) {
        pool = p;
    }

    receive() external payable {}

    function borrow(uint256 a) external {
        pool.borrow(a);
    }

    function repay(uint256 principal, uint256 profit) external payable {
        pool.repay{value: msg.value}(principal, profit);
    }

    function absorb(uint256 a) external {
        pool.absorbLoss(a);
    }
}

/// @dev An LP that tries to re-enter the pool while being paid.
contract ReentrantLP {
    MarginPool public immutable pool;
    bool public reentryBlocked;

    constructor(MarginPool p) {
        pool = p;
    }

    function deposit() external payable {
        pool.deposit{value: msg.value}();
    }

    function withdraw(uint256 a) external {
        pool.withdraw(a);
    }

    receive() external payable {
        try pool.deposit{value: 0.01 ether}() {}
        catch {
            reentryBlocked = true;
        }
    }
}

contract MarginPoolPhase2Test is Test {
    MarginPool internal pool;
    Borrower internal trading;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        pool = new MarginPool(owner);
        trading = new Borrower(pool);
        vm.prank(owner);
        pool.setMarginTrading(address(trading));
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
        vm.deal(address(trading), 1_000 ether); // trader collateral/profit to pay back with
    }

    function _deposit(address who, uint256 amount) internal {
        vm.deal(who, who.balance + amount);
        vm.prank(who);
        pool.deposit{value: amount}();
    }

    /*//////////////////////////////// deposit ////////////////////////////////*/

    function test_deposit_firstDepositorGetsOneToOneShares() public {
        _deposit(alice, 500 ether); // the demo pool starts at 500 ETH
        assertEq(pool.sharesOf(alice), 500 ether);
        assertEq(pool.totalShares(), 500 ether);
        assertEq(pool.totalDeposits(), 500 ether);
        assertEq(pool.availableLiquidity(), 500 ether);
        assertEq(pool.assetsOf(alice), 500 ether);
    }

    function test_deposit_sharesAreProportional() public {
        _deposit(alice, 300 ether);
        _deposit(bob, 100 ether);
        assertEq(pool.sharesOf(bob) * 3, pool.sharesOf(alice));
        assertEq(pool.assetsOf(bob), 100 ether);
    }

    function test_deposit_belowMinimumReverts() public {
        vm.prank(alice);
        vm.expectRevert(BelowMinimumDeposit.selector);
        pool.deposit{value: 0.0099 ether}();
        _deposit(alice, 0.01 ether);
    }

    function test_deposit_afterLoss_mintsMoreSharesPerEth() public {
        _deposit(alice, 100 ether);
        trading.borrow(50 ether);
        trading.absorb(50 ether); // pool value halves: 100 -> 50 for 100 shares
        _deposit(bob, 50 ether);
        assertEq(pool.sharesOf(bob), 100 ether);
        assertEq(pool.assetsOf(bob), 50 ether);
        assertEq(pool.assetsOf(alice), 50 ether);
    }

    /*//////////////////////////////// withdraw ////////////////////////////////*/

    function test_withdraw_fullWhenNothingBorrowed() public {
        _deposit(alice, 100 ether);
        uint256 before = alice.balance;
        vm.prank(alice);
        pool.withdraw(100 ether);
        assertEq(alice.balance, before + 100 ether);
        assertEq(pool.totalShares(), 0);
        assertEq(pool.totalDeposits(), 0);
    }

    function test_withdraw_cannotExceedOwnAssets() public {
        _deposit(alice, 100 ether);
        _deposit(bob, 100 ether);
        vm.prank(alice);
        vm.expectRevert(InsufficientShares.selector);
        pool.withdraw(100 ether + 1);
        vm.prank(alice);
        vm.expectRevert(ZeroAmount.selector);
        pool.withdraw(0);
    }

    function test_withdraw_cannotTakeLentEth() public {
        _deposit(alice, 100 ether);
        trading.borrow(50 ether);
        vm.prank(alice);
        vm.expectRevert(InsufficientLiquidity.selector);
        pool.withdraw(50 ether + 1);
    }

    function test_withdraw_respectsNinetyPercentCap() public {
        _deposit(alice, 100 ether);
        trading.borrow(50 ether);
        // Remaining deposits must stay >= 50 / 0.9 = 55.5555... ETH, so at most 44.4444... ETH may leave.
        uint256 room = pool.maxWithdrawable(alice);
        assertEq(room, 100 ether - (uint256(50 ether) * 10_000 + 8_999) / 9_000);

        vm.prank(alice);
        vm.expectRevert(ExceedsUtilizationCap.selector);
        pool.withdraw(room + 1);

        vm.prank(alice);
        pool.withdraw(room);
        assertLe(pool.utilizationBps(), 9_000);
    }

    function test_withdraw_zeroWhenFullyUtilized() public {
        _deposit(alice, 100 ether);
        trading.borrow(90 ether);
        assertEq(pool.utilizationBps(), 9_000);
        assertEq(pool.maxWithdrawable(alice), 0);
    }

    /*//////////////////////////////// borrow / repay ////////////////////////////////*/

    function test_borrow_enforcesNinetyPercentUtilization() public {
        _deposit(alice, 500 ether);
        assertEq(pool.maxBorrowable(), 450 ether);
        trading.borrow(450 ether);
        assertEq(pool.totalBorrowed(), 450 ether);
        assertEq(pool.availableLiquidity(), 50 ether);
        assertEq(pool.utilizationBps(), 9_000);
        vm.expectRevert(ExceedsUtilizationCap.selector);
        trading.borrow(1);
    }

    function test_borrow_sendsEthToMarginTrading() public {
        _deposit(alice, 100 ether);
        uint256 before = address(trading).balance;
        trading.borrow(10 ether);
        assertEq(address(trading).balance, before + 10 ether);
        assertEq(address(pool).balance, 90 ether);
    }

    function test_repay_principalOnly_restoresLiquidity() public {
        _deposit(alice, 100 ether);
        trading.borrow(40 ether);
        trading.repay{value: 40 ether}(40 ether, 0);
        assertEq(pool.totalBorrowed(), 0);
        assertEq(pool.availableLiquidity(), 100 ether);
        assertEq(pool.rewardReserve(), 0);
    }

    function test_repay_profitPaysFivePercentToLps() public {
        _deposit(alice, 100 ether);
        trading.borrow(40 ether);
        // A 10 ETH profit: LPs get 5% = 0.5 ETH on top of the principal.
        assertEq(pool.profitShare(10 ether), 0.5 ether);
        trading.repay{value: 40.5 ether}(40 ether, 10 ether);
        assertEq(pool.rewardReserve(), 0.5 ether);
        assertEq(pool.pendingRewardsOf(alice), 0.5 ether);
        assertEq(pool.totalDeposits(), 100 ether, "rewards do not inflate deposits");
    }

    function test_repay_wrongValueOrTooMuchPrincipalReverts() public {
        _deposit(alice, 100 ether);
        trading.borrow(40 ether);
        vm.expectRevert(InvalidRepayment.selector);
        trading.repay{value: 40 ether}(40 ether, 10 ether); // forgot the reward
        vm.expectRevert(InvalidRepayment.selector);
        trading.repay{value: 41 ether}(40 ether, 0); // overpaid
        vm.expectRevert(RepayExceedsBorrowed.selector);
        trading.repay{value: 41 ether}(41 ether, 0);
    }

    /*//////////////////////////////// rewards ////////////////////////////////*/

    function test_rewards_areProportionalToShares() public {
        _deposit(alice, 300 ether);
        _deposit(bob, 100 ether);
        trading.borrow(100 ether);
        trading.repay{value: 102 ether}(100 ether, 40 ether); // reward = 2 ETH

        assertEq(pool.pendingRewardsOf(alice), 1.5 ether);
        assertEq(pool.pendingRewardsOf(bob), 0.5 ether);

        uint256 before = alice.balance;
        vm.prank(alice);
        pool.claimRewards();
        assertEq(alice.balance, before + 1.5 ether);
        assertEq(pool.pendingRewardsOf(alice), 0);
        assertEq(pool.pendingRewardsOf(bob), 0.5 ether);
        assertEq(pool.rewardReserve(), 0.5 ether);

        vm.prank(alice);
        vm.expectRevert(NothingToClaim.selector);
        pool.claimRewards();
    }

    function test_rewards_lateDepositorGetsNothingFromEarlierProfit() public {
        _deposit(alice, 100 ether);
        trading.borrow(50 ether);
        trading.repay{value: 51 ether}(50 ether, 20 ether); // 1 ETH reward
        _deposit(carol, 100 ether);
        assertEq(pool.pendingRewardsOf(carol), 0);
        assertEq(pool.pendingRewardsOf(alice), 1 ether);

        // A second profit is shared 50/50 now.
        trading.borrow(50 ether);
        trading.repay{value: 51 ether}(50 ether, 20 ether);
        assertEq(pool.pendingRewardsOf(carol), 0.5 ether);
        assertEq(pool.pendingRewardsOf(alice), 1.5 ether);
    }

    function test_rewards_survivePartialAndFullWithdrawal() public {
        _deposit(alice, 100 ether);
        trading.borrow(10 ether);
        trading.repay{value: 10.5 ether}(10 ether, 10 ether);
        vm.prank(alice);
        pool.withdraw(100 ether);
        assertEq(pool.sharesOf(alice), 0);
        assertEq(pool.pendingRewardsOf(alice), 0.5 ether, "earned rewards stay claimable after exiting");
        vm.prank(alice);
        pool.claimRewards();
        assertEq(pool.rewardReserve(), 0);
    }

    /*//////////////////////////////// absorbLoss ////////////////////////////////*/

    function test_absorbLoss_isSharedProRata() public {
        _deposit(alice, 300 ether);
        _deposit(bob, 100 ether);
        trading.borrow(40 ether);
        trading.absorb(20 ether);
        assertEq(pool.totalBorrowed(), 20 ether);
        assertEq(pool.totalDeposits(), 380 ether);
        assertEq(pool.assetsOf(alice), 285 ether);
        assertEq(pool.assetsOf(bob), 95 ether);
    }

    function test_absorbLoss_cannotExceedBorrowed() public {
        _deposit(alice, 100 ether);
        trading.borrow(10 ether);
        vm.expectRevert(LossExceedsBorrowed.selector);
        trading.absorb(10 ether + 1);
        vm.expectRevert(ZeroAmount.selector);
        trading.absorb(0);
    }

    function test_absorbLoss_keepsUtilizationUnderCap() public {
        _deposit(alice, 100 ether);
        trading.borrow(90 ether);
        trading.absorb(45 ether);
        assertLe(pool.utilizationBps(), 9_000);
    }

    /*//////////////////////////////// access, pause, reentrancy ////////////////////////////////*/

    function test_onlyMarginTradingMayMoveBorrowedMoney() public {
        _deposit(alice, 100 ether);
        vm.deal(owner, 1 ether);
        vm.startPrank(owner);
        vm.expectRevert(NotMarginTrading.selector);
        pool.borrow(1 ether);
        vm.expectRevert(NotMarginTrading.selector);
        pool.absorbLoss(1 ether);
        vm.expectRevert(NotMarginTrading.selector);
        pool.repay{value: 1}(1, 0);
        vm.stopPrank();
    }

    function test_pause_stopsEverything_andUnpauseResumes() public {
        _deposit(alice, 100 ether);
        vm.prank(owner);
        pool.pause();

        vm.startPrank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.deposit{value: 1 ether}();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.withdraw(1 ether);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.claimRewards();
        vm.stopPrank();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        trading.borrow(1 ether);

        vm.prank(owner);
        pool.unpause();
        vm.prank(alice);
        pool.withdraw(1 ether);
    }

    function test_withdraw_isReentrancyProtected() public {
        ReentrantLP lp = new ReentrantLP(pool);
        vm.deal(address(lp), 10 ether);
        lp.deposit{value: 10 ether}();
        lp.withdraw(5 ether);
        assertTrue(lp.reentryBlocked(), "the re-entrant deposit during payout must revert");
        assertEq(pool.totalDeposits(), 5 ether);
    }

    function test_forcedEth_doesNotChangeSharePrice() public {
        _deposit(alice, 100 ether);
        vm.deal(address(pool), address(pool).balance + 50 ether); // ETH sent without deposit()
        _deposit(bob, 100 ether);
        assertEq(pool.sharesOf(bob), 100 ether, "share price is unaffected by stray ETH");
        assertEq(pool.assetsOf(bob), 100 ether);
    }

    /*//////////////////////////////// fuzz ////////////////////////////////*/

    /// @dev Random sequences of every pool action must keep the books balanced and the cap intact.
    function testFuzz_randomActions_keepInvariants(uint256[24] memory seeds) public {
        for (uint256 i; i < seeds.length; ++i) {
            uint256 s = seeds[i];
            uint256 kind = s % 6;
            uint256 v = s >> 8;
            address lp = (s >> 4) % 2 == 0 ? alice : bob;

            if (kind == 0) {
                _deposit(lp, bound(v, 0.01 ether, 200 ether));
            } else if (kind == 1) {
                uint256 room = pool.maxBorrowable();
                if (room > 0) trading.borrow(bound(v, 1, room));
            } else if (kind == 2) {
                uint256 b = pool.totalBorrowed();
                if (b > 0) {
                    uint256 principal = bound(v, 1, b);
                    uint256 profit = (v >> 20) % 50 ether;
                    trading.repay{value: principal + pool.profitShare(profit)}(principal, profit);
                }
            } else if (kind == 3) {
                uint256 b = pool.totalBorrowed();
                if (b > 0) trading.absorb(bound(v, 1, b));
            } else if (kind == 4) {
                uint256 m = pool.maxWithdrawable(lp);
                if (m > 0) {
                    vm.prank(lp);
                    pool.withdraw(bound(v, 1, m));
                }
            } else if (pool.pendingRewardsOf(lp) > 0) {
                vm.prank(lp);
                pool.claimRewards();
            }

            assertLe(pool.totalBorrowed() * 10_000, pool.totalDeposits() * 9_000, "90% cap");
            assertGe(
                address(pool).balance,
                pool.totalDeposits() - pool.totalBorrowed() + pool.rewardReserve(),
                "pool can always pay what it owes"
            );
            assertGe(pool.rewardReserve() + 50, pool.pendingRewardsOf(alice) + pool.pendingRewardsOf(bob), "rounding dust only");
            assertLe(pool.assetsOf(alice) + pool.assetsOf(bob), pool.totalDeposits());
        }
    }
}
