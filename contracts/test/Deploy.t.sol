// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {IRiskManager} from "../src/interfaces/IRiskManager.sol";
import {OwnerPriceOracle} from "../src/oracles/OwnerPriceOracle.sol";

/**
 * @notice Runs the real deploy logic and checks what it built, and that its safety rails hold. Nothing here touches a
 *         real network: the chain id is faked with `vm.chainId`.
 * @dev Calls `deploy(...)` with plain arguments rather than `run()`, because `run()` reads environment variables and
 *      Foundry runs tests in parallel (env vars are shared, so tests that set them would race).
 */
contract DeployTest is Test {
    /// @dev Anvil's first account. Public on purpose: fine locally, refused everywhere else by the script.
    uint256 internal constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    /// @dev A different throwaway key (Anvil account 1): stands in for a real private key.
    uint256 internal constant OWN_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    Deploy internal script;

    function setUp() public {
        script = new Deploy();
        vm.deal(vm.addr(ANVIL_KEY), 100 ether);
        vm.deal(vm.addr(OWN_KEY), 100 ether);
    }

    /// @dev Local-style parameters: deployer owns and updates, demo protection settings.
    function _p(address owner_) internal pure returns (Deploy.Params memory p) {
        p = Deploy.Params({
            owner: owner_,
            oracle: IPriceOracle(address(0)),
            updater: address(0),
            writeFile: false,
            reserve: 5 ether,
            maxPriceAge: 1 days,
            maxMoveBps: 100_000,
            minHoldSeconds: 0,
            mainnetConfirmed: false,
            initialMarkets: new address[](0),
            marketMaxLeverageBps: 15_000,
            marketMaintenanceBps: 1_000,
            marketMaxBorrow: 1 ether
        });
    }

    /// @dev Parameters that satisfy every mainnet rail (used only against a faked chain id).
    function _mainnet() internal returns (Deploy.Params memory p) {
        p = _p(makeAddr("multisig"));
        p.updater = makeAddr("keeper");
        p.reserve = 0;
        p.maxPriceAge = 120;
        p.maxMoveBps = 1_000;
        p.minHoldSeconds = 300;
        p.mainnetConfirmed = true;
    }

    /*//////////////////////////////////////////////////////////////
                                 HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    function test_deploysAndWiresEverything_onLocalAnvil() public {
        vm.chainId(31337);
        address deployer = vm.addr(ANVIL_KEY);
        Deploy.Deployment memory d = script.deploy(ANVIL_KEY, _p(deployer));

        assertEq(d.chainId, 31337);
        assertEq(d.deployer, deployer);
        assertEq(d.pool.marginTrading(), address(d.trading));
        assertEq(address(d.trading.pool()), address(d.pool));
        assertEq(address(d.trading.riskManager()), address(d.riskManager));
        assertEq(address(d.riskManager.oracle()), address(d.oracle), "the oracle is wired in");
        assertEq(d.trading.reserve(), 5 ether, "settlement reserve funded");
        assertEq(d.riskManager.maxPriceAge(), 1 days);
        assertEq(d.pool.owner(), deployer);
        assertEq(d.trading.owner(), deployer);
        assertEq(d.riskManager.owner(), deployer);
        assertGt(address(d.pool).code.length, 0);
    }

    function test_protectionSettingsAreApplied() public {
        vm.chainId(46630);
        Deploy.Deployment memory d = script.deploy(OWN_KEY, _p(vm.addr(OWN_KEY)));
        OwnerPriceOracle o = OwnerPriceOracle(address(d.oracle));
        assertEq(o.maxMoveBps(), 100_000);
        assertEq(d.trading.minHoldSeconds(), 0);

        Deploy.Deployment memory hardened = script.deploy(OWN_KEY, _hardened());
        assertEq(OwnerPriceOracle(address(hardened.oracle)).maxMoveBps(), 1_000);
        assertEq(hardened.trading.minHoldSeconds(), 300);
        assertEq(hardened.riskManager.maxPriceAge(), 120);
    }

    function _hardened() internal returns (Deploy.Params memory p) {
        p = _p(vm.addr(OWN_KEY));
        p.maxPriceAge = 120;
        p.maxMoveBps = 1_000;
        p.minHoldSeconds = 300;
    }

    function test_separateUpdater_isTheOnlyOneWhoCanPushPrices() public {
        vm.chainId(31337);
        address keeper = makeAddr("keeper");
        Deploy.Params memory p = _p(vm.addr(ANVIL_KEY));
        p.updater = keeper;
        Deploy.Deployment memory d = script.deploy(ANVIL_KEY, p);
        OwnerPriceOracle o = OwnerPriceOracle(address(d.oracle));

        assertEq(o.updater(), keeper);
        assertEq(d.updater, keeper);
        vm.prank(vm.addr(ANVIL_KEY)); // the owner/deployer is no longer the price pusher
        vm.expectRevert();
        o.setPrice(d.markets[0], 1);
        vm.prank(keeper);
        assertTrue(o.setPrice(d.markets[0], uint128(0.00043 ether))); // +2.4%, inside the move limit
    }

    function test_configuresTheFiveDemoMarkets_withPrices_andTenXCeiling() public {
        vm.chainId(31337);
        Deploy.Params memory p = _p(vm.addr(ANVIL_KEY));
        p.reserve = 0;
        Deploy.Deployment memory d = script.deploy(ANVIL_KEY, p);

        uint32[5] memory lev = [uint32(15_000), 20_000, 40_000, 70_000, 100_000];
        uint128[5] memory cap = [uint128(3 ether), 12 ether, 45 ether, 90 ether, 160 ether];
        uint256[5] memory price = [uint256(0.00042 ether), 0.0087 ether, 0.061 ether, 0.42 ether, 2.85 ether];
        for (uint256 i; i < 5; ++i) {
            IRiskManager.MarketRisk memory r = d.riskManager.marketRisk(d.markets[i]);
            assertTrue(r.enabled);
            assertEq(r.maxLeverageBps, lev[i]);
            assertLe(r.maxLeverageBps, 100_000, "10x protocol ceiling");
            assertEq(r.maxBorrow, cap[i]);
            (uint256 pr, uint256 at) = d.oracle.getPrice(d.markets[i]);
            assertEq(pr, price[i]);
            assertEq(at, block.timestamp);
        }
        assertEq(d.markets[0], script.marketAddress("PLNK"));
    }

    function test_deploysToRobinhoodTestnet_withANonPublicKey() public {
        vm.chainId(46630);
        Deploy.Deployment memory d = script.deploy(OWN_KEY, _p(vm.addr(OWN_KEY)));
        assertEq(d.pool.marginTrading(), address(d.trading));
        assertEq(d.deployer, vm.addr(OWN_KEY));
    }

    function test_ownerOverride_startsAPendingTwoStepTransfer_includingTheOracle() public {
        vm.chainId(31337);
        address newOwner = makeAddr("multisig");
        Deploy.Deployment memory d = script.deploy(ANVIL_KEY, _p(newOwner));
        OwnerPriceOracle o = OwnerPriceOracle(address(d.oracle));

        assertEq(d.pool.owner(), d.deployer, "not the new owner until they accept");
        assertEq(d.pool.pendingOwner(), newOwner);
        assertEq(d.trading.pendingOwner(), newOwner);
        assertEq(d.riskManager.pendingOwner(), newOwner);
        assertEq(o.pendingOwner(), newOwner);

        vm.startPrank(newOwner);
        d.pool.acceptOwnership();
        d.trading.acceptOwnership();
        d.riskManager.acceptOwnership();
        o.acceptOwnership();
        vm.stopPrank();
        assertEq(d.pool.owner(), newOwner);
        assertEq(o.owner(), newOwner);
    }

    function test_externalOracle_isPassedToTheRiskManager() public {
        vm.chainId(31337);
        address oracle = makeAddr("oracle");
        Deploy.Params memory p = _p(vm.addr(ANVIL_KEY));
        p.oracle = IPriceOracle(oracle);
        p.reserve = 0;
        Deploy.Deployment memory d = script.deploy(ANVIL_KEY, p);
        assertEq(address(d.riskManager.oracle()), oracle);
    }

    /*//////////////////////////////////////////////////////////////
                               SAFETY RAILS
    //////////////////////////////////////////////////////////////*/

    /// @dev Only three chain ids are accepted; everything else reverts (Ethereum, Arbitrum, Base, ...).
    function test_refusesEveryOtherChain() public {
        uint256[7] memory forbidden = [uint256(1), 42161, 8453, 10, 137, 11155111, 12345];
        for (uint256 i; i < forbidden.length; ++i) {
            vm.chainId(forbidden[i]);
            vm.expectRevert(abi.encodeWithSelector(Deploy.UnsupportedChain.selector, forbidden[i]));
            script.deploy(OWN_KEY, _p(vm.addr(OWN_KEY)));
        }
    }

    function test_refusesThePublicAnvilKey_onAnyPublicChain() public {
        vm.chainId(46630);
        vm.expectRevert(Deploy.PublicKeyOnPublicChain.selector);
        script.deploy(ANVIL_KEY, _p(vm.addr(ANVIL_KEY)));
        vm.chainId(4663);
        vm.expectRevert(Deploy.PublicKeyOnPublicChain.selector);
        script.deploy(ANVIL_KEY, _mainnet());
    }

    function test_mainnet_needsExplicitConfirmation() public {
        vm.chainId(4663);
        Deploy.Params memory p = _mainnet();
        p.mainnetConfirmed = false;
        uint256 nonceBefore = vm.getNonce(vm.addr(OWN_KEY));
        vm.expectRevert(Deploy.MainnetNotConfirmed.selector);
        script.deploy(OWN_KEY, p);
        assertEq(vm.getNonce(vm.addr(OWN_KEY)), nonceBefore, "nothing was broadcast");
    }

    function test_mainnet_needsASeparateOwner_andASeparateKeeper() public {
        vm.chainId(4663);
        address deployer = vm.addr(OWN_KEY);

        Deploy.Params memory p = _mainnet();
        p.owner = deployer; // the deployer key must not keep the admin role
        vm.expectRevert(Deploy.MainnetNeedsSeparateOwner.selector);
        script.deploy(OWN_KEY, p);

        p = _mainnet();
        p.updater = address(0);
        vm.expectRevert(Deploy.MainnetNeedsSeparateUpdater.selector);
        script.deploy(OWN_KEY, p);
        p.updater = deployer;
        vm.expectRevert(Deploy.MainnetNeedsSeparateUpdater.selector);
        script.deploy(OWN_KEY, p);
        p.updater = p.owner; // keeper and admin must be different keys
        vm.expectRevert(Deploy.MainnetNeedsSeparateUpdater.selector);
        script.deploy(OWN_KEY, p);

        p = _mainnet();
        p.oracle = IPriceOracle(makeAddr("someOtherOracle"));
        vm.expectRevert(Deploy.MainnetUsesOwnOracle.selector);
        script.deploy(OWN_KEY, p);
    }

    function test_mainnet_initialMarkets_areRegisteredWithConservativeLimits_andHaveNoPrice() public {
        vm.chainId(4663);
        Deploy.Params memory p = _mainnet();
        p.initialMarkets = new address[](2);
        p.initialMarkets[0] = address(script); // any contract stands in for a token
        p.initialMarkets[1] = address(this);
        Deploy.Deployment memory d = script.deploy(OWN_KEY, p);

        for (uint256 i; i < 2; ++i) {
            IRiskManager.MarketRisk memory r = d.riskManager.marketRisk(p.initialMarkets[i]);
            assertTrue(r.enabled);
            assertEq(r.maxLeverageBps, 15_000);
            assertEq(r.maintenanceBps, 1_000);
            assertEq(r.maxBorrow, 1 ether);
            (uint256 price,) = d.oracle.getPrice(p.initialMarkets[i]);
            assertEq(price, 0, "unusable until the keeper pushes the first price");
        }
        assertEq(d.initialMarkets.length, 2);
        assertEq(d.deployedAt, block.timestamp);
    }

    function test_initialMarkets_mustBeContracts_andBounded() public {
        vm.chainId(4663);
        Deploy.Params memory p = _mainnet();
        p.initialMarkets = new address[](1);
        p.initialMarkets[0] = makeAddr("notAContract");
        vm.expectRevert(abi.encodeWithSelector(Deploy.InitialMarketNotAContract.selector, p.initialMarkets[0]));
        script.deploy(OWN_KEY, p);

        p.initialMarkets = new address[](11);
        vm.expectRevert(Deploy.TooManyInitialMarkets.selector);
        script.deploy(OWN_KEY, p);
    }

    function test_mainnet_marketRiskCannotBeAggressive() public {
        vm.chainId(4663);
        Deploy.Params memory p = _mainnet();
        p.marketMaxLeverageBps = 30_000;
        vm.expectRevert(Deploy.MainnetRiskTooAggressive.selector);
        script.deploy(OWN_KEY, p);
        p = _mainnet();
        p.marketMaxBorrow = 6 ether;
        vm.expectRevert(Deploy.MainnetRiskTooAggressive.selector);
        script.deploy(OWN_KEY, p);
    }

    function test_mainnet_whenFullyConfirmed_deploysNoDemoMarketsOrPrices() public {
        vm.chainId(4663);
        Deploy.Params memory p = _mainnet();
        Deploy.Deployment memory d = script.deploy(OWN_KEY, p);
        OwnerPriceOracle o = OwnerPriceOracle(address(d.oracle));

        assertEq(d.chainId, 4663);
        for (uint256 i; i < 5; ++i) assertEq(d.markets[i], address(0), "no demo markets on mainnet");
        assertEq(d.riskManager.marketRisk(script.marketAddress("TIDE")).enabled, false);
        assertEq(o.updater(), p.updater, "the keeper, not the deployer, pushes prices");
        assertEq(o.pendingOwner(), p.owner);
        assertEq(o.maxMoveBps(), 1_000, "10% per update");
        assertEq(d.riskManager.maxPriceAge(), 120);
        assertEq(d.trading.minHoldSeconds(), 300);
        assertEq(d.trading.reserve(), 0, "the owner funds the reserve, not the deploy script");
    }
}
