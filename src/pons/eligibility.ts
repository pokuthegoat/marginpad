/**
 * The ONE implementation of "is this Pons launch eligible to be a Marginpad market?". It is used by the frontend discovery
 * (src/pons/discover.ts) and by the operator scripts (scripts/pons-prepare.mjs, scripts/pons-mirror.mjs register), so the
 * rules can never drift apart.
 *
 * Read-only: it only reads Pons on Robinhood Chain mainnet. Nothing here signs or sends a transaction, and it imports nothing
 * browser-specific, so Node can load it directly (erasable TypeScript only).
 */
import { parseAbi, parseAbiItem, zeroAddress, type Address, type Hex } from 'viem'

/** Pons V2 launch factory on Robinhood Chain mainnet (official docs, official repo, confirmed on chain). */
export const PONS_V2_FACTORY: Address = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'

const tokenLaunched = parseAbiItem(
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
)
const factoryAbi = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
])
const curveAbi = parseAbi([
  'function token() view returns (address)',
  'function graduated() view returns (bool)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
])
const erc20Abi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)'])

/* ---------- Rules ---------- */

/** Pons lets anyone launch any name. A token must never be listed under the name of a well-known asset. */
export const RESERVED_SYMBOLS = [
  'ETH', 'WETH', 'BTC', 'WBTC', 'CBBTC', 'USDT', 'USDC', 'USDG', 'DAI', 'PYUSD', 'SOL', 'BNB', 'XRP', 'HOOD', 'TSLA', 'AAPL', 'NVDA', 'SPY', 'QQQ', 'PONS',
]

export interface PonsRules {
  /** A brand-new curve is the easiest to manipulate: a launch must be at least this old. */
  minAgeSeconds: number
  /** Real quote reserve / graduation threshold must be below this, so a market is unlikely to freeze right after listing. */
  maxGraduationProgress: number
  reservedSymbols: readonly string[]
}

export const DEFAULT_RULES: PonsRules = { minAgeSeconds: 3600, maxGraduationProgress: 0.5, reservedSymbols: RESERVED_SYMBOLS }

/* ---------- Types ---------- */

/** What the factory TokenLaunched event says. */
export interface RawLaunch {
  token: Address
  curve: Address
  deployer: Address
  pairToken: Address
  launchConfigId: bigint
  graduationThreshold: bigint
  blockNumber: bigint
  txHash: Hex
}

/** Facts that never change once a launch exists. */
export interface PonsStatic {
  name: string
  symbol: string
  decimals: number
  /** unix seconds of the launch block */
  launchedAt: number
}

/** Facts that change as the curve trades. */
export interface PonsDynamic {
  graduated: boolean
  /** wei of quote (ETH) per whole token (1e18-scaled), or null when there is no valid price */
  price: bigint | null
  realQuoteReserve: bigint
  /** realQuoteReserve / graduationThreshold, 0..1+ */
  progress: number
}

/** The minimal read-only client the rules need (a viem PublicClient satisfies it; tests pass a fake). */
export interface PonsClient {
  getBlockNumber(): Promise<bigint>
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
  getLogs(args: { address: Address; event: typeof tokenLaunched; fromBlock: bigint; toBlock: bigint }): Promise<
    { args: Partial<Omit<RawLaunch, 'blockNumber' | 'txHash'>>; blockNumber: bigint; transactionHash: Hex }[]
  >
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>
}

/** Reasons a launch can be rejected for good (they cannot become true later). */
export const PERMANENT_REASONS = new Set([
  'not ETH-quoted',
  'invalid token contract',
  'factory does not confirm the launch',
  'unsupported decimals',
  'impersonates a well-known asset',
  'graduated',
  'close to graduating',
])

/* ---------- Pure helpers ---------- */

/** Curve spot price: quoteReserve / tokenReserve as wei per whole token (1e18-scaled). null if not usable as an oracle price. */
export function curvePriceWei(quoteReserve: bigint, tokenReserve: bigint): bigint | null {
  if (quoteReserve <= 0n || tokenReserve <= 0n) return null
  const p = (quoteReserve * 10n ** 18n) / tokenReserve
  return p > 0n && p < 2n ** 128n ? p : null
}

export function graduationProgress(realQuoteReserve: bigint, graduationThreshold: bigint): number {
  if (graduationThreshold <= 0n) return 1
  return Number((realQuoteReserve * 10_000n) / graduationThreshold) / 10_000
}

/** Every reason this launch is NOT eligible right now (empty = eligible). Pure, so it is easy to test. */
export function eligibilityReasons(s: PonsStatic, d: PonsDynamic, nowSeconds: number, rules: PonsRules = DEFAULT_RULES): string[] {
  const reasons: string[] = []
  const upper = (x: string) => x.trim().toUpperCase()
  if (rules.reservedSymbols.includes(upper(s.symbol)) || rules.reservedSymbols.includes(upper(s.name))) {
    reasons.push('impersonates a well-known asset')
  }
  if (d.graduated) reasons.push('graduated')
  if (d.price === null) reasons.push('no valid price')
  if (nowSeconds - s.launchedAt < rules.minAgeSeconds) reasons.push('too new')
  if (d.progress >= rules.maxGraduationProgress && !d.graduated) reasons.push('close to graduating')
  return reasons
}

/* ---------- Reads ---------- */

/**
 * The launch events of the factory between two blocks. RPCs cap a log query (10,000 results on Robinhood Chain), so a window
 * that fails is split in half and retried.
 */
export async function scanLaunches(client: PonsClient, from: bigint, to: bigint, factory: Address = PONS_V2_FACTORY, depth = 0): Promise<RawLaunch[]> {
  if (to < from) return []
  try {
    const logs = await client.getLogs({ address: factory, event: tokenLaunched, fromBlock: from, toBlock: to })
    const out: RawLaunch[] = []
    for (const l of logs) {
      const a = l.args
      if (!a.token || !a.curve || !a.deployer || !a.pairToken) continue
      out.push({
        token: a.token,
        curve: a.curve,
        deployer: a.deployer,
        pairToken: a.pairToken,
        launchConfigId: a.launchConfigId ?? 0n,
        graduationThreshold: a.graduationThreshold ?? 0n,
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
      })
    }
    return out
  } catch (e) {
    if (depth >= 4 || to <= from) throw e
    const mid = from + (to - from) / 2n
    const newer = await scanLaunches(client, mid + 1n, to, factory, depth + 1)
    const older = await scanLaunches(client, from, mid, factory, depth + 1)
    return [...newer, ...older]
  }
}

/**
 * True when a failed read is the CONTRACT saying no (revert, no code, undecodable return data), as opposed to a transport error
 * (timeout, rate limit, HTTP failure). Only the former may permanently reject a launch; the latter must be retried later.
 */
export function isContractError(e: unknown): boolean {
  let x = e as { name?: string; cause?: unknown; shortMessage?: string; message?: string } | undefined
  for (let i = 0; x && i < 6; i++) {
    const n = x.name ?? ''
    if (n === 'ContractFunctionRevertedError' || n === 'ContractFunctionZeroDataError' || n === 'AbiDecodingZeroDataError' || n === 'AbiDecodingDataSizeTooSmallError') return true
    x = x.cause as typeof x
  }
  const msg = String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? '')
  return /execution reverted|returned no data|out of gas|invalid opcode/i.test(msg)
}

export type StaticResult = { ok: true; info: PonsStatic } | { ok: false; reason: string }

/**
 * The facts that never change, verified against Pons itself: the factory must confirm the launch, the curve must belong to the
 * token, the token must be a normal 18-decimals ERC-20, and it must be ETH-quoted. A launch that fails here is rejected for good.
 * Throws only for network errors (so the caller can retry later instead of treating the launch as bad).
 */
export async function readStatic(client: PonsClient, raw: RawLaunch, factory: Address = PONS_V2_FACTORY): Promise<StaticResult> {
  if (raw.pairToken !== zeroAddress) return { ok: false, reason: 'not ETH-quoted' }
  const call = (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi, functionName, args })

  const [launch, curveToken, name, symbol, decimals, block] = await Promise.all([
    call(factory, factoryAbi, 'getLaunchedToken', [raw.token]).then(
      (v) => ({ v: v as { exists: boolean; curve: Address; pairToken: Address } }),
      (e) => ({ e }),
    ),
    call(raw.curve, curveAbi, 'token').then((v) => ({ v: v as Address }), (e) => ({ e })),
    call(raw.token, erc20Abi, 'name').then((v) => ({ v: v as string }), (e) => ({ e })),
    call(raw.token, erc20Abi, 'symbol').then((v) => ({ v: v as string }), (e) => ({ e })),
    call(raw.token, erc20Abi, 'decimals').then((v) => ({ v: Number(v) }), (e) => ({ e })),
    client.getBlock({ blockNumber: raw.blockNumber }),
  ])

  // The factory answering is the one call that must succeed: if it errors we cannot tell good from bad, so surface it.
  if ('e' in launch) throw launch.e
  if (!launch.v.exists || launch.v.curve.toLowerCase() !== raw.curve.toLowerCase() || launch.v.pairToken !== zeroAddress) {
    return { ok: false, reason: 'factory does not confirm the launch' }
  }
  // A revert means the contract really is not a valid token. Any other failure is the network: surface it so it is retried.
  for (const r of [curveToken, name, symbol, decimals]) if ('e' in r && !isContractError(r.e)) throw r.e
  if ('e' in curveToken || curveToken.v.toLowerCase() !== raw.token.toLowerCase()) return { ok: false, reason: 'invalid token contract' }
  if ('e' in name || 'e' in symbol || 'e' in decimals) return { ok: false, reason: 'invalid token contract' }
  if (decimals.v !== 18) return { ok: false, reason: 'unsupported decimals' }
  return { ok: true, info: { name: name.v, symbol: symbol.v, decimals: decimals.v, launchedAt: Number(block.timestamp) } }
}

/** Current curve state. Throws on network errors; returns price null when the curve has no usable price. */
export async function readDynamic(client: PonsClient, raw: Pick<RawLaunch, 'curve' | 'graduationThreshold'>): Promise<PonsDynamic> {
  const call = (functionName: string) => client.readContract({ address: raw.curve, abi: curveAbi, functionName, args: [] })
  const [graduated, reserves, real] = await Promise.all([call('graduated'), call('getReserves'), call('realQuoteReserve')])
  const [q, t] = reserves as readonly [bigint, bigint]
  const realQuoteReserve = real as bigint
  return {
    graduated: graduated === true,
    price: graduated === true ? null : curvePriceWei(q, t),
    realQuoteReserve,
    progress: graduationProgress(realQuoteReserve, raw.graduationThreshold),
  }
}

/* ---------- One-shot selection for the operator scripts ---------- */

export interface Eligible {
  raw: RawLaunch
  info: PonsStatic
  dynamic: PonsDynamic
}

/**
 * Newest-first search for `count` eligible launches, applying exactly the rules above. Used by `pons:prepare` and by the
 * registration helper. Counts every rejection reason so an operator can see why nothing (or little) was found.
 */
export async function findEligible(
  client: PonsClient,
  opts: { count: number; rules?: PonsRules; chunk?: bigint; maxWindows?: number; factory?: Address },
): Promise<{ picked: Eligible[]; rejected: Record<string, number> }> {
  const rules = opts.rules ?? DEFAULT_RULES
  const chunk = opts.chunk ?? 100_000n
  const maxWindows = opts.maxWindows ?? 12
  const factory = opts.factory ?? PONS_V2_FACTORY
  const picked: Eligible[] = []
  const rejected: Record<string, number> = {}
  const reject = (why: string) => {
    rejected[why] = (rejected[why] ?? 0) + 1
  }
  const seenSymbols = new Set<string>()

  const latest = await client.getBlockNumber()
  const now = Number((await client.getBlock({ blockNumber: latest })).timestamp)
  // Start at the newest block that is already old enough, so brand-new launches are never even fetched.
  const ref = await client.getBlock({ blockNumber: latest > chunk ? latest - chunk : 0n })
  const secondsPerBlock = Math.max(0.05, (now - Number(ref.timestamp)) / Number(latest > chunk ? chunk : latest || 1n))
  const startBlock = latest - BigInt(Math.ceil(rules.minAgeSeconds / secondsPerBlock))

  for (let i = 0; i < maxWindows && picked.length < opts.count; i++) {
    const to = startBlock - BigInt(i) * chunk
    if (to < 0n) break
    const from = to - chunk + 1n
    const raws = (await scanLaunches(client, from < 0n ? 0n : from, to, factory)).sort((a, b) => Number(b.blockNumber - a.blockNumber))
    for (const raw of raws) {
      if (picked.length >= opts.count) break
      try {
        const st = await readStatic(client, raw, factory)
        if (!st.ok) {
          reject(st.reason)
          continue
        }
        const dynamic = await readDynamic(client, raw)
        const reasons = eligibilityReasons(st.info, dynamic, now, rules)
        if (reasons.length) {
          reasons.forEach(reject)
          continue
        }
        const key = st.info.symbol.toUpperCase()
        if (seenSymbols.has(key)) {
          reject('duplicate symbol')
          continue
        }
        seenSymbols.add(key)
        picked.push({ raw, info: st.info, dynamic })
      } catch (e) {
        reject(`read error: ${((e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? 'unknown').slice(0, 60)}`)
      }
    }
  }
  return { picked, rejected }
}

/**
 * For a token that is ALREADY registered somewhere: confirm it is a real Pons V2 launch and read its current facts. The
 * eligibility rules are for admission and are not re-applied. Returns null if the factory does not know the token.
 */
export async function describeLaunch(
  client: PonsClient,
  token: Address,
  factory: Address = PONS_V2_FACTORY,
): Promise<{ curve: Address; name: string; symbol: string; dynamic: PonsDynamic } | null> {
  const call = (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi, functionName, args })
  const launch = (await call(factory, factoryAbi, 'getLaunchedToken', [token])) as { exists: boolean; curve: Address; graduationThreshold: bigint }
  if (!launch.exists) return null
  const [name, symbol, dynamic] = await Promise.all([
    call(token, erc20Abi, 'name') as Promise<string>,
    call(token, erc20Abi, 'symbol') as Promise<string>,
    readDynamic(client, launch),
  ])
  return { curve: launch.curve, name, symbol, dynamic }
}
