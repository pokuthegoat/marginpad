// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {IRiskManager} from "../src/interfaces/IRiskManager.sol";
import {MarginPool} from "../src/MarginPool.sol";
import {MarginTrading} from "../src/MarginTrading.sol";
import {RiskManager} from "../src/RiskManager.sol";
import {OwnerPriceOracle} from "../src/oracles/OwnerPriceOracle.sol";

/**
 * @notice Deploys and wires RiskManager, MarginPool, MarginTrading and the keeper-updated OwnerPriceOracle, then applies
 *         the per-chain protection settings. Writes deployments/<chainId>.json (chain, addresses, updater, markets,
 *         risk parameters and protection settings) for the frontend and for review.
 *
 *   Local (anvil):     forge script script/Deploy.s.sol --rpc-url anvil --broadcast
 *   Robinhood testnet: forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast
 *   Robinhood MAINNET: prepared but guarded (see below). It has NOT been run.
 *
 * Environment (see .env.example):
 *   PRIVATE_KEY         required. The deployer. Never commit it; the script never prints it.
 *   OWNER               optional. Final owner/admin of every contract (default: the deployer). Two-step handover.
 *   ORACLE_UPDATER      optional. The keeper allowed to push prices (default: the deployer, or REQUIRED on mainnet).
 *   ORACLE              optional. Use this price source instead of deploying OwnerPriceOracle.
 *   RESERVE_ETH         optional, wei. Settlement reserve funded at deploy (default 1 ether; 0 on mainnet).
 *   MAX_PRICE_AGE       optional, seconds. Oldest price the protocol accepts (default by chain, see _defaults).
 *   MAX_MOVE_BPS        optional. Largest single price update accepted by the oracle (default by chain).
 *   MIN_HOLD_SECONDS    optional. Minimum time before an owner may close a position (default by chain).
 *   INITIAL_MARKETS     optional, comma-separated token addresses to register at deploy (max 10, each must be a contract).
 *                       They are registered enabled with the shared risk limits below. Prices are NOT set here: the keeper
 *                       pushes each first price. Use `npm run pons:prepare` to pick eligible Pons launches.
 *   MARKET_MAX_LEVERAGE_BPS / MARKET_MAINTENANCE_BPS / MARKET_MAX_BORROW   risk limits for INITIAL_MARKETS
 *                       (defaults 15000 / 1000 / 1 ether; on mainnet leverage <= 20000 and borrow cap <= 5 ether).
 *   CONFIRM_MAINNET     required for chain 4663: must equal exactly I_UNDERSTAND_THIS_USES_REAL_FUNDS.
 *   WRITE_DEPLOYMENT    optional. Set to false to skip writing the json (default true).
 *
 * SAFETY RAILS (each is tested):
 *   - Only 31337, 46630 and 4663 are accepted. Every other chain reverts.
 *   - 4663 (real funds) additionally needs CONFIRM_MAINNET, an OWNER that is not the deployer (use a multisig), a distinct
 *     ORACLE_UPDATER (a keeper key that is neither owner nor deployer), and it deploys no demo markets and no demo prices.
 *   - The public Anvil key is refused on any chain except 31337.
 */
contract Deploy is Script {
    error UnsupportedChain(uint256 chainId);
    error PublicKeyOnPublicChain();
    error MainnetNotConfirmed();
    error MainnetNeedsSeparateOwner();
    error MainnetNeedsSeparateUpdater();
    error MainnetUsesOwnOracle();
    error MainnetRiskTooAggressive();
    error TooManyInitialMarkets();
    error InitialMarketNotAContract(address market);

    uint256 internal constant ANVIL = 31337;
    uint256 internal constant ROBINHOOD_TESTNET = 46630;
    uint256 internal constant ROBINHOOD_MAINNET = 4663;
    string internal constant MAINNET_CONFIRMATION = "I_UNDERSTAND_THIS_USES_REAL_FUNDS";

    /// @dev Anvil's first account. Published in Foundry's docs, so it must never hold real value.
    uint256 internal constant ANVIL_PUBLIC_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    struct Params {
        address owner;
        IPriceOracle oracle; // address(0): deploy OwnerPriceOracle
        address updater; // address(0): the deployer
        bool writeFile;
        uint256 reserve;
        uint256 maxPriceAge; // 0: keep the RiskManager default
        uint256 maxMoveBps; // 0: keep the oracle default
        uint256 minHoldSeconds;
        bool mainnetConfirmed;
        address[] initialMarkets; // registered at deploy with the limits below (no prices)
        uint32 marketMaxLeverageBps;
        uint16 marketMaintenanceBps;
        uint128 marketMaxBorrow;
    }

    struct Deployment {
        uint256 chainId;
        address deployer;
        address owner;
        address updater;
        RiskManager riskManager;
        MarginPool pool;
        MarginTrading trading;
        IPriceOracle oracle;
        address[5] markets; // PLNK, FERRY, LCAT, TIDE, PONSW (all zero on mainnet: no demo markets)
        uint256 maxPriceAge;
        uint256 maxMoveBps;
        uint256 minHoldSeconds;
        uint256 reserve;
        uint256 deployedAt;
        address[] initialMarkets;
        uint32 marketMaxLeverageBps;
        uint16 marketMaintenanceBps;
        uint128 marketMaxBorrow;
    }

    /// @notice Entry point for `forge script`: reads the environment, then calls `deploy`.
    function run() external returns (Deployment memory) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        (uint256 age, uint256 move, uint256 hold, uint256 reserve) = _defaults(block.chainid);
        Params memory p = Params({
            owner: vm.envOr("OWNER", deployer),
            oracle: IPriceOracle(vm.envOr("ORACLE", address(0))),
            updater: vm.envOr("ORACLE_UPDATER", address(0)),
            writeFile: vm.envOr("WRITE_DEPLOYMENT", true),
            reserve: vm.envOr("RESERVE_ETH", reserve),
            maxPriceAge: vm.envOr("MAX_PRICE_AGE", age),
            maxMoveBps: vm.envOr("MAX_MOVE_BPS", move),
            minHoldSeconds: vm.envOr("MIN_HOLD_SECONDS", hold),
            mainnetConfirmed: keccak256(bytes(vm.envOr("CONFIRM_MAINNET", string("")))) == keccak256(bytes(MAINNET_CONFIRMATION)),
            initialMarkets: vm.envOr("INITIAL_MARKETS", ",", new address[](0)),
            marketMaxLeverageBps: uint32(vm.envOr("MARKET_MAX_LEVERAGE_BPS", uint256(15_000))),
            marketMaintenanceBps: uint16(vm.envOr("MARKET_MAINTENANCE_BPS", uint256(1_000))),
            marketMaxBorrow: uint128(vm.envOr("MARKET_MAX_BORROW", uint256(1 ether)))
        });
        return deploy(pk, p);
    }

    /// @notice Per-chain defaults for (max price age, max move per update, min hold, reserve). Conservative on mainnet.
    function _defaults(uint256 chainId) internal pure returns (uint256 age, uint256 move, uint256 hold, uint256 reserve) {
        if (chainId == ROBINHOOD_MAINNET) return (120, 1_000, 300, 0); // 2 min, 10% per update, 5 min hold, fund later
        if (chainId == ROBINHOOD_TESTNET) return (1 hours, 10_000, 60, 1 ether);
        return (1 days, 100_000, 0, 1 ether); // local demo: loose, so the demo price controls work
    }

    /// @notice The deployment itself, with every input as an argument (so tests need no environment variables).
    function deploy(uint256 pk, Params memory p) public returns (Deployment memory d) {
        uint256 chainId = block.chainid;
        if (chainId != ANVIL && chainId != ROBINHOOD_TESTNET && chainId != ROBINHOOD_MAINNET) {
            revert UnsupportedChain(chainId);
        }
        if (chainId != ANVIL && pk == ANVIL_PUBLIC_KEY) revert PublicKeyOnPublicChain();

        d.chainId = chainId;
        d.deployer = vm.addr(pk);
        d.owner = p.owner;
        bool mainnet = chainId == ROBINHOOD_MAINNET;
        if (mainnet) {
            if (!p.mainnetConfirmed) revert MainnetNotConfirmed();
            if (p.owner == d.deployer) revert MainnetNeedsSeparateOwner();
            if (p.updater == address(0) || p.updater == d.deployer || p.updater == p.owner) {
                revert MainnetNeedsSeparateUpdater();
            }
            if (address(p.oracle) != address(0)) revert MainnetUsesOwnOracle();
            // Conservative mainnet market limits: at most 2x and a 5 ETH cap per market.
            if (p.marketMaxLeverageBps > 20_000 || p.marketMaxBorrow > 5 ether) revert MainnetRiskTooAggressive();
        }
        if (p.initialMarkets.length > 10) revert TooManyInitialMarkets();
        d.updater = p.updater == address(0) ? d.deployer : p.updater;
        d.deployedAt = block.timestamp;
        d.initialMarkets = p.initialMarkets;
        d.marketMaxLeverageBps = p.marketMaxLeverageBps;
        d.marketMaintenanceBps = p.marketMaintenanceBps;
        d.marketMaxBorrow = p.marketMaxBorrow;

        vm.startBroadcast(pk);

        // The deployer owns everything while wiring, then hands ownership to OWNER if that is someone else.
        OwnerPriceOracle owned;
        IPriceOracle oracle = p.oracle;
        if (address(oracle) == address(0)) {
            owned = new OwnerPriceOracle(d.deployer);
            oracle = owned;
            if (p.maxMoveBps != 0) owned.setMaxMoveBps(p.maxMoveBps);
        }
        d.oracle = oracle;
        d.riskManager = new RiskManager(d.deployer, oracle);
        d.pool = new MarginPool(d.deployer);
        d.trading = new MarginTrading(d.pool, d.riskManager, d.deployer);
        d.pool.setMarginTrading(address(d.trading));

        if (p.maxPriceAge != 0) d.riskManager.setMaxPriceAge(p.maxPriceAge);
        if (p.minHoldSeconds != 0) d.trading.setMinHoldSeconds(p.minHoldSeconds);
        d.maxPriceAge = d.riskManager.maxPriceAge();
        d.minHoldSeconds = d.trading.minHoldSeconds();
        if (address(owned) != address(0)) d.maxMoveBps = owned.maxMoveBps();

        // Demo markets and demo prices exist for local and testnet demos only, never on mainnet.
        if (!mainnet) _configureMarkets(d, owned);

        // Initial (Pons) markets: registered by the deployer while it still owns the RiskManager. No prices are set here,
        // so each market stays unusable (NoPrice) until the authorized keeper pushes its first price.
        for (uint256 i; i < p.initialMarkets.length; ++i) {
            address m = p.initialMarkets[i];
            if (m.code.length == 0) revert InitialMarketNotAContract(m);
            d.riskManager.setMarketRisk(
                m, IRiskManager.MarketRisk(true, p.marketMaxLeverageBps, p.marketMaintenanceBps, p.marketMaxBorrow)
            );
        }

        if (p.reserve != 0) d.trading.fundReserve{value: p.reserve}();
        d.reserve = d.trading.reserve();

        // Hand the price-pushing role to the keeper AFTER the initial prices are set (the deployer is the updater until now).
        if (address(owned) != address(0) && d.updater != d.deployer) owned.setUpdater(d.updater);

        if (d.owner != d.deployer) {
            d.riskManager.transferOwnership(d.owner);
            d.pool.transferOwnership(d.owner);
            d.trading.transferOwnership(d.owner);
            if (address(owned) != address(0)) owned.transferOwnership(d.owner);
        }

        vm.stopBroadcast();

        _log(d);
        if (p.writeFile) _write(d, mainnet);
    }

    /// @notice The placeholder market address for a demo symbol. There is no real token behind the demo markets.
    function marketAddress(string memory symbol) public pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("marginpad.demo.", symbol)))));
    }

    function _demoSymbols() internal pure returns (string[5] memory) {
        return ["PLNK", "FERRY", "LCAT", "TIDE", "PONSW"];
    }

    /// @dev Mirrors src/store/market.ts: max leverage (bps), maintenance (bps), pool cap and starting price (the demo price
    ///      scaled by 1e18). Every leverage stays at or below the 10x protocol ceiling. Prices are only pushed when this
    ///      script deployed the oracle.
    function _demoRisk()
        internal
        pure
        returns (uint32[5] memory lev, uint16[5] memory maint, uint128[5] memory caps, uint128[5] memory prices)
    {
        lev = [uint32(15_000), 20_000, 40_000, 70_000, 100_000];
        maint = [uint16(800), 700, 600, 500, 500];
        caps = [uint128(3 ether), 12 ether, 45 ether, 90 ether, 160 ether];
        prices = [uint128(0.00042 ether), 0.0087 ether, 0.061 ether, 0.42 ether, 2.85 ether];
    }

    function _configureMarkets(Deployment memory d, OwnerPriceOracle owned) internal {
        string[5] memory symbols = _demoSymbols();
        (uint32[5] memory lev, uint16[5] memory maint, uint128[5] memory caps, uint128[5] memory prices) = _demoRisk();
        for (uint256 i; i < 5; ++i) {
            address market = marketAddress(symbols[i]);
            d.markets[i] = market;
            d.riskManager.setMarketRisk(market, IRiskManager.MarketRisk(true, lev[i], maint[i], caps[i]));
            if (address(owned) != address(0)) owned.setPrice(market, prices[i]);
        }
    }

    function _log(Deployment memory d) internal pure {
        console.log("Chain id:      ", d.chainId);
        console.log("RiskManager:   ", address(d.riskManager));
        console.log("MarginPool:    ", address(d.pool));
        console.log("MarginTrading: ", address(d.trading));
        console.log("PriceOracle:   ", address(d.oracle));
        console.log("Oracle updater:", d.updater);
        console.log("Deployer:      ", d.deployer);
        console.log("Owner:         ", d.owner);
        if (d.owner != d.deployer) {
            console.log("Ownership transfer is PENDING: OWNER must call acceptOwnership() on each contract.");
        }
    }

    /// @dev deployments/<chainId>.json is what the frontend reads (copied by `npm run contracts:sync`).
    function _write(Deployment memory d, bool mainnet) internal {
        string memory json = string.concat(
            "{\n",
            '  "chainId": ',
            vm.toString(d.chainId),
            ",\n",
            '  "deployedAt": ',
            vm.toString(d.deployedAt),
            ",\n",
            '  "deployer": "',
            vm.toString(d.deployer),
            '",\n',
            '  "owner": "',
            vm.toString(d.owner),
            '",\n',
            '  "oracleUpdater": "',
            vm.toString(d.updater),
            '",\n',
            '  "riskManager": "',
            vm.toString(address(d.riskManager)),
            '",\n',
            '  "marginPool": "',
            vm.toString(address(d.pool)),
            '",\n',
            '  "marginTrading": "',
            vm.toString(address(d.trading)),
            '",\n',
            '  "priceOracle": "',
            vm.toString(address(d.oracle)),
            '",\n',
            '  "ponsV2Factory": "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",\n'
        );
        json = string.concat(
            json,
            '  "protection": { "maxPriceAgeSeconds": ',
            vm.toString(d.maxPriceAge),
            ', "maxMoveBpsPerUpdate": ',
            vm.toString(d.maxMoveBps),
            ', "minHoldSeconds": ',
            vm.toString(d.minHoldSeconds),
            ', "reserveWei": "',
            vm.toString(d.reserve),
            '" },\n',
            _marketsJson(d, mainnet),
            "}\n"
        );
        vm.writeFile(string.concat("./deployments/", vm.toString(d.chainId), ".json"), json);
    }

    /// @dev "markets" (symbol -> address, read by the frontend) and "marketRisk" (the registered risk parameters).
    function _initialMarketsJson(Deployment memory d) internal pure returns (string memory list, string memory risks) {
        list = "[";
        for (uint256 i; i < d.initialMarkets.length; ++i) {
            list = string.concat(list, i == 0 ? "" : ", ", '"', vm.toString(d.initialMarkets[i]), '"');
            risks = string.concat(
                risks,
                ",\n    \"",
                vm.toString(d.initialMarkets[i]),
                "\": ",
                _riskJson(d.marketMaxLeverageBps, d.marketMaintenanceBps, d.marketMaxBorrow)
            );
        }
        list = string.concat(list, "]");
    }

    function _riskJson(uint256 lev, uint256 maint, uint256 cap) internal pure returns (string memory) {
        return string.concat(
            '{ "maxLeverageBps": ',
            vm.toString(lev),
            ', "maintenanceBps": ',
            vm.toString(maint),
            ', "maxBorrowWei": "',
            vm.toString(cap),
            '" }'
        );
    }

    /// @dev The five demo markets: (markets object, risk entries joined by commas). Testnet and local only.
    function _demoJson(Deployment memory d) internal pure returns (string memory markets, string memory risks) {
        string[5] memory symbols = _demoSymbols();
        (uint32[5] memory lev, uint16[5] memory maint, uint128[5] memory caps,) = _demoRisk();
        markets = '  "markets": {\n';
        for (uint256 i; i < 5; ++i) {
            markets = string.concat(markets, '    "', symbols[i], '": "', vm.toString(d.markets[i]), i == 4 ? '"\n' : '",\n');
            risks = string.concat(risks, i == 0 ? "" : ",\n", '    "', symbols[i], '": ', _riskJson(lev[i], maint[i], caps[i]));
        }
        markets = string.concat(markets, "  }");
    }

    /// @dev "markets" (symbol -> address, read by the frontend), "initialMarkets" and "marketRisk" (every registered market).
    function _marketsJson(Deployment memory d, bool mainnet) internal pure returns (string memory) {
        (string memory list, string memory initialRisks) = _initialMarketsJson(d);
        string memory markets = '  "markets": {}';
        string memory body;
        if (mainnet) {
            body = bytes(initialRisks).length == 0 ? "" : _dropLeading(initialRisks);
        } else {
            string memory demoRisks;
            (markets, demoRisks) = _demoJson(d);
            body = string.concat(demoRisks, initialRisks);
        }
        return string.concat(markets, ',\n  "initialMarkets": ', list, ',\n  "marketRisk": {\n', body, "\n  }\n");
    }

    /// @dev Drops the leading ",\n" (2 characters) from a risks fragment so its first entry can start an object body.
    function _dropLeading(string memory str) internal pure returns (string memory) {
        bytes memory b = bytes(str);
        bytes memory out = new bytes(b.length - 2);
        for (uint256 i = 2; i < b.length; ++i) out[i - 2] = b[i];
        return string(out);
    }
}
