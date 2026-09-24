// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {IRiskManager} from "../src/interfaces/IRiskManager.sol";

/**
 * @notice Runs the real deploy logic and checks what it built, and that its safety rails hold.
 * @dev Calls `deploy(...)` with plain arguments rather than `run()`, because `run()` reads environment variables and
 *      Foundry runs tests in parallel (env vars are shared, so tests that set them would race). The `run()` path is
 *      exercised end to end against a real local chain instead (see BLOCKCHAIN.md).
 */
contract DeployTest is Test {
    /// @dev Anvil's first account. Public on purpose: fine locally, refused everywhere else by the script.
    uint256 internal constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    /// @dev A different throwaway key (Anvil account 1): stands in for a real private testnet key.
    uint256 internal constant OWN_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    Deploy internal script;

    function setUp() public {
        script = new Deploy();
        vm.deal(vm.addr(ANVIL_KEY), 100 ether);
        vm.deal(vm.addr(OWN_KEY), 100 ether);
    }

    function test_configuresTheFiveDemoMarkets_withPrices() public {
        vm.chainId(31337);
        Deploy.Deployment memory d = script.deploy(ANVIL_KEY, vm.addr(ANVIL_KEY), IPriceOracle(address(0)), false, 0, 0);

        uint32[5] memory lev = [uint32(15_000), 20_000, 40_000, 70_000, 100_000];
        uint128[5] memory cap = [uint128(3 ether), 12 ether, 45 ether, 90 ether, 160 ether];
        uint256[5] memory price = [uint256(0.00042 ether), 0.0087 ether, 0.061 ether, 0.42 ether, 2.85 ether];
        for (uint256 i; i < 5; ++i) {
            IRiskManager.MarketRisk memory r = d.riskManager.marketRisk(d.markets[i]);
            assertTrue(r.enabled);
            assertEq(r.maxLeverageBps, lev[i]);
            assertEq(r.maxBorrow, cap[i]);
            (uint256 p, uint256 at) = d.oracle.getPrice(d.markets[i]);
            assertEq(p, price[i]);
            assertEq(at, block.timestamp);
        }
        assertEq(d.markets[0], script.marketAddress("PLNK"));
    }

    /*//////////////////////////////////////////////////////////////
                                 HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    function test_deploysAndWiresEverything_onLocalAnvil() public {
        vm.chainId(31337);
        address deployer = vm.addr(ANVIL_KEY);
        Deploy.Deployment memory d = script.deploy(ANVIL_KEY, deployer, IPriceOracle(address(0)), false, 5 ether, 1 days);

        assertEq(d.deployer, deployer);
        assertEq(d.pool.marginTrading(), address(d.trading));
        assertEq(address(d.trading.pool()), address(d.pool));
        assertEq(address(d.trading.riskManager()), address(d.riskManager));
        assertEq(address(d.riskManager.oracle()), address(d.oracle), "the testnet oracle is wired in");
        assertEq(d.trading.reserve(), 5 ether, "settlement reserve funded");
        assertEq(d.riskManager.maxPriceAge(), 1 days);
        assertEq(d.pool.owner(), deployer);
        assertEq(d.trading.owner(), deployer);
        assertEq(d.riskManager.owner(), deployer);
        assertGt(address(d.pool).code.length, 0);
        assertGt(address(d.trading).code.length, 0);
        assertGt(address(d.riskManager).code.length, 0);
    }

    function test_deploysToRobinhoodTestnet_withANonPublicKey() public {
        vm.chainId(46630);
        Deploy.Deployment memory d = script.deploy(OWN_KEY, vm.addr(OWN_KEY), IPriceOracle(address(0)), false, 5 ether, 1 days);
        assertEq(d.pool.marginTrading(), address(d.trading));
        assertEq(d.deployer, vm.addr(OWN_KEY));
    }

    function test_ownerOverride_startsAPendingTwoStepTransfer() public {
        vm.chainId(31337);
        address newOwner = makeAddr("multisig");
        Deploy.Deployment memory d = script.deploy(ANVIL_KEY, newOwner, IPriceOracle(address(0)), false, 5 ether, 1 days);

        assertEq(d.pool.owner(), d.deployer, "not the new owner until they accept");
        assertEq(d.pool.pendingOwner(), newOwner);
        assertEq(d.trading.pendingOwner(), newOwner);
        assertEq(d.riskManager.pendingOwner(), newOwner);

        vm.startPrank(newOwner);
        d.pool.acceptOwnership();
        d.trading.acceptOwnership();
        d.riskManager.acceptOwnership();
        vm.stopPrank();
        assertEq(d.pool.owner(), newOwner);
        assertEq(d.trading.owner(), newOwner);
        assertEq(d.riskManager.owner(), newOwner);
    }

    function test_oracle_isPassedToTheRiskManager() public {
        vm.chainId(31337);
        address oracle = makeAddr("oracle");
        Deploy.Deployment memory d = script.deploy(ANVIL_KEY, vm.addr(ANVIL_KEY), IPriceOracle(oracle), false, 0, 0);
        assertEq(address(d.riskManager.oracle()), oracle);
    }

    /*//////////////////////////////////////////////////////////////
                               SAFETY RAILS
    //////////////////////////////////////////////////////////////*/

    /// @dev "Do NOT deploy to mainnet" is enforced in code: only two chain ids are accepted.
    function test_refusesEveryChainExceptAnvilAndRobinhoodTestnet() public {
        uint256[8] memory forbidden = [
            uint256(1), // Ethereum mainnet
            4663, // Robinhood Chain MAINNET
            42161, // Arbitrum One
            8453, // Base
            10, // Optimism
            137, // Polygon
            11155111, // Sepolia (a testnet, but not the one this project targets)
            12345
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            vm.chainId(forbidden[i]);
            vm.expectRevert(abi.encodeWithSelector(Deploy.UnsupportedChain.selector, forbidden[i]));
            script.deploy(OWN_KEY, vm.addr(OWN_KEY), IPriceOracle(address(0)), false, 5 ether, 1 days);
        }
    }

    function test_refusesThePublicAnvilKey_onAnyPublicChain() public {
        vm.chainId(46630);
        vm.expectRevert(Deploy.PublicKeyOnPublicChain.selector);
        script.deploy(ANVIL_KEY, vm.addr(ANVIL_KEY), IPriceOracle(address(0)), false, 5 ether, 1 days);
    }

    function test_theRailsCheckTheChainBeforeAnythingIsDeployed() public {
        vm.chainId(4663);
        uint256 nonceBefore = vm.getNonce(vm.addr(OWN_KEY));
        vm.expectRevert(abi.encodeWithSelector(Deploy.UnsupportedChain.selector, 4663));
        script.deploy(OWN_KEY, vm.addr(OWN_KEY), IPriceOracle(address(0)), false, 5 ether, 1 days);
        assertEq(vm.getNonce(vm.addr(OWN_KEY)), nonceBefore, "nothing was broadcast");
    }
}
