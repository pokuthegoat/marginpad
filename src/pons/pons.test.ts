import { beforeEach, describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { createDiscovery } from './discover'
import {
  DEFAULT_RULES,
  curvePriceWei,
  eligibilityReasons,
  findEligible,
  readStatic,
  type PonsClient,
  type PonsDynamic,
  type PonsStatic,
} from './eligibility'
import { applyPonsStatus, defaultMarketId, mergePonsTokens, orderMarkets, tokenFromDiscovery, tokenFromRegistry } from './markets'
import { TOKENS, setDemoMarketsEnabled, setExtraMarkets, allMarkets } from '../store/market'
import { createBlankState, validateOpen } from '../store/store'

/* ---------- a fake Robinhood Chain + Pons V2 factory ---------- */

const NOW = 1_800_000_000 // unix seconds "now" on the fake chain
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const addr = (kind: string, n: number) => `0x${kind.padEnd(2, '0')}${n.toString(16).padStart(38, '0')}` as Address

interface FakeLaunch {
  n: number
  block: bigint
  pairToken?: Address
  graduated?: boolean
  /** curve reserves */
  quote?: bigint
  tokens?: bigint
  real?: bigint
  threshold?: bigint
  name?: string
  symbol?: string
  decimals?: number
  /** the token contract is broken (name() reverts) */
  brokenToken?: boolean
  /** the factory does not know this launch */
  unknownToFactory?: boolean
}

class FakeChain {
  latest = 1_000_000n
  launches: FakeLaunch[] = []
  failRpc = false
  calls = { getLogs: [] as { from: bigint; to: bigint }[], readContract: 0, names: 0 }

  add(l: Partial<FakeLaunch> & { n: number; block?: bigint }) {
    this.launches.push({ block: this.latest - 10_000n, ...l })
  }
  find(a: string) {
    return this.launches.find((l) => addr('a', l.n).toLowerCase() === a.toLowerCase() || addr('c', l.n).toLowerCase() === a.toLowerCase())
  }
  tsOf = (block: bigint) => BigInt(NOW) - (this.latest - block) // 1 second per block

  client(): PonsClient {
    const chain = this
    const check = () => {
      if (chain.failRpc) throw new Error('RPC unavailable')
    }
    return {
      async getBlockNumber() {
        check()
        return chain.latest
      },
      async getBlock({ blockNumber }) {
        check()
        return { timestamp: chain.tsOf(blockNumber) }
      },
      async getLogs({ fromBlock, toBlock }) {
        check()
        chain.calls.getLogs.push({ from: fromBlock, to: toBlock })
        return chain.launches
          .filter((l) => l.block >= fromBlock && l.block <= toBlock)
          .map((l) => ({
            args: {
              token: addr('a', l.n),
              curve: addr('c', l.n),
              deployer: addr('d', l.n),
              pairToken: l.pairToken ?? ZERO,
              launchConfigId: 0n,
              graduationThreshold: l.threshold ?? 72n * 10n ** 18n,
            },
            blockNumber: l.block,
            transactionHash: `0x${l.n.toString(16).padStart(64, '0')}` as Hex,
          }))
      },
      async readContract({ address, functionName }) {
        check()
        chain.calls.readContract++
        const l = chain.find(address)
        if (functionName === 'getLaunchedToken') {
          const target = chain.launches.find((x) => addr('a', x.n).toLowerCase() === (arguments[0] as { args: string[] }).args![0].toLowerCase())
          if (!target || target.unknownToFactory) return { exists: false, curve: ZERO, pairToken: ZERO }
          return { exists: true, curve: addr('c', target.n), pairToken: target.pairToken ?? ZERO, graduationThreshold: target.threshold ?? 72n * 10n ** 18n }
        }
        if (!l) throw new Error('no contract')
        switch (functionName) {
          case 'token':
            return addr('a', l.n)
          case 'graduated':
            return l.graduated === true
          case 'getReserves':
            return [l.quote ?? 1_680_000_000_000_000_000n, l.tokens ?? 10n ** 27n] as const
          case 'realQuoteReserve':
            return l.real ?? 0n
          case 'name':
            chain.calls.names++
            if (l.brokenToken) throw new Error('execution reverted')
            return l.name ?? `Token ${l.n}`
          case 'symbol':
            if (l.brokenToken) throw new Error('execution reverted')
            return l.symbol ?? `TK${l.n}`
          case 'decimals':
            if (l.brokenToken) throw new Error('execution reverted')
            return l.decimals ?? 18
        }
        throw new Error(`unexpected call ${functionName}`)
      },
    }
  }
}

/** Rules with no age requirement, so freshly built fixtures are eligible unless a test says otherwise. */
const OPEN_RULES = { ...DEFAULT_RULES, minAgeSeconds: 0 }
const memoryStorage = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

/* ---------- eligibility rules (pure) ---------- */

const st = (o: Partial<PonsStatic> = {}): PonsStatic => ({ name: 'Cool Coin', symbol: 'COOL', decimals: 18, launchedAt: NOW - 7200, ...o })
const dyn = (o: Partial<PonsDynamic> = {}): PonsDynamic => ({ graduated: false, price: 1_680_000_000n, realQuoteReserve: 0n, progress: 0.01, ...o })

describe('Pons eligibility rules', () => {
  it('accepts a normal, old enough, ETH-quoted, live launch', () => {
    expect(eligibilityReasons(st(), dyn(), NOW)).toEqual([])
  })
  it('rejects graduated launches', () => {
    expect(eligibilityReasons(st(), dyn({ graduated: true, price: null }), NOW)).toContain('graduated')
  })
  it('rejects a launch with no usable price', () => {
    expect(eligibilityReasons(st(), dyn({ price: null }), NOW)).toContain('no valid price')
  })
  it('rejects launches that are too new', () => {
    expect(eligibilityReasons(st({ launchedAt: NOW - 60 }), dyn(), NOW)).toContain('too new')
    expect(eligibilityReasons(st({ launchedAt: NOW - 3600 }), dyn(), NOW)).toEqual([]) // exactly old enough
  })
  it('rejects launches close to graduating', () => {
    expect(eligibilityReasons(st(), dyn({ progress: 0.5 }), NOW)).toContain('close to graduating')
    expect(eligibilityReasons(st(), dyn({ progress: 0.49 }), NOW)).toEqual([])
  })
  it('rejects tokens that impersonate excluded assets by symbol or name, in any case', () => {
    expect(eligibilityReasons(st({ symbol: 'USDT' }), dyn(), NOW)).toContain('impersonates a well-known asset')
    expect(eligibilityReasons(st({ symbol: 'usdc' }), dyn(), NOW)).toContain('impersonates a well-known asset')
    expect(eligibilityReasons(st({ name: 'ETH' }), dyn(), NOW)).toContain('impersonates a well-known asset')
  })
  it('computes the curve price as quote / token reserve, and refuses unusable reserves', () => {
    expect(curvePriceWei(1_680_000_000_000_000_000n, 10n ** 27n)).toBe(1_680_000_000n)
    expect(curvePriceWei(0n, 10n ** 27n)).toBeNull()
    expect(curvePriceWei(1n, 0n)).toBeNull()
    expect(curvePriceWei(2n ** 200n, 1n)).toBeNull() // does not fit the oracle price type
  })
})

/* ---------- reading launches from Pons ---------- */

describe('reading a launch from the Pons factory', () => {
  let chain: FakeChain
  beforeEach(() => {
    chain = new FakeChain()
  })
  const raw = (n: number, pairToken: Address = ZERO) => ({
    token: addr('a', n), curve: addr('c', n), deployer: addr('d', n), pairToken, launchConfigId: 0n, graduationThreshold: 72n * 10n ** 18n, blockNumber: chain.latest - 10_000n, txHash: '0x00' as Hex,
  })

  it('accepts a valid launch and reads its facts', async () => {
    chain.add({ n: 1, name: 'Alpha', symbol: 'ALPHA' })
    const r = await readStatic(chain.client(), raw(1))
    expect(r).toMatchObject({ ok: true, info: { name: 'Alpha', symbol: 'ALPHA', decimals: 18 } })
  })
  it('rejects non-ETH-quoted launches without any RPC call', async () => {
    chain.add({ n: 1, pairToken: addr('e', 9) })
    const r = await readStatic(chain.client(), raw(1, addr('e', 9)))
    expect(r).toEqual({ ok: false, reason: 'not ETH-quoted' })
    expect(chain.calls.readContract).toBe(0)
  })
  it('rejects invalid token contracts', async () => {
    chain.add({ n: 1, brokenToken: true })
    expect(await readStatic(chain.client(), raw(1))).toEqual({ ok: false, reason: 'invalid token contract' })
  })
  it('rejects launches the factory does not confirm', async () => {
    chain.add({ n: 1, unknownToFactory: true })
    expect(await readStatic(chain.client(), raw(1))).toEqual({ ok: false, reason: 'factory does not confirm the launch' })
  })
  it('rejects tokens that are not 18 decimals', async () => {
    chain.add({ n: 1, decimals: 6 })
    expect(await readStatic(chain.client(), raw(1))).toEqual({ ok: false, reason: 'unsupported decimals' })
  })
  it('a transport error while reading the token is retried later, never a permanent rejection', async () => {
    chain.add({ n: 1 })
    const client = chain.client()
    const flaky: PonsClient = {
      ...client,
      readContract: async (a) => {
        if (a.functionName === 'name') throw new Error('HTTP request failed')
        return client.readContract(a)
      },
    }
    await expect(readStatic(flaky, raw(1))).rejects.toThrow('HTTP request failed')
  })
  it('reports RPC failures as errors instead of treating the launch as bad', async () => {
    chain.add({ n: 1 })
    chain.failRpc = true
    await expect(readStatic(chain.client(), raw(1))).rejects.toThrow('RPC unavailable')
  })
})

describe('findEligible (used by pons:prepare and registration)', () => {
  it('finds several eligible launches, newest first, and counts rejections', async () => {
    const chain = new FakeChain()
    chain.add({ n: 1, block: chain.latest - 9_000n })
    chain.add({ n: 2, block: chain.latest - 8_000n })
    chain.add({ n: 3, block: chain.latest - 7_000n, pairToken: addr('e', 1) }) // not ETH
    chain.add({ n: 4, block: chain.latest - 6_000n, graduated: true })
    chain.add({ n: 5, block: chain.latest - 5_000n, symbol: 'USDT' })
    chain.add({ n: 6, block: chain.latest - 4_500n, brokenToken: true })
    const { picked, rejected } = await findEligible(chain.client(), { count: 5, rules: { ...DEFAULT_RULES, minAgeSeconds: 100 } })
    expect(picked.map((p) => p.info.symbol)).toEqual(['TK2', 'TK1'])
    expect(rejected).toMatchObject({ 'not ETH-quoted': 1, graduated: 1, 'impersonates a well-known asset': 1, 'invalid token contract': 1 })
  })
  it('handles no eligible launches', async () => {
    const chain = new FakeChain()
    chain.add({ n: 1, graduated: true })
    const { picked } = await findEligible(chain.client(), { count: 3, rules: OPEN_RULES, maxWindows: 2 })
    expect(picked).toEqual([])
  })
  it('skips launches younger than the minimum age', async () => {
    const chain = new FakeChain()
    chain.add({ n: 1, block: chain.latest - 100n }) // 100 seconds old
    const { picked } = await findEligible(chain.client(), { count: 3, rules: { ...DEFAULT_RULES, minAgeSeconds: 3600 }, maxWindows: 2 })
    expect(picked).toEqual([])
  })
})

/* ---------- automatic, incremental discovery ---------- */

describe('automatic discovery', () => {
  let chain: FakeChain
  let nowMs: number
  const make = (extra = {}) => createDiscovery({ client: chain.client(), rules: OPEN_RULES, now: () => nowMs, lookbackBlocks: 50_000n, chunk: 100_000n, ...extra })
  beforeEach(() => {
    chain = new FakeChain()
    nowMs = NOW * 1000
  })

  it('discovers several eligible launches automatically', async () => {
    chain.add({ n: 1, block: chain.latest - 3000n })
    chain.add({ n: 2, block: chain.latest - 2000n })
    chain.add({ n: 3, block: chain.latest - 1000n })
    const d = make()
    await d.refresh()
    const s = d.getSnapshot()
    expect(s.status).toBe('ready')
    expect(s.markets.map((m) => m.symbol)).toEqual(['TK3', 'TK2', 'TK1'])
    expect(s.markets.every((m) => m.eligible && !m.graduated && m.price !== null)).toBe(true)
  })

  it('filters out non-ETH, graduated, invalid and impersonating launches', async () => {
    chain.add({ n: 1 })
    chain.add({ n: 2, pairToken: addr('e', 1) })
    chain.add({ n: 3, brokenToken: true })
    chain.add({ n: 4, symbol: 'USDT' })
    chain.add({ n: 5, decimals: 8 })
    const d = make()
    await d.refresh()
    expect(d.getSnapshot().markets.map((m) => m.symbol)).toEqual(['TK1'])
  })

  it('handles no eligible launches', async () => {
    chain.add({ n: 1, pairToken: addr('e', 1) })
    const d = make()
    await d.refresh()
    expect(d.getSnapshot()).toMatchObject({ status: 'ready', markets: [] })
  })

  it('is incremental: a later refresh scans only the new blocks and picks up a new launch by itself', async () => {
    chain.add({ n: 1 })
    const d = make()
    await d.refresh()
    expect(d.getSnapshot().markets).toHaveLength(1)
    const first = chain.calls.getLogs.length
    const scannedUpTo = chain.latest

    chain.latest += 500n
    chain.add({ n: 2, block: chain.latest - 100n })
    await d.refresh()
    expect(chain.calls.getLogs.slice(first)).toEqual([{ from: scannedUpTo + 1n, to: chain.latest }])
    expect(d.getSnapshot().markets.map((m) => m.symbol)).toContain('TK2')
  })

  it('does no scanning and no static reads when nothing changed', async () => {
    chain.add({ n: 1 })
    chain.add({ n: 2 })
    const d = make()
    await d.refresh()
    const logsBefore = chain.calls.getLogs.length
    const namesBefore = chain.calls.names
    await d.refresh()
    expect(chain.calls.getLogs.length).toBe(logsBefore) // no new blocks: no log query
    expect(chain.calls.names).toBe(namesBefore) // static facts are cached
  })

  it('updates a market to graduated when its curve graduates', async () => {
    chain.add({ n: 1 })
    const d = make()
    await d.refresh()
    expect(d.getSnapshot().markets[0]).toMatchObject({ eligible: true, graduated: false })

    chain.launches[0].graduated = true
    chain.latest += 10n
    await d.refresh()
    const m = d.getSnapshot().markets[0]
    expect(m).toMatchObject({ graduated: true, eligible: false, price: null })
    expect(m.reasons).toContain('graduated')
  })

  it('a launch becomes eligible once it is old enough', async () => {
    chain.add({ n: 1, block: chain.latest - 100n }) // 100 s old
    const d = make({ rules: { ...DEFAULT_RULES, minAgeSeconds: 600 } })
    await d.refresh()
    expect(d.getSnapshot().markets).toEqual([])
    chain.latest += 700n // 700 more seconds pass
    nowMs += 700_000
    await d.refresh()
    expect(d.getSnapshot().markets.map((m) => m.symbol)).toEqual(['TK1'])
  })

  it('survives RPC failures: reports an error, keeps known markets, then recovers', async () => {
    const d = make()
    chain.failRpc = true
    await d.refresh()
    expect(d.getSnapshot()).toMatchObject({ status: 'error', markets: [] })

    chain.failRpc = false
    chain.add({ n: 1 })
    await d.refresh()
    expect(d.getSnapshot()).toMatchObject({ status: 'ready' })
    expect(d.getSnapshot().markets).toHaveLength(1)

    chain.failRpc = true
    await d.refresh()
    const after = d.getSnapshot()
    expect(after.markets).toHaveLength(1) // still shows what it knows
    expect(after.error).toBeTruthy()
  })

  it('caches across page loads: a new instance does not re-read known launches', async () => {
    chain.add({ n: 1 })
    chain.add({ n: 2 })
    const storage = memoryStorage()
    await make({ storage }).refresh()
    const namesAfterFirst = chain.calls.names
    chain.latest += 10n
    const second = make({ storage })
    expect(second.getSnapshot().lastBlock).not.toBeNull() // hydrated from storage before any RPC
    await second.refresh()
    expect(chain.calls.names).toBe(namesAfterFirst)
    expect(second.getSnapshot().markets).toHaveLength(2)
  })

  it('never lists more eligible markets than the cap', async () => {
    for (let i = 1; i <= 8; i++) chain.add({ n: i, block: chain.latest - BigInt(i) * 100n })
    const d = make({ maxMarkets: 3 })
    await d.refresh()
    expect(d.getSnapshot().markets).toHaveLength(3)
  })
})

/* ---------- discovered vs registered vs tradable, and the market list ---------- */

describe('discovered, registered and tradable Pons markets', () => {
  const info = (n: number, o: Partial<{ graduated: boolean; price: bigint | null }> = {}) => ({
    token: addr('a', n), curve: addr('c', n), deployer: addr('d', n), pairToken: ZERO, launchConfigId: 0n, graduationThreshold: 1n, name: `Token ${n}`, symbol: `TK${n}`, decimals: 18,
    launchedAt: NOW - 7200, blockNumber: 1n, txHash: '0x00' as Hex, graduated: o.graduated ?? false, price: o.price === undefined ? 1_680_000_000n : o.price, progress: 0, eligible: !o.graduated, reasons: [],
  })
  const slice = (id: string, s: { enabled?: boolean; stale?: boolean; graduated?: boolean }) => ({
    risk: s.enabled === undefined ? {} : { [id]: { enabled: s.enabled } },
    stale: { [id]: s.stale ?? false },
    graduated: { [id]: s.graduated ?? false },
  })

  it('a discovered launch is NOT registered and NOT tradable', () => {
    const [t] = mergePonsTokens([info(1)], [])
    applyPonsStatus([t], null)
    expect(t).toMatchObject({ registered: false, ponsState: 'discovered', source: 'pons' })
  })

  it('becomes registered when the Marginpad chain has enabled it, tradable when its oracle price is fresh', () => {
    const [t] = mergePonsTokens([info(1)], [])
    applyPonsStatus([t], slice(t.id, { enabled: true, stale: true }))
    expect(t).toMatchObject({ registered: true, ponsState: 'registered' })
    applyPonsStatus([t], slice(t.id, { enabled: true, stale: false }))
    expect(t.ponsState).toBe('tradable')
  })

  it('goes back to discovered if the chain says it is not registered', () => {
    const [t] = mergePonsTokens([info(1)], [tokenFromRegistry({ token: addr('a', 1), curve: addr('c', 1), name: 'Token 1', symbol: 'TK1', initialPrice: 1e-9 })])
    expect(t.registered).toBe(true) // the registry file says so...
    applyPonsStatus([t], slice(t.id, { enabled: false })) // ...the chain is the authority
    expect(t).toMatchObject({ registered: false, ponsState: 'discovered' })
  })

  it('a graduated market is graduated, whether Pons or the Marginpad oracle says so', () => {
    const [a] = mergePonsTokens([info(1, { graduated: true })], [])
    applyPonsStatus([a], slice(a.id, { enabled: true }))
    expect(a.ponsState).toBe('graduated')
    const [b] = mergePonsTokens([info(2)], [])
    applyPonsStatus([b], slice(b.id, { enabled: true, graduated: true }))
    expect(b).toMatchObject({ graduated: true, ponsState: 'graduated' })
  })

  it('merging keeps one token per address and takes the fresh curve price for display', () => {
    const reg = tokenFromRegistry({ token: addr('a', 1), curve: addr('c', 1), name: 'Old', symbol: 'OLD', initialPrice: 1e-9 })
    const merged = mergePonsTokens([info(1, { price: 2_000_000_000n }), info(2)], [reg])
    expect(merged.map((t) => t.symbol).sort()).toEqual(['TK1', 'TK2'])
    expect(merged.find((t) => t.symbol === 'TK1')).toMatchObject({ registered: true, price: 2e-9 })
  })

  it('discovery never sets an oracle price: the display price is the curve price', () => {
    const t = tokenFromDiscovery(info(1))
    expect(t.price).toBeCloseTo(1.68e-9, 15)
    expect(t.registered).toBe(false)
  })

  it('opening is refused for discovered-only and graduated markets, with clear reasons', () => {
    const [d, g] = mergePonsTokens([info(1), info(2, { graduated: true })], [])
    d.registered = false
    g.registered = true
    g.graduated = true
    setExtraMarkets([d, g])
    const s = { ...createBlankState(), wallet: 10 }
    expect(validateOpen(s, d.id, 1, 1.2)).toMatch(/has not registered a market/)
    expect(validateOpen(s, g.id, 1, 1.2)).toMatch(/graduated/)
    setExtraMarkets([])
  })

  describe('market list', () => {
    const tradable = { ...tokenFromDiscovery(info(1)), registered: true, ponsState: 'tradable' as const }
    const discovered = { ...tokenFromDiscovery(info(2)), ponsState: 'discovered' as const }
    const graduated = { ...tokenFromDiscovery(info(3)), registered: true, graduated: true, ponsState: 'graduated' as const }
    const registeredIdle = { ...tokenFromDiscovery(info(4)), registered: true, ponsState: 'registered' as const }

    it('local/testnet: Pons markets first (tradable before registered before discovered before graduated), demo markets kept', () => {
      const list = orderMarkets(TOKENS, [graduated, discovered, registeredIdle, tradable], true)
      expect(list.slice(0, 4).map((t) => t.ponsState)).toEqual(['tradable', 'registered', 'discovered', 'graduated'])
      expect(list.slice(4).map((t) => t.symbol)).toEqual(TOKENS.map((t) => t.symbol)) // native demo markets are still there
    })

    it('mainnet: never demo markets, and only markets Marginpad has registered', () => {
      const list = orderMarkets(TOKENS, [graduated, discovered, registeredIdle, tradable], false)
      expect(list.map((t) => t.id)).toEqual([tradable.id, registeredIdle.id, graduated.id])
      expect(list.some((t) => t.source !== 'pons')).toBe(false)
    })

    it('mainnet with nothing registered: an empty list (the "no markets yet" state)', () => {
      expect(orderMarkets(TOKENS, [discovered], false)).toEqual([])
      expect(orderMarkets(TOKENS, [], false)).toEqual([])
    })

    it('selects the first tradable Pons market by default, else the preferred demo market, else the first', () => {
      const list = orderMarkets(TOKENS, [discovered, tradable], true)
      expect(defaultMarketId(list, TOKENS[1].id)).toBe(tradable.id)
      const noTradable = orderMarkets(TOKENS, [discovered], true)
      expect(defaultMarketId(noTradable, TOKENS[1].id)).toBe(TOKENS[1].id) // a discovered-only market is never the default
      expect(defaultMarketId([], TOKENS[1].id)).toBeUndefined()
    })
  })

  it('native demo markets are unaffected by Pons markets', () => {
    setDemoMarketsEnabled(true)
    const before = TOKENS.map((t) => ({ ...t }))
    setExtraMarkets([tokenFromDiscovery(info(1))])
    expect(allMarkets().slice(0, TOKENS.length).map((t) => t.symbol)).toEqual(TOKENS.map((t) => t.symbol))
    expect(TOKENS).toEqual(before)
    setExtraMarkets([])
  })
})

