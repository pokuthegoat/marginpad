// READ-ONLY verification of a deployment against its artifact (contracts/deployments/<chainId>.json). No keys, no transactions.
//
//   VERIFY_CHAIN=4663 npm run verify:deployment               (default chain 31337; VERIFY_RPC overrides the RPC)
//   VERIFY_CHAIN=4663 npm run verify:deployment -- --require-accepted
//
// Every check prints PASS or FAIL. Any FAIL exits with code 1. Nothing is assumed to have succeeded: each value is read from
// the chain and compared with the artifact.
import fs from 'node:fs'
import path from 'node:path'
import { createPublicClient, getAddress, http } from 'viem'
import { root } from './env.mjs'

const CHAIN_ID = Number(process.env.VERIFY_CHAIN ?? 31337)
const RPC =
  process.env.VERIFY_RPC ??
  (CHAIN_ID === 31337 ? 'http://127.0.0.1:8545' : CHAIN_ID === 4663 ? 'https://rpc.mainnet.chain.robinhood.com' : 'https://rpc.testnet.chain.robinhood.com')
const requireAccepted = process.argv.includes('--require-accepted')
const PONS_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'

const file = path.join(root, `contracts/deployments/${CHAIN_ID}.json`)
if (!fs.existsSync(file)) {
  console.error(`No artifact at ${file}. Nothing to verify.`)
  process.exit(1)
}
const art = JSON.parse(fs.readFileSync(file, 'utf8'))
const abiOf = (n) => JSON.parse(fs.readFileSync(path.join(root, `contracts/out/${n}.sol/${n}.json`), 'utf8')).abi
const ABI = { pool: abiOf('MarginPool'), trading: abiOf('MarginTrading'), risk: abiOf('RiskManager'), oracle: abiOf('OwnerPriceOracle') }
const client = createPublicClient({ chain: { id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }, transport: http(RPC) })

let failures = 0
let warnings = 0
const pass = (m) => console.log(`PASS  ${m}`)
const fail = (m) => {
  failures++
  console.log(`FAIL  ${m}`)
}
const warn = (m) => {
  warnings++
  console.log(`WARN  ${m}`)
}
const check = (ok, m) => (ok ? pass(m) : fail(m))
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const call = async (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args })

console.log(`Verifying chain ${CHAIN_ID} via ${RPC}\nArtifact: ${path.relative(root, file)} (deployedAt ${art.deployedAt ? new Date(art.deployedAt * 1000).toISOString() : 'missing'})\n`)

// 1. Chain and code
check((await client.getChainId()) === CHAIN_ID && art.chainId === CHAIN_ID, `chain id is ${CHAIN_ID} (RPC and artifact agree)`)
const addrs = { riskManager: art.riskManager, marginPool: art.marginPool, marginTrading: art.marginTrading, priceOracle: art.priceOracle }
for (const [name, a] of Object.entries(addrs)) {
  const code = await client.getCode({ address: a })
  check(!!code && code !== '0x', `${name} ${a} has contract code`)
}
if (failures) {
  console.log('\nContracts missing at the artifact addresses. Stopping.')
  process.exit(1)
}

// 2. Wiring
check(eq(await call(art.marginPool, ABI.pool, 'marginTrading'), art.marginTrading), 'pool.marginTrading == MarginTrading')
check(eq(await call(art.marginTrading, ABI.trading, 'pool'), art.marginPool), 'MarginTrading.pool == MarginPool')
check(eq(await call(art.marginTrading, ABI.trading, 'riskManager'), art.riskManager), 'MarginTrading.riskManager == RiskManager')
check(eq(await call(art.riskManager, ABI.risk, 'oracle'), art.priceOracle), 'RiskManager.oracle == OwnerPriceOracle')

// 3. Ownership (two-step: the owner may still be pending acceptance)
for (const [name, a, abi] of [
  ['MarginPool', art.marginPool, ABI.pool],
  ['MarginTrading', art.marginTrading, ABI.trading],
  ['RiskManager', art.riskManager, ABI.risk],
  ['OwnerPriceOracle', art.priceOracle, ABI.oracle],
]) {
  const owner = await call(a, abi, 'owner')
  const pending = await call(a, abi, 'pendingOwner')
  if (eq(owner, art.owner)) pass(`${name} owner is ${art.owner}`)
  else if (eq(owner, art.deployer) && eq(pending, art.owner)) {
    if (requireAccepted) fail(`${name} ownership transfer to ${art.owner} is still PENDING (owner must call acceptOwnership)`)
    else warn(`${name} ownership transfer to ${art.owner} is PENDING acceptance (deployer ${art.deployer} still owns it)`)
  } else fail(`${name} owner ${owner} (pending ${pending}) does not match the artifact owner ${art.owner}`)
}
if (CHAIN_ID === 4663) {
  check(!eq(art.owner, art.deployer), 'mainnet owner differs from the deployer')
  check(!eq(art.oracleUpdater, art.owner) && !eq(art.oracleUpdater, art.deployer), 'mainnet keeper is separate from owner and deployer')
}

// 4. Oracle
check(eq(await call(art.priceOracle, ABI.oracle, 'updater'), art.oracleUpdater), `oracle updater is ${art.oracleUpdater}`)
const p = art.protection ?? {}
check(String(await call(art.priceOracle, ABI.oracle, 'maxMoveBps')) === String(p.maxMoveBpsPerUpdate), `oracle maxMoveBps == ${p.maxMoveBpsPerUpdate}`)
check(String(await call(art.riskManager, ABI.risk, 'maxPriceAge')) === String(p.maxPriceAgeSeconds), `RiskManager maxPriceAge == ${p.maxPriceAgeSeconds}s`)
check(String(await call(art.marginTrading, ABI.trading, 'minHoldSeconds')) === String(p.minHoldSeconds), `MarginTrading minHoldSeconds == ${p.minHoldSeconds}s`)

// 5. Pause state
for (const [name, a, abi] of [['MarginPool', art.marginPool, ABI.pool], ['MarginTrading', art.marginTrading, ABI.trading], ['OwnerPriceOracle', art.priceOracle, ABI.oracle]]) {
  check((await call(a, abi, 'paused')) === false, `${name} is not paused`)
}

// 6. Reserve and pool
const reserve = await call(art.marginTrading, ABI.trading, 'reserve')
check(reserve >= BigInt(p.reserveWei ?? '0'), `settlement reserve ${reserve} wei >= deploy-time reserve ${p.reserveWei} wei`)
const [deposits, borrowed] = await Promise.all([call(art.marginPool, ABI.pool, 'totalDeposits'), call(art.marginPool, ABI.pool, 'totalBorrowed')])
check(borrowed <= deposits, `pool books sane: deposits ${deposits}, borrowed ${borrowed}`)
console.log(`INFO  pool deposits ${deposits} wei, borrowed ${borrowed} wei, reserve ${reserve} wei`)

// 7. Markets and risk parameters
const markets = { ...(art.markets ?? {}) }
const risk = art.marketRisk ?? {}
if (CHAIN_ID === 4663) check(Object.keys(markets).length === 0, 'mainnet has no demo markets in the artifact')
let count = 0
for (const [key, expected] of Object.entries(risk)) {
  const market = markets[key] ?? key // demo entries are keyed by symbol, initial markets by address
  const onchain = await call(art.riskManager, ABI.risk, 'marketRisk', [getAddress(market)])
  const ok =
    onchain.enabled === true &&
    String(onchain.maxLeverageBps) === String(expected.maxLeverageBps) &&
    String(onchain.maintenanceBps) === String(expected.maintenanceBps) &&
    String(onchain.maxBorrow) === String(expected.maxBorrowWei)
  check(ok, `market ${key} (${market}) risk: leverage ${onchain.maxLeverageBps}bps, maintenance ${onchain.maintenanceBps}bps, cap ${onchain.maxBorrow} wei`)
  if (onchain.maxLeverageBps > 100_000) fail(`market ${key} exceeds the 10x protocol ceiling`)
  const [price] = await call(art.priceOracle, ABI.oracle, 'getPrice', [getAddress(market)])
  console.log(`INFO  market ${key}: oracle price ${price === 0n ? 'not set yet (keeper has not pushed the first price)' : price}`)
  count++
}
check(count === Object.keys(risk).length, `${count} registered market(s) checked`)
if (CHAIN_ID === 4663) check(eq(art.ponsV2Factory ?? '', PONS_FACTORY), 'artifact records the Pons V2 factory address')

// 8. The frontend/keeper registry must list exactly the markets that are registered on chain
const registryFile = path.join(
  root,
  CHAIN_ID === 31337 ? 'src/chain/pons-markets.local.json' : CHAIN_ID === 4663 ? 'src/chain/pons-markets.mainnet.json' : 'src/chain/pons-markets.json',
)
if (fs.existsSync(registryFile) && Array.isArray(art.initialMarkets) && art.initialMarkets.length) {
  const reg = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
  const a = new Set(art.initialMarkets.map((x) => x.toLowerCase()))
  const b = new Set((reg.markets ?? []).map((m) => m.token.toLowerCase()))
  check(
    a.size === b.size && [...a].every((x) => b.has(x)),
    `${path.relative(root, registryFile)} lists exactly the artifact initialMarkets (fix: npm run pons:prepare -- --from-artifact)`,
  )
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}${warnings ? ` (${warnings} warning${warnings > 1 ? 's' : ''})` : ''}`)
process.exit(failures ? 1 : 0)
