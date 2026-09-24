import { createPublicClient, formatEther, http, type Address } from 'viem'
import { marginPoolAbi, marginTradingAbi, priceOracleAbi, riskManagerAbi } from './abis'
import { TARGET_CHAIN, type Deployment } from './config'
import { TOKENS, liquidationPrice, pnlFor, type Side } from '../store/market'
import type { ActivityEntry, Position, Settlement } from '../store/store'

export const publicClient = createPublicClient({ chain: TARGET_CHAIN, transport: http(undefined, { batch: true }) })

/** wei -> ETH as a number (fine for display and validation; transactions use the exact bigint). */
export const eth = (wei: bigint) => Number(formatEther(wei))
/** Contract prices are wei per whole token (1e18-scaled); the UI uses the same number in whole units. */
export const priceOf = (raw: bigint) => Number(formatEther(raw))

/** How many of the newest positions to scan. Plenty for a testnet MVP; there is no indexer or backend. */
const POSITION_SCAN = 200
const HISTORY_POINTS = 48

export interface OnchainPosition {
  id: number
  owner: Address
  market: Address
  side: Side
  status: 'none' | 'open' | 'closed' | 'liquidated'
  leverageBps: number
  openedAt: number
  collateral: bigint
  borrowed: bigint
  entryPrice: bigint
}

const STATUS = ['none', 'open', 'closed', 'liquidated'] as const

export interface MarketRisk {
  enabled: boolean
  maxLeverage: number
  maintenance: number
  poolCap: number
}

export interface ChainSnapshot {
  block: bigint
  /** Tokens whose oracle price is older than RiskManager.maxPriceAge (or was never set) */
  stale: Record<string, boolean>
  wallet: number
  totalDeposits: number
  totalBorrowed: number
  rewardPool: number
  userDeposit: number
  userRewards: number
  marketUsed: Record<string, number>
  prices: Record<string, number>
  priceUpdatedAt: Record<string, number>
  risk: Record<string, MarketRisk>
  positions: Position[]
  settlements: Settlement[]
  activity: ActivityEntry[]
  /** Past prices per token id, oldest first (from the oracle's PriceUpdated events) */
  priceHistory: Record<string, number[]>
  oracleOwner: Address
}

/* ---------- Pure mapping helpers (unit tested) ---------- */

export function toPosition(p: OnchainPosition, tokenId: string, maintenance: number): Position {
  const collateral = eth(p.collateral)
  const borrowed = eth(p.borrowed)
  const leverage = p.leverageBps / 10_000
  const entry = priceOf(p.entryPrice)
  return {
    id: p.id,
    tokenId,
    side: p.side,
    collateral,
    borrowed,
    size: collateral + borrowed,
    leverage,
    entry,
    liq: liquidationPrice(entry, leverage, p.side, maintenance),
    openedAt: p.openedAt * 1000,
  }
}

export function toSettlement(
  p: OnchainPosition,
  tokenId: string,
  kind: 'closed' | 'liquidated',
  e: { exitPrice: bigint; pnl?: bigint; lpShare?: bigint; payout?: bigint; toPool?: bigint; poolLoss?: bigint },
  at: number,
): Settlement {
  const collateral = eth(p.collateral)
  const borrowed = eth(p.borrowed)
  const size = collateral + borrowed
  const entry = priceOf(p.entryPrice)
  const exit = priceOf(e.exitPrice)
  const shape = { side: p.side, size, entry }
  return {
    id: p.id,
    tokenId,
    side: p.side,
    leverage: p.leverageBps / 10_000,
    kind,
    collateral,
    borrowed,
    size,
    entry,
    exit,
    pnl: kind === 'closed' ? eth(e.pnl ?? 0n) : Math.max(-collateral, pnlFor(shape, exit)),
    toLps: eth(kind === 'closed' ? (e.lpShare ?? 0n) : (e.toPool ?? 0n)),
    payout: kind === 'closed' ? eth(e.payout ?? 0n) : 0,
    poolLoss: eth(e.poolLoss ?? 0n),
    at,
  }
}

/* ---------- Reading ---------- */

const read = publicClient.readContract.bind(publicClient) as typeof publicClient.readContract

export async function readSnapshot(dep: Deployment, user?: Address): Promise<ChainSnapshot> {
  const pool = { address: dep.marginPool, abi: marginPoolAbi } as const
  const trading = { address: dep.marginTrading, abi: marginTradingAbi } as const
  const risk = { address: dep.riskManager, abi: riskManagerAbi } as const
  const oracle = { address: dep.priceOracle, abi: priceOracleAbi } as const

  const userReads = user
    ? Promise.all([
        publicClient.getBalance({ address: user }),
        read({ ...pool, functionName: 'assetsOf', args: [user] }),
        read({ ...pool, functionName: 'pendingRewardsOf', args: [user] }),
      ])
    : Promise.resolve([0n, 0n, 0n] as const)

  const marketReads = Promise.all(
    TOKENS.map(async (t) => {
      const market = dep.markets[t.symbol]
      const [[price, updatedAt], borrowed, r] = await Promise.all([
        read({ ...oracle, functionName: 'getPrice', args: [market] }),
        read({ ...trading, functionName: 'marketBorrowed', args: [market] }),
        read({ ...risk, functionName: 'marketRisk', args: [market] }),
      ])
      return { t, price, updatedAt, borrowed, r }
    }),
  )

  const [latest, maxPriceAge, totalDeposits, totalBorrowed, rewardReserve, oracleOwner, nextId, [wallet, userDeposit, userRewards], markets] =
    await Promise.all([
      publicClient.getBlock(),
      read({ ...risk, functionName: 'maxPriceAge' }),
      read({ ...pool, functionName: 'totalDeposits' }),
      read({ ...pool, functionName: 'totalBorrowed' }),
      read({ ...pool, functionName: 'rewardReserve' }),
      read({ ...oracle, functionName: 'owner' }),
      read({ ...trading, functionName: 'nextPositionId' }),
      userReads,
      marketReads,
    ])

  const symbolOf = new Map<string, string>() // market address (lowercase) -> token id
  const prices: Record<string, number> = {}
  const priceUpdatedAt: Record<string, number> = {}
  const marketUsed: Record<string, number> = {}
  const stale: Record<string, boolean> = {}
  const riskById: Record<string, MarketRisk> = {}
  for (const m of markets) {
    symbolOf.set(dep.markets[m.t.symbol].toLowerCase(), m.t.id)
    prices[m.t.id] = priceOf(m.price)
    priceUpdatedAt[m.t.id] = Number(m.updatedAt)
    stale[m.t.id] = m.price === 0n || latest.timestamp > m.updatedAt + maxPriceAge
    marketUsed[m.t.id] = eth(m.borrowed)
    riskById[m.t.id] = {
      enabled: m.r.enabled,
      maxLeverage: m.r.maxLeverageBps / 10_000,
      maintenance: m.r.maintenanceBps / 10_000,
      poolCap: eth(m.r.maxBorrow),
    }
  }

  // Positions: scan the newest ones and keep this wallet's.
  const last = Number(nextId) - 1
  const first = Math.max(1, last - POSITION_SCAN + 1)
  const ids = Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i)
  const all = await Promise.all(
    ids.map(async (id): Promise<OnchainPosition> => {
      const p = await read({ ...trading, functionName: 'getPosition', args: [BigInt(id)] })
      return {
        id,
        owner: p.owner,
        market: p.market,
        side: p.side === 0 ? 'long' : 'short',
        status: STATUS[p.status],
        leverageBps: p.leverageBps,
        openedAt: p.openedAt,
        collateral: p.collateral,
        borrowed: p.borrowed,
        entryPrice: p.entryPrice,
      }
    }),
  )
  const mine = user ? all.filter((p) => p.owner.toLowerCase() === user.toLowerCase()) : []
  const byId = new Map(all.map((p) => [p.id, p]))

  const positions = mine
    .filter((p) => p.status === 'open' && symbolOf.has(p.market.toLowerCase()))
    .map((p) => {
      const tokenId = symbolOf.get(p.market.toLowerCase())!
      return toPosition(p, tokenId, riskById[tokenId].maintenance)
    })
    .reverse()

  // History, settlements and the activity feed come from event logs. If the RPC refuses the log query the page
  // still works; these sections are just empty.
  let settlements: Settlement[] = []
  let activity: ActivityEntry[] = []
  const priceHistory: Record<string, number[]> = {}
  try {
    const fromBlock = BigInt(dep.deployBlock)
    const [poolLogs, tradingLogs, oracleLogs] = await Promise.all([
      publicClient.getContractEvents({ ...pool, fromBlock }),
      publicClient.getContractEvents({ ...trading, fromBlock }),
      publicClient.getContractEvents({ address: dep.priceOracle, abi: priceOracleAbi, eventName: 'PriceUpdated', fromBlock }),
    ])

    for (const l of oracleLogs) {
      const id = symbolOf.get(l.args.market!.toLowerCase())
      if (id) (priceHistory[id] ??= []).push(priceOf(l.args.price!))
    }

    type Entry = { blockNumber: bigint; logIndex: number; make: (at: number) => ActivityEntry | null }
    const entries: Entry[] = []
    const label = (id: bigint) => {
      const p = byId.get(Number(id))
      const t = p && symbolOf.get(p.market.toLowerCase())
      return p && t ? `${p.side === 'long' ? 'Long' : 'Short'} on ${TOKENS.find((x) => x.id === t)!.symbol}` : 'Position'
    }
    const you = (a: Address | undefined) => !!user && !!a && a.toLowerCase() === user.toLowerCase()

    for (const l of [...poolLogs, ...tradingLogs]) {
      const uid = Number(l.blockNumber) * 1000 + (l.logIndex ?? 0)
      const push = (kind: ActivityEntry['kind'], text: string, amount: number) =>
        entries.push({
          blockNumber: l.blockNumber,
          logIndex: l.logIndex ?? 0,
          make: (at) => ({ id: uid, kind, text, amount, at }),
        })
      const a = l.args as Record<string, unknown>
      switch (l.eventName as string) {
        case 'Deposited':
          push('Deposit', you(a.lp as Address) ? 'You deposited' : 'An LP deposited', eth(a.amount as bigint))
          break
        case 'Withdrawn':
          push('Withdraw', you(a.lp as Address) ? 'You withdrew' : 'An LP withdrew', eth(a.amount as bigint))
          break
        case 'RewardsClaimed':
          push('Claim', you(a.lp as Address) ? 'You claimed rewards' : 'An LP claimed rewards', eth(a.amount as bigint))
          break
        case 'PositionOpened':
          push('Borrow', `${label(a.id as bigint)} opened`, eth(a.borrowed as bigint))
          break
        case 'PositionClosed': {
          const p = byId.get(Number(a.id))
          if (p && you(a.owner as Address)) {
            const tokenId = symbolOf.get(p.market.toLowerCase())
            if (tokenId)
              settlements.push(
                toSettlement(
                  p,
                  tokenId,
                  'closed',
                  { exitPrice: a.exitPrice as bigint, pnl: a.pnl as bigint, lpShare: a.lpShare as bigint, payout: a.payout as bigint },
                  0,
                ),
              )
          }
          push('Repay', `${label(a.id as bigint)} closed`, p ? eth(p.borrowed) : 0)
          if ((a.lpShare as bigint) > 0n)
            push('Reward', `5% profit share from ${label(a.id as bigint)}`, eth(a.lpShare as bigint))
          break
        }
        case 'PositionLiquidated': {
          const p = byId.get(Number(a.id))
          if (p && you(a.owner as Address)) {
            const tokenId = symbolOf.get(p.market.toLowerCase())
            if (tokenId)
              settlements.push(
                toSettlement(
                  p,
                  tokenId,
                  'liquidated',
                  { exitPrice: a.exitPrice as bigint, toPool: a.toPool as bigint, poolLoss: a.poolLoss as bigint },
                  0,
                ),
              )
          }
          const loss = a.poolLoss as bigint
          push('Liquidation', `${label(a.id as bigint)} liquidated`, loss > 0n ? -eth(loss) : eth(a.toPool as bigint))
          break
        }
      }
    }

    // Newest first, and only fetch timestamps for what is actually shown.
    entries.sort((x, y) => Number(y.blockNumber - x.blockNumber) || y.logIndex - x.logIndex)
    const shown = entries.slice(0, 40)
    const blocks = [...new Set(shown.map((e) => e.blockNumber))]
    const times = new Map<bigint, number>()
    await Promise.all(
      blocks.map(async (b) => {
        const blk = await publicClient.getBlock({ blockNumber: b })
        times.set(b, Number(blk.timestamp) * 1000)
      }),
    )
    activity = shown.map((e) => e.make(times.get(e.blockNumber) ?? 0)).filter((x): x is ActivityEntry => x !== null)

    // Settlement times: the block of the matching close/liquidate event, newest first.
    const settleTimes = new Map<number, number>()
    for (const l of tradingLogs) {
      const name = l.eventName as string
      if (name === 'PositionClosed' || name === 'PositionLiquidated') {
        const id = Number((l.args as { id: bigint }).id)
        const t = times.get(l.blockNumber) ?? (await publicClient.getBlock({ blockNumber: l.blockNumber })).timestamp
        settleTimes.set(id, typeof t === 'bigint' ? Number(t) * 1000 : t)
      }
    }
    settlements = settlements.map((s) => ({ ...s, at: settleTimes.get(s.id) ?? 0 })).sort((a, b) => b.at - a.at || b.id - a.id)
  } catch {
    settlements = []
    activity = []
  }

  // The chart: real oracle pushes, ending at the current price. Pad short histories with the current price.
  for (const t of TOKENS) {
    const pts = priceHistory[t.id] ?? []
    if (pts[pts.length - 1] !== prices[t.id]) pts.push(prices[t.id])
    const trimmed = pts.slice(-HISTORY_POINTS)
    while (trimmed.length < 2) trimmed.unshift(prices[t.id])
    priceHistory[t.id] = trimmed
  }

  return {
    block: latest.number,
    stale,
    wallet: eth(wallet),
    totalDeposits: eth(totalDeposits),
    totalBorrowed: eth(totalBorrowed),
    rewardPool: eth(rewardReserve),
    userDeposit: eth(userDeposit),
    userRewards: eth(userRewards),
    marketUsed,
    prices,
    priceUpdatedAt,
    risk: riskById,
    positions,
    settlements,
    activity,
    priceHistory,
    oracleOwner,
  }
}
