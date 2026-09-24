# Robinhood Chain mainnet (4663) deployment runbook

Status: **prepared, rehearsed on a local fork, NOT deployed.** The contracts are unaudited. Real funds can be lost. Nothing in this
repository stores or needs a private key: every secret comes from your environment at run time and is never printed or written to a file.

Every command below was rehearsed against a local Anvil fork of chain 4663 (real Pons state, throwaway Anvil dev keys, nothing sent to the
real network). The rehearsal outputs were discarded so no fake mainnet artifact exists in the repo.

## Roles (three different addresses, all public)
| Role | What it is | Key |
|---|---|---|
| Deployer | one-time wallet that pays for the deploy | hot key, used once |
| Owner | final admin of all four contracts, pauses, rotates the keeper, sets limits, funds the reserve | **a multisig**, not the deployer |
| Keeper | the only account allowed to push prices and mark graduation | dedicated hot key on the keeper machine |

## 1. Choose the initial Pons markets (read-only, no key)
```bash
npm run pons:prepare
```
Uses the same shared rules as the /trade discovery (`src/pons/eligibility.ts`). Picks Pons V2 launches that the Pons factory itself confirms, that are ETH-quoted, not graduated, at least 1 hour old, not near graduation, and do not
impersonate a well-known asset. Prints an `INITIAL_MARKETS=...` line and writes `src/chain/pons-markets.mainnet.json`. Use the line from the SAME run.

## 2. Deploy (deployer key from your environment)
```bash
cd contracts
export PRIVATE_KEY=...           # deployer, never committed
export OWNER=0x...               # multisig, must differ from the deployer
export ORACLE_UPDATER=0x...      # keeper address, must differ from deployer and owner
export INITIAL_MARKETS=0x...,0x...   # from step 1
export RESERVE_ETH=...           # wei of settlement reserve to fund at deploy (optional)
export CONFIRM_MAINNET=I_UNDERSTAND_THIS_USES_REAL_FUNDS
forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
```
Refuses without the confirmation, with owner == deployer, with a missing or non-distinct keeper, with a market limit above 2x or a 5 ETH cap, or with a
market address that is not a contract. Mainnet defaults: max price age 120 s, max move 10% per update, hold period 300 s, no demo markets, no demo prices.
Writes `contracts/deployments/4663.json` (chain, `deployedAt`, addresses, owner, keeper, protection settings, markets and risk).

## 3. Owner accepts ownership (multisig)
Call `acceptOwnership()` on MarginPool, MarginTrading, RiskManager and OwnerPriceOracle.

## 4. Verify (read-only)
```bash
VERIFY_CHAIN=4663 npm run verify:deployment -- --require-accepted
```
Checks code at every address, wiring, ownership, keeper, oracle settings, pause state, reserve, pool, every market's risk parameters, no demo markets, and that
the frontend/keeper registry equals the deployed markets. Any FAIL exits non-zero. Do not go on until it prints ALL CHECKS PASSED.

## 5. Sync the frontend and start the keeper
```bash
npm run pons:prepare -- --from-artifact     # registry := what is actually registered on chain
npm run contracts:sync                       # writes src/chain/deployments.mainnet.json (commit it, and the registry)
MIRROR_CHAIN=4663 PRIVATE_KEY=<keeper key> CONFIRM_MAINNET=I_UNDERSTAND_THIS_USES_REAL_FUNDS node scripts/pons-mirror.mjs mirror
```
The keeper pushes only markets that are registered and enabled on chain, steps within `maxMoveBps`, refreshes unchanged prices before they age out,
marks a market graduated (and stops pushing it) when its curve graduates, and on any RPC error stops pushing (prices then go stale and trading halts).
It refuses to run with a key that is not the oracle updater. It does not liquidate anything.

## 6. Frontend
Vercel: `VITE_CHAIN_ID=4663` and `VITE_ALLOW_MAINNET=true` (optionally `VITE_RPC_URL`, https), then redeploy. Add the production origin in the Privy dashboard.
Only enable this when you are ready for real users.

## Not covered (see the final report): audit, decentralized oracle, thin-curve manipulation, post-graduation pricing, liquidation bots, key management.
