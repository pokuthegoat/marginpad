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
 * @notice Deploys and wires RiskManager, MarginPool, MarginTrading and the centralized testnet OwnerPriceOracle,
 *         then configures the five demo markets, their initial prices and the settlement reserve.
 *
 *   Local (anvil):    forge script script/Deploy.s.sol --rpc-url anvil --broadcast
 *   Robinhood testnet: forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast
 *
 * Environment (see .env.example):
 *   PRIVATE_KEY        required. The deployer.
 *   OWNER              optional. Final owner of all contracts (default: the deployer). Ownership is handed over in
 *                      two steps, so this address must call `acceptOwnership()` on each contract.
 *   ORACLE             optional. Use this price source instead of deploying OwnerPriceOracle (initial prices are then
 *                      NOT pushed, since only OwnerPriceOracle has `setPrice`).
 *   RESERVE_ETH        optional, in wei. Testnet settlement reserve funded at deploy (default: 1 ether).
 *   MAX_PRICE_AGE      optional, in seconds. How old an oracle price may be (default: 1 day on testnet).
 *   WRITE_DEPLOYMENT   optional. Set to false to skip writing deployments/<chainId>.json (default: true).
 *
 * SAFETY RAILS (each is tested):
 *   - Only local anvil (31337) and Robinhood Chain TESTNET (46630) are allowed. Every other chain reverts, including
 *     Robinhood Chain mainnet (4663) and Ethereum mainnet. There is no flag to override this.
 *   - The well-known public Anvil key is refused on any public chain, since bots sweep funds from it within seconds.
 */
contract Deploy is Script {
    error UnsupportedChain(uint256 chainId);
    error PublicKeyOnPublicChain();

    uint256 internal constant ANVIL = 31337;
    uint256 internal constant ROBINHOOD_TESTNET = 46630;

    /// @dev Anvil's first account. Published in Foundry's docs, so it must never hold real value.
    uint256 internal constant ANVIL_PUBLIC_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    struct Deployment {
        address deployer;
        address owner;
        RiskManager riskManager;
        MarginPool pool;
        MarginTrading trading;
        IPriceOracle oracle;
        address[5] markets; // PLNK, FERRY, LCAT, TIDE, PONSW
    }

    /// @notice Entry point for `forge script`: reads the environment, then calls `deploy`.
    function run() external returns (Deployment memory) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        return deploy(
            pk,
            vm.envOr("OWNER", vm.addr(pk)),
            IPriceOracle(vm.envOr("ORACLE", address(0))),
            vm.envOr("WRITE_DEPLOYMENT", true),
            vm.envOr("RESERVE_ETH", uint256(1 ether)),
            vm.envOr("MAX_PRICE_AGE", uint256(1 days))
        );
    }

    /// @notice The deployment itself, with every input as an argument (so tests need no environment variables).
    function deploy(
        uint256 pk,
        address finalOwner,
        IPriceOracle oracle,
        bool writeFile,
        uint256 reserve,
        uint256 maxPriceAge
    ) public returns (Deployment memory d) {
        if (block.chainid != ANVIL && block.chainid != ROBINHOOD_TESTNET) revert UnsupportedChain(block.chainid);
        if (block.chainid != ANVIL && pk == ANVIL_PUBLIC_KEY) revert PublicKeyOnPublicChain();

        d.deployer = vm.addr(pk);
        d.owner = finalOwner;

        vm.startBroadcast(pk);

        // The deployer owns everything while wiring, then hands ownership to OWNER if that is someone else.
        OwnerPriceOracle owned;
        if (address(oracle) == address(0)) {
            owned = new OwnerPriceOracle(d.deployer);
            oracle = owned;
        }
        d.oracle = oracle;
        d.riskManager = new RiskManager(d.deployer, oracle);
        d.pool = new MarginPool(d.deployer);
        d.trading = new MarginTrading(d.pool, d.riskManager, d.deployer);
        d.pool.setMarginTrading(address(d.trading));

        _configureMarkets(d, owned);
        if (maxPriceAge != 0) d.riskManager.setMaxPriceAge(maxPriceAge);
        if (reserve != 0) d.trading.fundReserve{value: reserve}();

        if (d.owner != d.deployer) {
            d.riskManager.transferOwnership(d.owner);
            d.pool.transferOwnership(d.owner);
            d.trading.transferOwnership(d.owner);
            if (address(owned) != address(0)) owned.transferOwnership(d.owner);
        }

        vm.stopBroadcast();

        _log(d);
        if (writeFile) _write(d);
    }

    /// @notice The placeholder market address for a demo symbol. There is no real token behind the demo markets yet
    ///         (Pons integration comes later), so each address is derived from the symbol.
    function marketAddress(string memory symbol) public pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("marginpad.demo.", symbol)))));
    }

    /// @dev Mirrors src/store/market.ts: max leverage, maintenance margin, pool cap and starting price (the demo
    ///      price scaled by 1e18). Prices are only pushed when this script deployed the OwnerPriceOracle.
    function _configureMarkets(Deployment memory d, OwnerPriceOracle owned) internal {
        string[5] memory symbols = ["PLNK", "FERRY", "LCAT", "TIDE", "PONSW"];
        uint32[5] memory maxLeverageBps = [uint32(15_000), 20_000, 40_000, 70_000, 100_000];
        uint16[5] memory maintenanceBps = [uint16(800), 700, 600, 500, 500];
        uint128[5] memory caps = [uint128(3 ether), 12 ether, 45 ether, 90 ether, 160 ether];
        uint128[5] memory prices = [uint128(0.00042 ether), 0.0087 ether, 0.061 ether, 0.42 ether, 2.85 ether];

        for (uint256 i; i < 5; ++i) {
            address market = marketAddress(symbols[i]);
            d.markets[i] = market;
            d.riskManager.setMarketRisk(
                market, IRiskManager.MarketRisk(true, maxLeverageBps[i], maintenanceBps[i], caps[i])
            );
            if (address(owned) != address(0)) owned.setPrice(market, prices[i]);
        }
    }

    function _log(Deployment memory d) internal pure {
        console.log("RiskManager:   ", address(d.riskManager));
        console.log("MarginPool:    ", address(d.pool));
        console.log("MarginTrading: ", address(d.trading));
        console.log("PriceOracle:   ", address(d.oracle));
        console.log("Deployer:      ", d.deployer);
        console.log("Owner:         ", d.owner);
        if (d.owner != d.deployer) {
            console.log("Ownership transfer is PENDING: OWNER must call acceptOwnership() on each contract.");
        }
    }

    /// @dev deployments/<chainId>.json is what the frontend reads (copied by `npm run contracts:sync`).
    function _write(Deployment memory d) internal {
        string memory json = string.concat(
            "{\n",
            '  "chainId": ',
            vm.toString(block.chainid),
            ",\n",
            '  "deployer": "',
            vm.toString(d.deployer),
            '",\n',
            '  "owner": "',
            vm.toString(d.owner),
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
            _marketsJson(d),
            "}\n"
        );
        vm.writeFile(string.concat("./deployments/", vm.toString(block.chainid), ".json"), json);
    }

    function _marketsJson(Deployment memory d) internal pure returns (string memory) {
        return string.concat(
            '  "markets": {\n',
            '    "PLNK": "',
            vm.toString(d.markets[0]),
            '",\n',
            '    "FERRY": "',
            vm.toString(d.markets[1]),
            '",\n',
            '    "LCAT": "',
            vm.toString(d.markets[2]),
            '",\n',
            '    "TIDE": "',
            vm.toString(d.markets[3]),
            '",\n',
            '    "PONSW": "',
            vm.toString(d.markets[4]),
            '"\n',
            "  }\n"
        );
    }
}
