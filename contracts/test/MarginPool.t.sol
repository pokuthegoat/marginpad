// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {stdStorage, StdStorage} from "forge-std/Test.sol";

import {ProtocolParams} from "../src/ProtocolParams.sol";
import {BaseTest} from "./BaseTest.sol";

/// @notice The pool's read-only accounting views (the part of the pool that exists in Phase 1). Phase 2 moves the
///         numbers with deposit/borrow/repay; these tests pin down what the numbers mean.
contract MarginPoolViewsTest is BaseTest {
    using stdStorage for StdStorage;

    function _seed(uint256 deposits, uint256 borrowed) internal {
        stdstore.target(address(pool)).sig("totalDeposits()").checked_write(deposits);
        stdstore.target(address(pool)).sig("totalBorrowed()").checked_write(borrowed);
    }

    function test_emptyPool_isAllZeros_withoutDividingByZero() public view {
        assertEq(pool.availableLiquidity(), 0);
        assertEq(pool.utilizationBps(), 0);
        assertEq(pool.maxBorrowable(), 0);
    }

    function test_halfBorrowed() public {
        _seed(1000 ether, 500 ether);
        assertEq(pool.availableLiquidity(), 500 ether);
        assertEq(pool.utilizationBps(), 5_000);
        assertEq(pool.maxBorrowable(), 400 ether, "90% cap of 1000 = 900, minus 500 already lent");
    }

    function test_atTheUtilizationCap_nothingMoreCanBeBorrowed() public {
        _seed(1000 ether, 900 ether);
        assertEq(pool.utilizationBps(), ProtocolParams.MAX_UTILIZATION_BPS);
        assertEq(pool.maxBorrowable(), 0);
        assertEq(pool.availableLiquidity(), 100 ether, "ETH is still there, but the cap keeps it un-lendable");
    }

    function test_afterABadDebtLoss_theViewsNeverRevert() public {
        _seed(100 ether, 150 ether); // more lent than the pool now holds
        assertEq(pool.availableLiquidity(), 0);
        assertEq(pool.maxBorrowable(), 0);
        assertEq(pool.utilizationBps(), 15_000);
    }

    /// @dev Matches the demo's borrowRoom(): min over the utilization cap (the per-market cap comes in Phase 2).
    function testFuzz_views_neverBreakTheInvariants(uint96 deposits, uint96 borrowed) public {
        _seed(deposits, borrowed);
        uint256 cap = (uint256(deposits) * ProtocolParams.MAX_UTILIZATION_BPS) / ProtocolParams.BPS;

        assertLe(pool.availableLiquidity(), deposits, "never more available than deposited");
        assertLe(pool.maxBorrowable(), pool.availableLiquidity() + 1, "borrowable never exceeds what is available");

        if (borrowed < cap) {
            assertEq(pool.maxBorrowable(), cap - borrowed);
            assertLe(uint256(borrowed) + pool.maxBorrowable(), cap, "borrowing the maximum lands exactly on the cap");
        } else {
            assertEq(pool.maxBorrowable(), 0, "at or over the cap there is nothing to borrow");
        }
        if (deposits == 0) assertEq(pool.utilizationBps(), 0);
    }
}
