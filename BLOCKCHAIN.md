# Marginpad: blockchain (Phases 1-4)

Smart contracts for the Marginpad margin-trading layer. **Testnet only, not audited, no real funds.** LP deposits, borrowing,
open/close of long and short positions and the 5% LP profit share work. Liquidation and oracle-staleness protection work.
The existing demo app is untouched and keeps running on its mock data.

## Target network

**Robinhood Chain Testnet** (an Arbitrum-based Layer 2, ETH for gas). Marginpad is built for Pons launches on Robinhood
Chain, so this is the chain the product will live on, and the pool holds native ETH exactly as the demo does.

| | |
|---|---|
| Chain ID | `46630` |
| Public RPC | `https://rpc.testnet.chain.robinhood.com` (rate-limited; use a provider for heavy use) |
| Explorer | `https://explorer.testnet.chain.robinhood.com` (Blockscout) |
| Local chain | Anvil, chain ID `31337` |

Source: [Robinhood Chain docs](https://docs.robinhood.com/chain/connecting). Robinhood Chain **mainnet (4663)** is live
too; the deploy script refuses it (see Safety rails).

Chain notes that shaped the code: `block.number` is only an estimate of the Ethereum block number, so contracts use
`block.timestamp` for time. The docs don't list opcode support, so the compiler targets the conservative `paris` EVM.

## Contracts (`contracts/src`)

| Contract | Responsibility | Holds ETH? |
|---|---|---|
| **MarginPool** | The shared ETH pool. LPs supply ETH; only `MarginTrading` may borrow from it. Tracks deposits, borrowed amount, LP shares, and the 90% utilization cap. | Yes (LP funds) |
| **MarginTrading** | Opens and closes leveraged positions: trader collateral + ETH borrowed from the pool. Stores every `Position`. | Yes (collateral, while a position is open) |
| **RiskManager** | Per-market risk settings (max leverage, maintenance margin, borrow cap) and the rules for opening and liquidating. Holds the oracle pointer. | No |

Shared files: `Types.sol` (`Position`, `Side`, `PositionStatus`), `Errors.sol`, `ProtocolParams.sol` (the fixed numbers,
which mirror the demo app: 90% utilization cap, 5% LP profit share, 1x to 10x leverage, 0.01 ETH minimums), and
`interfaces/` (`IMarginPool`, `IMarginTrading`, `IRiskManager`, `IPriceOracle`).

Leverage is stored in basis points (`10_000` = 1x, `100_000` = 10x). Amounts are wei.

## How they interact

```
                 LP  --deposit / withdraw / claimRewards-->  MarginPool
                                                               ^   |
                                          repay / absorbLoss   |   | borrow
                                                               |   v
 Trader --openPosition / closePosition--> MarginTrading -------+
                       (collateral = msg.value)      |
                                                     | validateOpen / isLiquidatable / liquidationPrice
                                                     v
 anyone --liquidate--------------------> MarginTrading ---> RiskManager ---> IPriceOracle
```

1. An LP deposits ETH into the pool and receives shares.
2. A trader calls `openPosition` with collateral. `RiskManager.validateOpen` says how much to borrow. The pool lends it
   to `MarginTrading`, and a `Position` is stored at the current oracle price.
3. On close, profit pays 5% to the LPs and the rest to the trader. A loss is absorbed by the collateral first. The borrowed
   ETH always returns to the pool.
4. If a price crosses a position's liquidation level, anyone may `liquidate` it before the pool's ETH is at risk.

## What exists now vs later

| Area | Status |
|---|---|
| Ownership, pause, reentrancy guards, access control, deploy scripts | done (Phase 1) |
| **MarginPool**: LP deposit (shares), withdraw, 90% utilization cap, borrow / repay / absorbLoss for MarginTrading, 5% LP profit share as per-share rewards, claimRewards | done (Phase 2) |
| **RiskManager.validateOpen**: market enabled, leverage cap, market borrow cap, pool 90% limit | done (Phase 2) |
| **OwnerPriceOracle**: owner-pushed prices. **CENTRALIZED TESTNET ORACLE**, whoever holds the key sets every price. Replace before real funds. | done (Phase 2) |
| **MarginTrading**: open / close long and short positions, entry price from the oracle, P&L, repayment and 5% LP share via the pool, owner-funded testnet settlement reserve | done (Phase 3) |
| **Liquidation**: `liquidationPrice`, `isLiquidatable`, `liquidate` (pool repaid first, leftover equity to the pool, price-gap shortfall via `absorbLoss`); oracle staleness check (`maxPriceAge`, default 1 hour) | done (Phase 4) |
| Pons integration, frontend wiring | not started |

No placeholders remain in the contracts.

## Setup

Install [Foundry](https://book.getfoundry.sh/getting-started/installation) (developed with v1.8.3).
macOS / Linux / WSL: `curl -L https://foundry.paradigm.xyz | bash && foundryup`.
Windows: download `foundry_*_win32_amd64.zip` from the [releases](https://github.com/foundry-rs/foundry/releases),
unzip it into a folder and add that folder to your `PATH`.

Clone with submodules (the libraries are pinned git submodules: OpenZeppelin v5.0.2, forge-std v1.9.7):

```bash
git clone --recurse-submodules <repo>          # or, in an existing clone:  git submodule update --init --recursive
```

## Commands

Run from the repo root (the `contracts:*` npm scripts) or from `contracts/`:

```bash
npm run contracts:build          # forge build
npm run contracts:test           # forge test  (incl. fuzzing)
cd contracts && forge test --profile ci     # heavier fuzzing (2000 runs)
```

**Local chain**

```bash
cd contracts
cp .env.example .env                                   # the local Anvil key is pre-filled
anvil                                                  # terminal 1
forge script script/Deploy.s.sol --rpc-url anvil --broadcast     # terminal 2
```

**Robinhood Chain testnet**

```bash
cd contracts
cast wallet new                                        # make a NEW throwaway wallet; testnet funds only
# put its private key in contracts/.env as PRIVATE_KEY, fund its address from the testnet faucet
forge script script/Deploy.s.sol --rpc-url robinhood_testnet                 # dry run: simulates, sends nothing
forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast     # real testnet deployment
```

A dry run of the current contracts estimates ~2.76M gas (about 0.00006 ETH). Optional verification on Blockscout:

```bash
forge verify-contract <address> src/MarginPool.sol:MarginPool --chain-id 46630 \
  --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/
```

Addresses are written to `contracts/deployments/<chainId>.json` (the frontend will read these in a later phase).
Constructor arguments for verification are the owner address (MarginPool), `(owner, oracle)` (RiskManager) and
`(pool, riskManager, owner)` (MarginTrading).

## Safety rails (all covered by tests)

- **Mainnet is impossible from the script.** Only chain IDs `31337` and `46630` are accepted. Everything else reverts,
  including Robinhood Chain mainnet (`4663`) and Ethereum mainnet. There is no override flag.
- **The public Anvil key is refused on any public chain**, since bots sweep funds from published keys within seconds.
- **Ownership is two-step and can't be renounced**, so a typo can't hand the contracts to a dead address and the owner can
  always pause.
- **Every state-changing function is pausable and non-reentrant**; the pool's borrow/repay/loss functions can only be called
  by the wired `MarginTrading` contract, and that wiring can be set only once.
- **No open `receive()` / `fallback()`**: the pool takes ETH only through `deposit()`/`repay()`, and MarginTrading accepts plain ETH only from the pool.
- Built on OpenZeppelin v5 (`Ownable2Step`, `Pausable`, `ReentrancyGuard`); no custom cryptography.

## Next

Deploy-script support for the oracle and settlement reserve, then Pons integration (Phase 5). Not audited: do not use with real funds.

## Run the whole MVP locally

```bash
npm install
npm run local            # starts Anvil, deploys every contract, syncs addresses into the frontend, starts the dev server
npm run chain:fund -- 0xYourWalletAddress      # in a second terminal: give your wallet 1000 test ETH
```

Then open http://localhost:5173, connect your wallet and add/switch to **Local Anvil** (chain id 31337, RPC
`http://127.0.0.1:8545`, currency ETH). The app asks the wallet to switch automatically. Anvil state is in memory, so a
restart of `npm run local` gives a fresh chain and fresh addresses (the frontend picks them up on its own).

Step by step instead: `npm run chain` (Anvil), `npm run chain:deploy` (deploy + sync), `npm run dev` (frontend).
`npm run test:chain` runs the end-to-end chain test against the running local chain. Dev builds use Local Anvil by
default; production builds use Robinhood Chain Testnet (`VITE_CHAIN_ID=46630` selects it in dev).

## Frontend integration (Phase 5)

The app reads and writes the deployed contracts directly from the browser (viem + the existing Privy wallet). There is no
backend or database for chain data.

- `src/chain/config.ts`: testnet chain config (Robinhood Chain Testnet 46630; local Anvil 31337 in dev builds only via
  `VITE_CHAIN_ID=31337`). Mainnet is not configured anywhere.
- `src/chain/abis.ts` and `src/chain/deployments*.json`: generated from the Foundry project by `npm run contracts:sync`.
  `deployments.json` = Robinhood testnet (committed once deployed), `deployments.local.json` = Anvil (git-ignored).
- `src/chain/read.ts`: one snapshot read (balances, pool totals, shares, rewards, utilization, oracle prices and
  staleness, on-chain max leverage / maintenance / caps, positions, closed and liquidated trades, activity feed, price
  history from oracle events), polled every 5 s. `src/chain/tx.ts`: simulate, send, and plain-language errors.
- `src/store/StoreContext.tsx`: same `useStore()` shape as before, now chain-backed. Every action is a real transaction
  with wallet-prompt, pending, success and failure notices.

Deploy to the testnet (needs a NEW throwaway wallet funded from the testnet faucet; `RESERVE_ETH` defaults to 1 ETH):

```bash
cd contracts && forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast
cd .. && npm run contracts:sync      # then commit src/chain/deployments.json
```

Only the wallet that owns the oracle (the deployer) sees the "move the price" controls on /trade.
