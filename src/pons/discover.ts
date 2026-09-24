import { createPublicClient, formatEther, http, type Address, type Hex } from 'viem'
import { PONS_RPC_URL, PONS_SCAN_CHUNK } from './config'
import {
  DEFAULT_RULES,
  PERMANENT_REASONS,
  eligibilityReasons,
  readDynamic,
  readStatic,
  scanLaunches,
  type PonsClient,
  type PonsDynamic,
  type PonsRules,
  type PonsStatic,
  type RawLaunch,
} from './eligibility'

/**
 * Automatic, incremental discovery of Pons V2 launches for the /trade market list. Read-only (Robinhood Chain mainnet).
 *
 * How it stays cheap:
 *  - the first refresh scans a bounded window of recent blocks; every later refresh scans ONLY the blocks since the last one;
 *  - facts that never change (name, symbol, decimals, factory confirmation) are read once per launch and cached, in memory and
 *    in localStorage, so a page reload does not start over;
 *  - launches rejected for good (not ETH-quoted, impersonation, ...) are never read again;
 *  - only a bounded number of live candidates get their curve state refreshed each poll, a few at a time (the public RPC mishandles JSON-RPC batches under load, so none are used);
 *  - polling is slow (default once a minute) and only runs while something is using it (retain/release).
 *
 * The eligibility rules are the shared ones in ./eligibility (the same code `pons:prepare` runs).
 *
 * A DISCOVERED market is only a Pons launch that passes the rules. It is not a Marginpad market: whether Marginpad has registered
 * it, and whether it can be traded, is decided by the Marginpad contracts (see StoreContext).
 */

export interface PonsMarketInfo {
  token: Address
  curve: Address
  deployer: Address
  pairToken: Address
  launchConfigId: bigint
  graduationThreshold: bigint
  name: string
  symbol: string
  decimals: number
  /** unix seconds */
  launchedAt: number
  blockNumber: bigint
  txHash: Hex
  /** the curve has graduated: its price is no longer the bonding-curve price */
  graduated: boolean
  /** curve spot price, wei of ETH per whole token, before fees. Display only: never a trading price. */
  price: bigint | null
  /** real quote reserve / graduation threshold */
  progress: number
  /** passes every rule right now (a graduated launch is listed for status only and is not eligible) */
  eligible: boolean
  reasons: string[]
}

export type DiscoveryStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface DiscoveryState {
  status: DiscoveryStatus
  markets: PonsMarketInfo[]
  /** last block scanned for launches */
  lastBlock: bigint | null
  /** ms timestamp of the last successful refresh */
  updatedAt: number
  error?: string
}

interface Entry {
  raw: RawLaunch
  info?: PonsStatic
  dyn?: PonsDynamic
  /** permanent rejection reason (never re-read) */
  rejected?: string
}

export interface DiscoveryOptions {
  client: PonsClient
  rules?: PonsRules
  now?: () => number
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  pollMs?: number
  /** blocks to look back on the very first refresh */
  lookbackBlocks?: bigint
  chunk?: bigint
  /** most live candidates whose curve state is refreshed per poll */
  maxTracked?: number
  /** most new launches whose static facts are read per refresh */
  maxNewPerRefresh?: number
  /** most eligible markets exposed */
  maxMarkets?: number
}

/** The public RPC rejects large bursts from a browser, so launches are read a few at a time. */
const CONCURRENCY = 4

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++])
    }),
  )
}

const CACHE_KEY = 'marginpad.pons.discovery.v1'
const ZERO = '0x0000000000000000000000000000000000000000'

export function createDiscovery(opts: DiscoveryOptions) {
  const rules = opts.rules ?? DEFAULT_RULES
  const now = opts.now ?? Date.now
  const pollMs = opts.pollMs ?? 60_000
  const lookback = opts.lookbackBlocks ?? 300_000n
  const chunk = opts.chunk ?? BigInt(PONS_SCAN_CHUNK)
  const maxTracked = opts.maxTracked ?? 60
  const maxNewPerRefresh = opts.maxNewPerRefresh ?? 24
  const maxMarkets = opts.maxMarkets ?? 24
  const storage = opts.storage ?? null

  const entries = new Map<string, Entry>()
  let lastBlock: bigint | null = null
  /** newest block already old enough to be eligible (lower bound for the next search) */
  let cutoffBlock: bigint | null = null
  let state: DiscoveryState = { status: 'idle', markets: [], lastBlock: null, updatedAt: 0 }
  const listeners = new Set<() => void>()
  let inflight: Promise<void> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let users = 0

  const emit = (next: Partial<DiscoveryState>) => {
    state = { ...state, ...next }
    listeners.forEach((l) => l())
  }

  /* ---- cache ---- */
  const load = () => {
    if (!storage) return
    try {
      const raw = storage.getItem(CACHE_KEY)
      if (!raw) return
      const c = JSON.parse(raw)
      if (c.v !== 1 || typeof c.lastBlock !== 'string') return
      for (const e of c.entries as { raw: Record<string, string>; info?: PonsStatic; rejected?: string }[]) {
        const r = e.raw
        entries.set(r.token.toLowerCase(), {
          raw: {
            token: r.token as Address,
            curve: r.curve as Address,
            deployer: r.deployer as Address,
            pairToken: r.pairToken as Address,
            launchConfigId: BigInt(r.launchConfigId),
            graduationThreshold: BigInt(r.graduationThreshold),
            blockNumber: BigInt(r.blockNumber),
            txHash: r.txHash as Hex,
          },
          info: e.info,
          rejected: e.rejected,
        })
      }
      lastBlock = BigInt(c.lastBlock)
    } catch {
      entries.clear()
      lastBlock = null
    }
  }
  const save = () => {
    if (!storage || lastBlock === null) return
    try {
      // Keep what is still useful: candidates with their facts first, then launches not read yet (newest first). Launches
      // rejected for good are dropped (the scan never revisits old blocks, so they are not re-added).
      const keep = [...entries.values()].filter((e) => !e.rejected)
      keep.sort((a, b) => Number(!!b.info) - Number(!!a.info) || Number(b.raw.blockNumber - a.raw.blockNumber))
      const newest = keep.slice(0, 600)
      storage.setItem(
        CACHE_KEY,
        JSON.stringify({
          v: 1,
          lastBlock: lastBlock.toString(),
          entries: newest.map((e) => ({
            raw: {
              token: e.raw.token,
              curve: e.raw.curve,
              deployer: e.raw.deployer,
              pairToken: e.raw.pairToken,
              launchConfigId: e.raw.launchConfigId.toString(),
              graduationThreshold: e.raw.graduationThreshold.toString(),
              blockNumber: e.raw.blockNumber.toString(),
              txHash: e.raw.txHash,
            },
            info: e.info,
            rejected: e.rejected,
          })),
        }),
      )
    } catch {
      // storage full or blocked: the cache is only an optimisation
    }
  }

  /* ---- evaluation ---- */
  const toMarket = (e: Entry, nowSeconds: number): PonsMarketInfo | null => {
    if (!e.info || !e.dyn) return null
    const reasons = eligibilityReasons(e.info, e.dyn, nowSeconds, rules)
    return {
      ...e.raw,
      name: e.info.name,
      symbol: e.info.symbol,
      decimals: e.info.decimals,
      launchedAt: e.info.launchedAt,
      graduated: e.dyn.graduated,
      price: e.dyn.price,
      progress: e.dyn.progress,
      eligible: reasons.length === 0,
      reasons,
    }
  }

  const buildMarkets = (): PonsMarketInfo[] => {
    const nowSeconds = Math.floor(now() / 1000)
    const out: PonsMarketInfo[] = []
    for (const e of entries.values()) {
      const m = toMarket(e, nowSeconds)
      // Listed: eligible launches, and launches that were live and have since graduated (so their status can be shown).
      if (m && (m.eligible || m.graduated)) out.push(m)
    }
    out.sort((a, b) => Number(b.blockNumber - a.blockNumber))
    const eligible = out.filter((m) => m.eligible).slice(0, maxMarkets)
    return [...eligible, ...out.filter((m) => m.graduated)]
  }

  const doRefresh = async () => {
    if (state.status === 'idle' || state.markets.length === 0) emit({ status: 'loading' })
    try {
      const latest = await opts.client.getBlockNumber()

      // 1. incremental scan: only blocks since the last refresh
      const windowStart = latest > lookback ? latest - lookback : 0n
      // A cache older than the lookback window is stale: scan the window again instead of trusting a gap.
      const from = lastBlock === null || lastBlock < windowStart ? windowStart : lastBlock + 1n
      const found: RawLaunch[] = []
      for (let start = from; start <= latest; start += chunk) {
        const end = start + chunk - 1n > latest ? latest : start + chunk - 1n
        found.push(...(await scanLaunches(opts.client, start, end)))
      }
      for (const raw of found) {
        const key = raw.token.toLowerCase()
        if (!entries.has(key)) entries.set(key, { raw, rejected: raw.pairToken.toLowerCase() === ZERO ? undefined : 'not ETH-quoted' })
      }
      lastBlock = latest

      // 2. static facts, once per launch (newest first, bounded per refresh)
      // Launches too young to be eligible are not read at all yet. Block timestamps only ever increase, so the newest block
      // that is already old enough is found by binary search (cheap, and reused as the lower bound next time). Block NUMBERS are
      // not a reliable clock on this chain, so no estimate from them is used.
      const unread = [...entries.values()].filter((e) => !e.info && !e.rejected)
      let oldEnough: (e: Entry) => boolean = () => true
      if (unread.length > 0 && rules.minAgeSeconds > 0) {
        const tip = await opts.client.getBlock({ blockNumber: latest })
        const target = tip.timestamp - BigInt(rules.minAgeSeconds)
        let lo = cutoffBlock ?? 0n
        let hi = latest
        while (lo < hi) {
          const mid = (lo + hi + 1n) / 2n
          const ts = (await opts.client.getBlock({ blockNumber: mid })).timestamp
          if (ts <= target) lo = mid
          else hi = mid - 1n
        }
        cutoffBlock = lo
        const cutoff = lo
        oldEnough = (e) => e.raw.blockNumber <= cutoff
      }
      const needStatic = unread
        .filter(oldEnough)
        .sort((a, b) => Number(b.raw.blockNumber - a.raw.blockNumber))
        .slice(0, maxNewPerRefresh)
      await mapLimit(needStatic, CONCURRENCY, async (e) => {
        try {
          const r = await readStatic(opts.client, e.raw)
          if (r.ok) e.info = r.info
          else e.rejected = r.reason
        } catch {
          // network error: leave it, it is retried on the next refresh
        }
      })

      // 3. live curve state for the newest candidates
      const live = [...entries.values()]
        .filter((e) => e.info && !e.rejected)
        .sort((a, b) => Number(b.raw.blockNumber - a.raw.blockNumber))
        .slice(0, maxTracked)
      await mapLimit(live, CONCURRENCY, async (e) => {
          try {
            e.dyn = await readDynamic(opts.client, e.raw)
            // A rejection that can only get worse is remembered so the launch is not refreshed again. A graduated launch stays
            // in the list (status only) but is never read again either.
            if (e.dyn.graduated) e.rejected = 'graduated'
            else if (eligibilityReasons(e.info!, e.dyn, Math.floor(now() / 1000), rules).some((r) => PERMANENT_REASONS.has(r))) e.rejected = 'permanent'
          } catch {
            // keep the previous state for this launch
          }
      })

      save()
      emit({ status: 'ready', markets: buildMarkets(), lastBlock, updatedAt: now(), error: undefined })
    } catch (e) {
      // RPC failure: keep whatever we already know, report the error, try again on the next poll.
      const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? 'RPC error'
      emit({ status: state.markets.length ? 'ready' : 'error', error: msg })
    }
  }

  const refresh = () => (inflight ??= doRefresh().finally(() => (inflight = null)))

  load()
  if (entries.size) emit({ markets: buildMarkets(), lastBlock })

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh,
    /** Start polling while at least one consumer is using discovery. Returns the release function. */
    retain() {
      users++
      if (users === 1) {
        void refresh()
        timer = setInterval(() => {
          if (typeof document === 'undefined' || !document.hidden) void refresh()
        }, pollMs)
      }
      return () => {
        users--
        if (users === 0 && timer) {
          clearInterval(timer)
          timer = null
        }
      }
    },
  }
}

export type PonsDiscovery = ReturnType<typeof createDiscovery>

let singleton: PonsDiscovery | null = null

/** The app-wide discovery instance (created on first use so importing this file has no side effects). */
export function getPonsDiscovery(): PonsDiscovery {
  if (!singleton) {
    const client = createPublicClient({
      chain: { id: 4663, name: 'Robinhood Chain (read-only)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [PONS_RPC_URL] } } },
      // No JSON-RPC batching: the public RPC returns malformed batch responses under load, which failed random reads.
      transport: http(PONS_RPC_URL, { retryCount: 2 }),
    })
    let storage: Storage | null = null
    try {
      storage = typeof localStorage === 'undefined' ? null : localStorage
    } catch {
      storage = null
    }
    singleton = createDiscovery({ client: client as unknown as PonsClient, storage })
    // Development aid: inspect discovery state from the browser console (window.__ponsDiscovery.getSnapshot()).
    if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __ponsDiscovery: PonsDiscovery }).__ponsDiscovery = singleton
  }
  return singleton
}

/** Curve price as a plain ETH number for display (the trading price always comes from the Marginpad oracle). */
export const ponsPriceEth = (m: Pick<PonsMarketInfo, 'price'>): number | null => (m.price === null ? null : Number(formatEther(m.price)))
