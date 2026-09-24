// Pons markets for Marginpad: a registration helper and the price KEEPER.
// Pons is always READ from Robinhood Chain mainnet. Transactions go only to the Marginpad chain you target.
//
//   node scripts/pons-mirror.mjs register   pick recent ETH-quoted Pons launches, register them as markets on the
//                                           Marginpad contracts and push their first price (owner key)
//   node scripts/pons-mirror.mjs mirror     the KEEPER: keep pushing each curve price into the OwnerPriceOracle in steps
//                                           no larger than the oracle move limit, and mark a market graduated (freezing
//                                           it) when its curve graduates (updater key)
//
// Target chain: MIRROR_CHAIN=31337 (default, local Anvil), 46630 (Robinhood testnet) or 4663 (Robinhood mainnet: mirror
// mode only, and only with CONFIRM_MAINNET=I_UNDERSTAND_THIS_USES_REAL_FUNDS; PRIVATE_KEY is then the oracle UPDATER key).
// Registration risk defaults are conservative: PONS_MAX_LEVERAGE_BPS=15000, PONS_MAINTENANCE_BPS=1000, PONS_MAX_BORROW_ETH=1.
// Env: MIRROR_RPC (target RPC), PRIVATE_KEY (required except on 31337, where the public Anvil key is used),
//      PONS_RPC_URL (mainnet, read-only), PONS_MARKETS (how many to register, default 4).
import fs from 'node:fs'
import path from 'node:path'
import { createPublicClient, createWalletClient, formatUnits, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { DEFAULT_RULES, findEligible, readDynamic } from '../src/pons/eligibility.ts'
import { ANVIL_KEY, root } from './env.mjs'

const mode = process.argv[2]
if (mode !== 'register' && mode !== 'mirror') {
  console.error('Usage: node scripts/pons-mirror.mjs register|mirror')
  process.exit(1)
}

const CHAIN_ID = Number(process.env.MIRROR_CHAIN ?? 31337)
if (CHAIN_ID !== 31337 && CHAIN_ID !== 46630 && CHAIN_ID !== 4663) {
  console.error(`Refusing chain ${CHAIN_ID}: only 31337 (Anvil), 46630 (Robinhood testnet) and 4663 (mainnet, guarded) are allowed.`)
  process.exit(1)
}
if (CHAIN_ID === 4663) {
  if (process.env.CONFIRM_MAINNET !== 'I_UNDERSTAND_THIS_USES_REAL_FUNDS') {
    console.error('Chain 4663 is real funds. Set CONFIRM_MAINNET=I_UNDERSTAND_THIS_USES_REAL_FUNDS to run the keeper there.')
    process.exit(1)
  }
  if (mode === 'register') {
    console.error('Registering markets on mainnet is an owner (multisig) action: call RiskManager.setMarketRisk from the owner. Not scripted here.')
    process.exit(1)
  }
}
const TARGET_RPC =
  process.env.MIRROR_RPC ??
  (CHAIN_ID === 31337
    ? 'http://127.0.0.1:8545'
    : CHAIN_ID === 4663
      ? 'https://rpc.mainnet.chain.robinhood.com'
      : 'https://rpc.testnet.chain.robinhood.com')
const PONS_RPC = process.env.PONS_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const PONS_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e' // Pons V2 factory, Robinhood Chain mainnet (read-only)
const COUNT = Number(process.env.PONS_MARKETS ?? 4)

const key = process.env.PRIVATE_KEY ?? (CHAIN_ID === 31337 ? ANVIL_KEY : undefined)
if (!key) {
  console.error(`Set PRIVATE_KEY (registration: the contract owner; mirror: the oracle updater) for chain ${CHAIN_ID}.`)
  process.exit(1)
}
if (CHAIN_ID !== 31337 && key.toLowerCase() === ANVIL_KEY) {
  console.error('Refusing the public Anvil key on a public chain.')
  process.exit(1)
}

const depFile = path.join(root, `contracts/deployments/${CHAIN_ID}.json`)
if (!fs.existsSync(depFile)) {
  console.error(`No deployment at ${depFile}. Deploy the contracts to chain ${CHAIN_ID} first.`)
  process.exit(1)
}
const dep = JSON.parse(fs.readFileSync(depFile, 'utf8'))
const abiOf = (name) => JSON.parse(fs.readFileSync(path.join(root, `contracts/out/${name}.sol/${name}.json`), 'utf8')).abi
const riskAbi = abiOf('RiskManager')
const oracleAbi = abiOf('OwnerPriceOracle')

const chainDef = (id, rpc) => ({ id, name: `chain-${id}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
const target = createPublicClient({ chain: chainDef(CHAIN_ID, TARGET_RPC), transport: http(TARGET_RPC) })
const account = privateKeyToAccount(key)
const wallet = createWalletClient({ account, chain: chainDef(CHAIN_ID, TARGET_RPC), transport: http(TARGET_RPC) })
const mainnet = createPublicClient({ chain: chainDef(4663, PONS_RPC), transport: http(PONS_RPC) }) // READ ONLY: no wallet is ever attached

if ((await target.getChainId()) !== CHAIN_ID) {
  console.error(`RPC ${TARGET_RPC} is not chain ${CHAIN_ID}.`)
  process.exit(1)
}

/**
 * { graduated, price } for a registered curve, from the shared Pons module (the same price maths the app and pons:prepare use).
 * price is wei per whole token (1e18-scaled), or null when the curve graduated or could not be read. A graduated curve is
 * never priced.
 */
async function curveState(curve) {
  try {
    const d = await readDynamic(mainnet, { curve, graduationThreshold: 0n })
    return { graduated: d.graduated, price: d.graduated ? null : d.price }
  } catch {
    return { graduated: false, price: null }
  }
}

const tx = async (address, abi, functionName, args) => {
  const hash = await wallet.writeContract({ address, abi, functionName, args })
  const r = await target.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${functionName} reverted`)
}

const outFile = path.join(
  root,
  CHAIN_ID === 31337 ? 'src/chain/pons-markets.local.json' : CHAIN_ID === 4663 ? 'src/chain/pons-markets.mainnet.json' : 'src/chain/pons-markets.json',
)

if (mode === 'register') {
  // The shared eligibility rules (src/pons/eligibility.ts): the same ones the /trade page and pons:prepare use.
  const rules = {
    ...DEFAULT_RULES,
    minAgeSeconds: Number(process.env.PONS_MIN_AGE_SECONDS ?? DEFAULT_RULES.minAgeSeconds),
    maxGraduationProgress: Number(process.env.PONS_MAX_GRADUATION_PROGRESS ?? DEFAULT_RULES.maxGraduationProgress),
  }
  const { picked: eligible, rejected } = await findEligible(mainnet, { count: COUNT, rules })
  const picked = eligible.map((e) => ({ token: e.raw.token, curve: e.raw.curve, name: e.info.name, symbol: e.info.symbol, price: e.dynamic.price }))
  console.log('rejected while searching:', rejected)
  if (picked.length === 0) {
    console.error('No eligible Pons launches found.')
    process.exit(1)
  }

  for (const m of picked) {
    // Conservative for thin Pons curves: 1.5x max, 10% maintenance, 1 ETH borrow cap per market (env-overridable).
    const risk = {
      enabled: true,
      maxLeverageBps: Number(process.env.PONS_MAX_LEVERAGE_BPS ?? 15_000),
      maintenanceBps: Number(process.env.PONS_MAINTENANCE_BPS ?? 1_000),
      maxBorrow: BigInt(Math.round(Number(process.env.PONS_MAX_BORROW_ETH ?? 1) * 1e6)) * 10n ** 12n,
    }
    await tx(dep.riskManager, riskAbi, 'setMarketRisk', [m.token, risk])
    await tx(dep.priceOracle, oracleAbi, 'setPrice', [m.token, m.price])
    console.log(`registered ${m.symbol} (${m.token})  price ${formatUnits(m.price, 18)} ETH per token`)
  }
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        chainId: CHAIN_ID,
        note: 'Token addresses are Pons MAINNET tokens used as market ids on the Marginpad contracts of this chain.',
        markets: picked.map((m) => ({ token: m.token, curve: m.curve, name: m.name, symbol: m.symbol, initialPrice: Number(formatUnits(m.price, 18)) })),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`wrote ${path.relative(root, outFile)}`)
} else {
  if (!fs.existsSync(outFile)) {
    console.error(`No registered Pons markets file (${path.relative(root, outFile)}). Run the registration/prepare step first.`)
    process.exit(1)
  }
  const { markets } = JSON.parse(fs.readFileSync(outFile, 'utf8'))
  const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`)
  const logErr = (msg) => console.error(`${new Date().toISOString()} ERROR ${msg}`)
  const ownPush = new Map() // token -> the last price this keeper pushed
  const state = new Map() // token -> 'frozen' | 'unreadable' | 'disabled' (to log each change once)
  const setState = (token, s, msg) => {
    if (state.get(token) !== s) log(msg)
    state.set(token, s)
  }
  const read = (address, abi, functionName, args = []) => target.readContract({ address, abi, functionName, args })
  const once = process.env.KEEPER_ONCE === '1'
  const INTERVAL_MS = 5000

  log(`Keeper: mirroring ${markets.length} registered Pons markets (Pons read from mainnet, read-only) into chain ${CHAIN_ID} as ${account.address}`)

  const tick = async () => {
    // Everything the keeper needs to decide comes from the chain it writes to, so a bad Pons read can never widen its limits.
    const [maxMoveBps, maxPriceAge, updater, paused, block] = await Promise.all([
      read(dep.priceOracle, oracleAbi, 'maxMoveBps'),
      read(dep.riskManager, riskAbi, 'maxPriceAge'),
      read(dep.priceOracle, oracleAbi, 'updater'),
      read(dep.priceOracle, oracleAbi, 'paused'),
      target.getBlock(),
    ])
    if (updater.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error(`this key (${account.address}) is not the oracle updater (${updater}). Not pushing anything.`)
    }
    if (paused) {
      log('oracle is paused: not pushing.')
      return
    }
    const refreshAfter = maxPriceAge / 3n // push an unchanged price this often so it never goes stale
    for (const m of markets) {
      // Only registered (enabled) markets are ever updated.
      const cfg = await read(dep.riskManager, riskAbi, 'marketRisk', [m.token])
      if (!cfg.enabled) {
        setState(m.token, 'disabled', `${m.symbol}: not registered/enabled on this chain. Skipping.`)
        continue
      }
      if (await read(dep.priceOracle, oracleAbi, 'graduated', [m.token])) {
        setState(m.token, 'frozen', `${m.symbol}: graduated, price frozen on chain. Not updating.`)
        continue
      }
      const { graduated, price: targetPrice } = await curveState(m.curve)
      if (graduated) {
        // The bonding curve no longer holds the price: freeze the market rather than keep using a curve price.
        try {
          await tx(dep.priceOracle, oracleAbi, 'markGraduated', [m.token])
          setState(m.token, 'frozen', `${m.symbol}: curve graduated. Marked graduated: no new positions, price frozen at the final value.`)
        } catch (e) {
          logErr(`${m.symbol}: markGraduated failed: ${e.shortMessage ?? e.message}`)
        }
        continue
      }
      if (targetPrice === null) {
        // A failed or empty Pons read never triggers an update. The price ages out and trading stops, which is the safe state.
        setState(m.token, 'unreadable', `${m.symbol}: curve price unreadable. Price left as is (it will go stale and stop trading).`)
        continue
      }
      state.delete(m.token)

      const [current, updatedAt] = await read(dep.priceOracle, oracleAbi, 'getPrice', [m.token])
      // Local dev only: if someone else moved the price by hand (demo controls, tests), leave it alone.
      if (CHAIN_ID === 31337 && current > 0n && ownPush.has(m.token) && ownPush.get(m.token) !== current) continue

      // Step toward the target by at most the oracle move limit.
      let next = targetPrice
      if (current > 0n) {
        const step = (current * maxMoveBps) / 10_000n
        if (next > current + step) next = current + step
        else if (next + step < current) next = current - step
      }
      const due = current === 0n || block.timestamp - updatedAt >= refreshAfter
      if (next === current && !due) continue
      try {
        await tx(dep.priceOracle, oracleAbi, 'setPrice', [m.token, next])
        ownPush.set(m.token, next)
        const note = next === targetPrice ? (next === current ? ' (refresh)' : '') : ` (stepping toward ${formatUnits(targetPrice, 18)})`
        log(`${m.symbol}: ${formatUnits(next, 18)} ETH${note}`)
      } catch (e) {
        logErr(`${m.symbol}: push failed: ${e.shortMessage ?? e.message}`)
      }
    }
  }

  let failures = 0
  for (;;) {
    try {
      await tick()
      failures = 0
    } catch (e) {
      failures++
      // Fail safe: stop pushing, keep retrying with backoff. Prices age out on chain if this lasts.
      logErr(`tick failed (${failures} in a row): ${e.shortMessage ?? e.message}${failures >= 5 ? '  KEEPER DEGRADED: prices will go stale' : ''}`)
    }
    if (once) {
      process.exitCode = failures ? 1 : 0
      break
    }
    await new Promise((r) => setTimeout(r, Math.min(INTERVAL_MS * 2 ** Math.min(failures, 4), 60_000)))
  }
}
