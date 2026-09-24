# Pons integration research

Status: research only. Nothing was deployed, changed or traded. Every "verified" claim below was checked either against
Pons' official documentation / official repository, or directly on chain with read-only calls (`eth_chainId`,
`eth_getCode`, `eth_call`, `eth_getLogs`) on 2026-09-24. Anything I could not verify is listed under Unknowns.

## 1. The blocker: Pons exists only on Robinhood Chain MAINNET

| Network | Chain ID | Pons deployed? | How verified |
|---|---|---|---|
| Robinhood Chain **mainnet** | **4663** | **Yes** (V1 and V2) | Official docs + code present at every address below (`cast codesize`) |
| Robinhood Chain **testnet** (what Marginpad targets) | 46630 | **No evidence of any** | Zero bytecode at all 8 Pons addresses on 46630; the docs mention no testnet |

Marginpad is testnet-only by design: the deploy script accepts only chain IDs 31337 and 46630 and refuses 4663, and the
frontend supports no mainnet. So **real Pons tokens cannot be traded through Marginpad as it stands**, and no Pons factory
can be called from the testnet. Any real integration means reading mainnet data, which needs an explicit decision (section 6).

Pons also states that V2 public launches are currently closed to whitelisted addresses only, and that V2 is unaudited
("No audit has closed").

## 2. Verified network information

- Chain: Robinhood Chain mainnet, chain ID **4663**, native asset ETH. Public RPC `https://rpc.mainnet.chain.robinhood.com`
  (on-chain check: `eth_chainId` returned 4663; the testnet RPC returned 46630). Explorer: `robinhoodchain.blockscout.com`.
- Two generations exist. **V2** is the current launch protocol; **V1** "has stopped producing launches" (Bitquery) but its
  contracts and tokens still exist.

## 3. Verified contract addresses (chain 4663)

Sources: **[D]** official docs `https://docs.ponsfamily.com/v2` (V2) and `https://www.ponsfamily.com/docs` (V1);
**[R]** official repository `github.com/ponsdotdev/pons-labs` (states it is the official repo; several unrelated forks
exist, use only that one); **[C]** confirmed on chain.

### V2 (current)
| Contract | Address | Sources |
|---|---|---|
| Launch Factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | D, R, C (code size 24177; emits `TokenLaunched`) |
| Meme Hook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` | D, C |
| Launch Locker | `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` | D, C |
| Launch and Buy Router | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` | D, C |
| Graduation Executor | `0xC7819B64A1dAECD7eC19856d026cb14EfBd89046` | D, C |
| Fee Escrow / Buyback Vault / Launch Deployer / Graduation Guard | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` / `0x42df2a798f82289E177311362e8f5ccC45c1219c` / `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42` / `0xf5695117b99B6f6401e67d4195BD653628176C6C` | D only |

### V1 (legacy, Uniswap V3 pools)
| Contract | Address | Sources |
|---|---|---|
| Factory ("active" in the V1 docs, superseded by V2) | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` (start block 8991118) | D, R, C |
| Older factory ("legacy") | `0x0c37a24F5D23A486FA692d1500881d698B1F77a4` (start block 8600612) | D, C |
| Lockers | `0x736D76699C26D0d966744cAe304C000d471f7F35`, `0x31ca5E101941A93A7DD6d0497928700625CF54B5` | D |
| Infra: V3 factory, position manager, swap router, WETH | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`, `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`, `0xCaf681a66D020601342297493863E78C959E5cb2`, `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | D |

Note: the V1 docs page labels `0xA5aA…` "Active"; the V2 docs and the repo make clear V2 is current. Treat the V1 factories as
historical.

## 4. Launch detection, events and functions

### How to identify a newly launched V2 token
Watch the V2 factory's `TokenLaunched` event (verified verbatim from `PonsV2LaunchFactory.sol` in the official repo):

```solidity
event TokenLaunched(address indexed token, address indexed curve, address indexed deployer,
                    address pairToken, uint256 launchConfigId, uint256 graduationThreshold);
event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut);
event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount);
event GraduationTokensPermanentlyLocked(address indexed token, uint256 amount);
```

On-chain confirmation: `keccak256("TokenLaunched(address,address,address,address,uint256,uint256)")` =
`0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607`, and `eth_getLogs` on the factory with that topic returned
real launches (for example in block 71178306, tx `0x6a975ef3dfa8b8f84e3fd791f02108c44ddfb9c7a67207043d4ea1a321bc92cf`). The
V1 event is different (topic0 `0xdb51ea9a…35a`, params: token, deployer, dexFactory, pairToken, pool, dexId, launchConfigId,
positionId, restrictionsEndBlock, initialBuyAmount, per Mobula/official V1 docs) and is not cross-compatible.

### Reading a launch (verified by calling a live token)
- `factory.getLaunchedToken(address token)` returns `LaunchedToken { token, curve, deployer, creatorFeeRecipient, pairToken,
  graduationThreshold, poolFee, tickSpacing, creatorTaxBps, buybackEnabled, phase (enum), sweptQuote, sweptTokens, sweptAt,
  exists }`. Confirmed on chain for a live token (`exists = true`).
- Token (ERC-20): `name()`, `symbol()`, `decimals()` (18 on the sample), fixed supply 1,000,000,000 minted to its curve.
- **Each launch has its own bonding-curve contract** (there is no single curve address). Curve functions verified on a live
  curve: `token()`, `pairToken()`, `graduated()`, `readyToGraduate()`, `graduationThreshold()`, `quoteReserve()`,
  `tokenReserve()`, `realQuoteReserve()`, `getReserves() returns (uint256, uint256)`.
- After graduation, liquidity moves to a Uniswap v4 pool behind the Meme Hook (`PoolRegistered` hook event; pool is created only
  at graduation, "the pool itself is set up to charge no fee"). Curve trade events: `CurveBuy`, `CurveSell`, `CurveCompleted`.

### Liquidity pools
- V2: **no pool exists before graduation.** Trading happens against the token's bonding curve. A Uniswap v4 pool is created
  automatically by the graduation flow (`LaunchSwept` then `PoolGraduated`) and its liquidity is locked permanently.
- V1: a Uniswap V3 pool exists from the first block; its address is in the V1 `TokenLaunched` event and `getLaunchedToken`.

### API / subgraph / SDK
- Pons documents **no API, subgraph or SDK**: its docs point to direct on-chain reads and "Events to index".
- Third-party (not official): Bitquery and Mobula publish Pons integration guides and APIs. Treat them as convenience data,
  not authority.

## 5. Current Marginpad architecture (audited, unchanged)

| Piece | Today | Relevance to Pons |
|---|---|---|
| Chain config (`src/chain/config.ts`) | Robinhood testnet 46630 for production, Local Anvil 31337 in dev; mainnet unsupported | Pons is on 4663, which is excluded |
| `MarginPool` | Shared ETH pool, shares, 90% utilization cap, 5% LP profit share | No change needed |
| `MarginTrading` | **Synthetic** positions: collateral + pool ETH are held, P&L is priced from the oracle, profits are paid from an owner-funded `reserve`. It never buys a token and never touches an ERC-20 | Trading a Pons token means synthetic exposure to its price, not owning it |
| `RiskManager` | `setMarketRisk(market, {enabled, maxLeverageBps, maintenanceBps, maxBorrow})` per market address, `validPrice` with staleness (`maxPriceAge`), liquidation maths | A "market" is just an address plus risk numbers, so a Pons token address fits directly |
| `OwnerPriceOracle` | Owner pushes `price` (wei per whole token, 1e18-scaled) per market address | Needs a price for each Pons token; nothing reads Pons yet |
| Deploy script | Hardcodes the five demo markets with placeholder addresses derived from symbols; configures prices, reserve, max age | Would be replaced or extended by real market registration |
| Frontend | `TOKENS` in `src/store/market.ts` is a static list of five markets; `deployments.json` maps symbol to market address | A dynamic market list does not exist yet |

## 6. Proposed integration architecture

Because Marginpad's positions are synthetic and priced only by the oracle, the smallest workable design keeps all contracts as they
are and adds a read-only discovery and price step:

1. **Discovery (off-chain, read-only):** read `TokenLaunched` logs from the V2 factory `0x7eD5…EC7e` on chain 4663 (or the V1
   factories for historical tokens). For each token call `getLaunchedToken` and the token's `name()/symbol()`.
2. **Pricing (read-only):** pre-graduation, price per token derived from the curve reserves (`getReserves()`), oriented so the
   result is in the same unit as the oracle (wei per whole token). Post-graduation, price comes from the Uniswap v4 pool.
3. **Registration:** for each accepted token, `RiskManager.setMarketRisk(<token address>, …)` (owner action) with leverage and
   caps chosen by the operator, and a first `OwnerPriceOracle.setPrice`.
4. **Price refresh:** something must keep pushing prices (the oracle rejects prices older than `maxPriceAge`).
5. **Frontend:** replace the static `TOKENS` list with the registered markets read from chain.

Two ways to reconcile this with "testnet only", both needing your decision:

- **A. Mirror mainnet data into testnet.** Reads mainnet (no funds, no transactions on mainnet) and registers the token's
  *mainnet address* as a market on the *testnet* Marginpad, with test ETH. Positions are synthetic, so nothing on mainnet is
  touched. Cost: the oracle stays centralized, and a job must relay prices.
- **B. Wait for or build a Pons test environment.** No Pons testnet deployment exists that I can find. The official repo contains
  the V2 sources, so a private copy could in principle be deployed to testnet, but that would be a fork you operate, not Pons.
  Not researched further.

Trading real funds against real Pons tokens on mainnet is out of scope and blocked by design.

## 7. Unknowns and blockers

1. **No Pons testnet** was found (zero code at every Pons address on 46630; no testnet in the docs). Whether Pons plans one is
   unknown.
2. **V2 price formula** is not documented in what I could read. The repo describes a "constant-product bonding curve" and the
   curve exposes `getReserves()`, but for the sample curve `quoteReserve` is `28.88e18` against `realQuoteReserve = 1` wei, which
   implies a virtual ("phantom") quote reserve. The correct price expression (virtual vs real reserves, fees, snipe tax) must be
   taken from the curve source or the "Getting a quote" docs page before use. Not verified.
3. **`pairToken`** is an ERC-20 address in the event; the sample launch used `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa`. Which
   pair tokens are approved (ETH, USDG, cbBTC, tokenized assets per third-party sources) and how native ETH is represented
   was not verified; prices are only comparable in ETH terms for ETH-paired launches.
4. **Post-graduation price source:** the Uniswap v4 pool id derivation and the correct read path (StateView or PoolManager)
   were not verified. Docs list the v4 PoolManager only via Bitquery (`0x8366a39cc670b4001a1121b8f6a443a643e40951`), not
   confirmed in official docs.
5. **Launch access:** V2 public launches are reported closed (whitelist only), so the flow of new tokens may be limited.
   On-chain, `launchEnabled()` on the factory returned `true`; whitelist status was not examined.
6. **Audit:** V2 is officially unaudited (three reviews in progress). V1 audit status was not checked.
7. **Official-source hygiene:** the docs site was read through a summarizing fetch tool, and the repo through raw GitHub files.
   Addresses were cross-checked between docs, repo and chain. Event ABIs beyond the ones quoted above were not read in full.
8. **Legal/ToS:** using Pons token data or branding inside another product was not researched.

## 8. Minimum next implementation step

Build a **read-only discovery script** (no contract or UI change): given chain 4663's public RPC, list `TokenLaunched` events from
the V2 factory over a block range, and for each token print address, name, symbol, curve, pair token, threshold, `graduated()`,
and raw `getReserves()`. This settles unknowns 2, 3 and 5 with real data and is the input for any market registration.

Before that, one product decision is needed: **A (mirror mainnet Pons data onto the testnet, synthetic positions) or B (wait for /
build a Pons test deployment)**. Do not start registering markets, changing the oracle, or touching the UI until that is decided.

## Sources
- Pons V2 docs: https://docs.ponsfamily.com/v2 (contracts, functions, events, risk and audit statements)
- Pons docs (V1): https://www.ponsfamily.com/docs and https://docs.ponsfamily.com
- Official repository: https://github.com/ponsdotdev/pons-labs (`contractsV2/src/v2/PonsV2LaunchFactory.sol`, `interfaces/ILaunchpadV2.sol`)
- Third-party (secondary): https://docs.bitquery.io/docs/blockchain/robinhood/pons-api/ and https://docs.mobula.io/almanac/robinhood-launchpads/pons
- Robinhood Chain RPC checks: `https://rpc.mainnet.chain.robinhood.com` (4663) and `https://rpc.testnet.chain.robinhood.com` (46630), read-only calls only

## Update: V2 curve price (verified)

Source: `PonsV2BondingCurve.sol` in the official repo, then checked against live curves on chain 4663.

- `getReserves()` returns `(phantomQuote + trackedQuote - quoteFeeBalance - creatorTaxBalance, trackedTokens)`. The quote side includes
  a virtual "phantom" reserve the curve is seeded with; `realQuoteReserve()` is only the real deposits.
- A buy takes `fee = spent * feeBps / 10000` and `tax = spent * creatorTaxBps / 10000` from the input, then uses a constant-product
  swap on the reserves: `tokensOut = net * tokenReserve / (quoteReserve + net)`, `net = spent - fee - tax`.
- **Check:** for 3 live ETH-quoted curves (creator tax 2%, 2% and 0%) and 2 input sizes each (6 cases), an `eth_call` simulation of `buy()` returned
  exactly the same `tokensOut`, to the wei, as this formula (with each curve's `feeBps` and `creatorTaxBps`).
- **Spot price** (marginal, before fees) = `quoteReserve / tokenReserve`, adjusted for each asset's decimals. A sample new launch
  reads 1.68 ETH / 1e9 tokens = 0.00000000168 ETH per token, as expected from its phantom seed.
- `pairToken == address(0)` means the quote asset is native ETH (`isNativeQuote()`); otherwise the quote is that ERC-20, so the
  price is in the pair token (SPCX, USDG and others were seen), not ETH.
- Graduated curves (`graduated() == true`) no longer hold the price; it moves to the Uniswap v4 pool (still unsupported).
