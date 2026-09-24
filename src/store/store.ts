import { floor4, fmtEth, fmtPct, fmtPrice } from './format'
import {
  TOKENS,
  isLiquidated,
  liquidationPrice,
  pnlFor,
  sizeFor,
  tokenById,
  type Side,
} from './market'

/** Withdrawals and new borrowing may not push pool utilization above this. */
export const MAX_UTILIZATION = 0.9
/** Share of realized profit routed to liquidity providers. */
export const LP_PROFIT_SHARE = 0.05
export const MIN_COLLATERAL = 0.01
export const MIN_DEPOSIT = 0.01
export const HISTORY_POINTS = 48
const EPS = 1e-9

export interface Position {
  id: number
  tokenId: string
  side: Side
  collateral: number
  borrowed: number
  size: number
  leverage: number
  entry: number
  liq: number
  openedAt: number
}

export interface Settlement {
  id: number
  tokenId: string
  side: Side
  leverage: number
  kind: 'closed' | 'liquidated'
  collateral: number
  borrowed: number
  size: number
  entry: number
  exit: number
  /** Profit (positive) or loss (negative), in ETH */
  pnl: number
  /** Paid into the LP reward pool: the 5% profit share, or liquidation proceeds */
  toLps: number
  /** ETH paid back to the trader's wallet */
  payout: number
  /** Loss the pool had to absorb if a price gap ate through the collateral */
  poolLoss: number
  at: number
}

export type ActivityKind = 'Deposit' | 'Withdraw' | 'Claim' | 'Reward' | 'Borrow' | 'Repay' | 'Liquidation'

export interface ActivityEntry {
  id: number
  kind: ActivityKind
  text: string
  amount: number
  at: number
}

export interface Notice {
  id: number
  scope: 'trade' | 'pool'
  kind: 'good' | 'bad' | 'info'
  text: string
}

export interface State {
  /** The user's wallet, in ETH */
  wallet: number
  /** All ETH supplied to the pool by every LP */
  totalDeposits: number
  /** Rewards held for LPs and not yet claimed */
  rewardPool: number
  userDeposit: number
  userRewards: number
  /** ETH currently borrowed from the pool, per market */
  marketUsed: Record<string, number>
  prices: Record<string, number>
  history: Record<string, number[]>
  /** Tokens whose oracle price is too old for the contracts to accept */
  stale: Record<string, boolean>
  positions: Position[]
  settlements: Settlement[]
  activity: ActivityEntry[]
  notice: Notice | null
  nextId: number
}

export type Action =
  | { type: 'TICK'; noise: Record<string, number>; at: number }
  | { type: 'NUDGE'; tokenId: string; pct: number; at: number }
  | { type: 'OPEN'; tokenId: string; side: Side; collateral: number; leverage: number; at: number }
  | { type: 'CLOSE'; id: number; at: number }
  | { type: 'DEPOSIT'; amount: number; at: number }
  | { type: 'WITHDRAW'; amount: number; at: number }
  | { type: 'CLAIM'; at: number }

const MIN = 60_000

export function createInitialState(now = Date.now(), rng: () => number = Math.random): State {
  const prices: Record<string, number> = {}
  const history: Record<string, number[]> = {}
  const marketUsed: Record<string, number> = {}
  for (const t of TOKENS) {
    prices[t.id] = t.price
    marketUsed[t.id] = t.seedUsed
    // Walk backwards from the current price to give the chart some shape.
    const pts = [t.price]
    for (let i = 1; i < HISTORY_POINTS; i++) {
      pts.unshift(pts[0] / (1 + (rng() - 0.5) * t.vol * 1.2))
    }
    history[t.id] = pts
  }
  return {
    wallet: 25,
    totalDeposits: 500,
    rewardPool: 6.8,
    userDeposit: 12,
    userRewards: 0.16,
    marketUsed,
    prices,
    history,
    stale: {},
    positions: [],
    settlements: [],
    activity: [
      { id: 5, kind: 'Reward', text: 'Profitable long on LCAT closed', amount: 0.42, at: now - 4 * MIN },
      { id: 4, kind: 'Borrow', text: 'Short on TIDE opened', amount: 6.5, at: now - 17 * MIN },
      { id: 3, kind: 'Repay', text: 'Long on FERRY closed', amount: 3.1, at: now - 42 * MIN },
      { id: 2, kind: 'Deposit', text: 'Another LP deposited', amount: 40, at: now - 95 * MIN },
      { id: 1, kind: 'Reward', text: 'Profitable long on PONSW closed', amount: 1.15, at: now - 180 * MIN },
    ],
    notice: null,
    nextId: 6,
  }
}

/** Empty state for before the first chain read (and when no wallet is connected): no balances, flat charts. */
export function createBlankState(): State {
  const prices: Record<string, number> = {}
  const history: Record<string, number[]> = {}
  const marketUsed: Record<string, number> = {}
  for (const t of TOKENS) {
    prices[t.id] = t.price
    history[t.id] = [t.price, t.price]
    marketUsed[t.id] = 0
  }
  return {
    wallet: 0,
    totalDeposits: 0,
    rewardPool: 0,
    userDeposit: 0,
    userRewards: 0,
    marketUsed,
    prices,
    history,
    stale: {},
    positions: [],
    settlements: [],
    activity: [],
    notice: null,
    nextId: 1,
  }
}

/* ---------- Derived values ---------- */

export const poolUsed = (s: State) => Object.values(s.marketUsed).reduce((a, b) => a + b, 0)
export const poolAvailable = (s: State) => s.totalDeposits - poolUsed(s)
export const utilization = (s: State) => (s.totalDeposits > 0 ? poolUsed(s) / s.totalDeposits : 0)
export const userShare = (s: State) => (s.totalDeposits > 0 ? s.userDeposit / s.totalDeposits : 0)

/**
 * What the trader actually made or lost on a closed position: what came back to their wallet minus the collateral
 * they put in. A profit is after the 5% LP share; a liquidation is the whole collateral.
 */
export const netResult = (s: Settlement) => s.payout - s.collateral

/** What the user can pull out now without breaking the utilization limit. */
export function withdrawable(s: State) {
  const roomInPool = s.totalDeposits - poolUsed(s) / MAX_UTILIZATION
  return Math.max(0, Math.min(floor4(s.userDeposit), floor4(roomInPool)))
}

/** Most a single new position may borrow for this market right now. */
export function borrowRoom(s: State, tokenId: string) {
  const marketRoom = tokenById(tokenId).poolCap - s.marketUsed[tokenId]
  const utilizationRoom = MAX_UTILIZATION * s.totalDeposits - poolUsed(s)
  return Math.max(0, Math.min(marketRoom, utilizationRoom))
}

export interface CloseOutcome {
  pnl: number
  /** Goes to the LP reward pool */
  toLps: number
  /** Returned to the trader's wallet */
  payout: number
  /** Loss left over after the collateral is used up, borne by the pool */
  poolLoss: number
}

/**
 * The settlement maths, used by both the UI preview and the reducer.
 * - Profit: 5% goes to LPs, the trader keeps the rest plus the collateral.
 * - Loss: the collateral absorbs it first and the remainder is returned.
 * - Liquidation: the trader gets nothing back. Whatever equity is left goes to LPs.
 */
export function closeOutcome(
  p: { collateral: number; side: Side; size: number; entry: number },
  price: number,
  kind: 'closed' | 'liquidated',
): CloseOutcome {
  const pnl = pnlFor(p, price)
  const equity = p.collateral + pnl
  const poolLoss = Math.max(0, -equity)
  if (kind === 'liquidated') {
    return { pnl, toLps: Math.max(0, equity), payout: 0, poolLoss }
  }
  if (pnl > 0) {
    const toLps = pnl * LP_PROFIT_SHARE
    return { pnl, toLps, payout: p.collateral + pnl - toLps, poolLoss: 0 }
  }
  return { pnl, toLps: 0, payout: Math.max(0, equity), poolLoss }
}

/* ---------- Validation (shared by the UI and the reducer) ---------- */

export function validateOpen(s: State, tokenId: string, collateral: number, leverage: number): string | null {
  const token = tokenById(tokenId)
  if (!(collateral > 0)) return null
  if (s.stale[tokenId]) return `The ${token.symbol} oracle price is out of date. Ask the testnet oracle operator to push a new price.`
  if (collateral < MIN_COLLATERAL) return `The minimum is ${fmtEth(MIN_COLLATERAL)}.`
  if (collateral > s.wallet + EPS) return `You only have ${fmtEth(s.wallet)} in your wallet.`
  if (leverage < 1 - EPS || leverage > token.maxLeverage + EPS)
    return `${token.symbol} allows 1x to ${token.maxLeverage}x.`
  const { borrowed } = sizeFor(collateral, leverage)
  const room = borrowRoom(s, tokenId)
  if (borrowed > room + EPS)
    return `Only ${fmtEth(room)} can be borrowed for ${token.symbol} right now. Lower your amount or leverage.`
  return null
}

export function validateDeposit(s: State, amount: number): string | null {
  if (!(amount > 0)) return null
  if (amount < MIN_DEPOSIT) return `The minimum is ${fmtEth(MIN_DEPOSIT)}.`
  if (amount > s.wallet + EPS) return `Your wallet has ${fmtEth(s.wallet)}.`
  return null
}

export function validateWithdraw(s: State, amount: number): string | null {
  if (!(amount > 0)) return null
  if (amount < MIN_DEPOSIT) return `The minimum is ${fmtEth(MIN_DEPOSIT)}.`
  if (amount > s.userDeposit + EPS) return `You only have ${fmtEth(s.userDeposit)} deposited.`
  const max = withdrawable(s)
  if (amount > max + EPS)
    return `Only ${fmtEth(max)} can be withdrawn right now. The pool has to stay under ${fmtPct(MAX_UTILIZATION)} utilization.`
  return null
}

/* ---------- Reducer helpers ---------- */

function log(s: State, kind: ActivityKind, text: string, amount: number, at: number): State {
  return {
    ...s,
    activity: [{ id: s.nextId, kind, text, amount, at }, ...s.activity].slice(0, 100),
    nextId: s.nextId + 1,
  }
}

function notify(s: State, scope: Notice['scope'], kind: Notice['kind'], text: string): State {
  return { ...s, notice: { id: s.nextId, scope, kind, text }, nextId: s.nextId + 1 }
}

/** Add rewards to the pool and credit the user their pro rata part. */
function addRewards(s: State, amount: number): State {
  if (amount <= 0) return s
  return {
    ...s,
    rewardPool: s.rewardPool + amount,
    userRewards: s.userRewards + amount * userShare(s),
  }
}

/** Close a position at the given price and update the wallet, the pool and the logs. */
function settle(s: State, p: Position, price: number, kind: 'closed' | 'liquidated', at: number): State {
  const token = tokenById(p.tokenId)
  const out = closeOutcome(p, price, kind)

  let next: State = {
    ...s,
    wallet: s.wallet + out.payout,
    positions: s.positions.filter((x) => x.id !== p.id),
    // The borrowed capital always goes back to the pool.
    marketUsed: { ...s.marketUsed, [p.tokenId]: Math.max(0, s.marketUsed[p.tokenId] - p.borrowed) },
    settlements: [
      {
        id: s.nextId,
        tokenId: p.tokenId,
        side: p.side,
        leverage: p.leverage,
        kind,
        collateral: p.collateral,
        borrowed: p.borrowed,
        size: p.size,
        entry: p.entry,
        exit: price,
        pnl: out.pnl,
        toLps: out.toLps,
        payout: out.payout,
        poolLoss: out.poolLoss,
        at,
      },
      ...s.settlements,
    ].slice(0, 20),
    nextId: s.nextId + 1,
  }

  if (out.poolLoss > 0) {
    // A price gap went through the liquidation level. LPs absorb what is left.
    const share = userShare(next)
    next = {
      ...next,
      totalDeposits: next.totalDeposits - out.poolLoss,
      userDeposit: next.userDeposit - out.poolLoss * share,
    }
    next = log(next, 'Liquidation', `${token.symbol} gap loss absorbed by the pool`, -out.poolLoss, at)
  }
  next = addRewards(next, out.toLps)

  const label = `${p.side === 'long' ? 'Long' : 'Short'} on ${token.symbol}`
  next = log(next, 'Repay', `${label} ${kind === 'liquidated' ? 'liquidated' : 'closed'}`, p.borrowed, at)
  if (out.toLps > 0) {
    next = log(
      next,
      kind === 'liquidated' ? 'Liquidation' : 'Reward',
      kind === 'liquidated' ? `${label} liquidation proceeds` : `5% profit share from ${label}`,
      out.toLps,
      at,
    )
  } else if (kind === 'liquidated') {
    next = log(next, 'Liquidation', `${label} liquidated`, 0, at)
  }

  let text: string
  if (kind === 'liquidated') {
    text = `${label} was liquidated at ${fmtPrice(price)}. The ${fmtEth(p.borrowed)} borrowed went back to the pool. You received nothing.`
  } else if (out.pnl > 0) {
    text = `Closed ${label}: profit ${fmtEth(out.pnl)}. ${fmtEth(out.toLps)} (5%) went to LPs. You received ${fmtEth(out.payout)}.`
  } else {
    text = `Closed ${label} at a loss of ${fmtEth(-out.pnl)}. Your collateral absorbed it. You received ${fmtEth(out.payout)}.`
  }
  const kindOfNotice: Notice['kind'] = kind === 'liquidated' ? 'bad' : out.pnl > 0 ? 'good' : 'info'
  return notify(next, 'trade', kindOfNotice, text)
}

/** Liquidate every position whose price has crossed its liquidation level. */
function liquidateCrossed(s: State, at: number): State {
  let next = s
  for (const p of s.positions) {
    const price = next.prices[p.tokenId]
    if (isLiquidated(p, price)) next = settle(next, p, price, 'liquidated', at)
  }
  return next
}

/* ---------- Reducer ---------- */

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'TICK': {
      const prices = { ...s.prices }
      const history = { ...s.history }
      for (const t of TOKENS) {
        const next = s.prices[t.id] * (1 + (a.noise[t.id] ?? 0))
        prices[t.id] = next
        history[t.id] = [...s.history[t.id].slice(1), next]
      }
      return liquidateCrossed({ ...s, prices, history }, a.at)
    }

    case 'NUDGE': {
      // Demo control: jump one token's price so profits and liquidations are easy to see.
      const next = s.prices[a.tokenId] * (1 + a.pct)
      return liquidateCrossed(
        {
          ...s,
          prices: { ...s.prices, [a.tokenId]: next },
          history: { ...s.history, [a.tokenId]: [...s.history[a.tokenId].slice(1), next] },
        },
        a.at,
      )
    }

    case 'OPEN': {
      if (!(a.collateral > 0) || validateOpen(s, a.tokenId, a.collateral, a.leverage)) return s
      const token = tokenById(a.tokenId)
      const entry = s.prices[a.tokenId]
      const { size, borrowed } = sizeFor(a.collateral, a.leverage)
      const position: Position = {
        id: s.nextId,
        tokenId: a.tokenId,
        side: a.side,
        collateral: a.collateral,
        borrowed,
        size,
        leverage: a.leverage,
        entry,
        liq: liquidationPrice(entry, a.leverage, a.side, token.maintenance),
        openedAt: a.at,
      }
      let next: State = {
        ...s,
        wallet: s.wallet - a.collateral,
        marketUsed: { ...s.marketUsed, [a.tokenId]: s.marketUsed[a.tokenId] + borrowed },
        positions: [position, ...s.positions],
        nextId: s.nextId + 1,
      }
      const label = `${a.side === 'long' ? 'Long' : 'Short'} on ${token.symbol}`
      next = log(next, 'Borrow', `${label} opened`, borrowed, a.at)
      return notify(
        next,
        'trade',
        'good',
        `Opened ${a.leverage.toFixed(1)}x ${a.side} on ${token.symbol}: ${fmtEth(size)} position. ${fmtEth(borrowed)} came from the pool.`,
      )
    }

    case 'CLOSE': {
      const p = s.positions.find((x) => x.id === a.id)
      if (!p) return s
      return settle(s, p, s.prices[p.tokenId], 'closed', a.at)
    }

    case 'DEPOSIT': {
      if (!(a.amount > 0) || validateDeposit(s, a.amount)) return s
      const after = (s.userDeposit + a.amount) / (s.totalDeposits + a.amount)
      let next: State = {
        ...s,
        wallet: s.wallet - a.amount,
        totalDeposits: s.totalDeposits + a.amount,
        userDeposit: s.userDeposit + a.amount,
      }
      next = log(next, 'Deposit', 'You deposited', a.amount, a.at)
      return notify(next, 'pool', 'good', `Deposited ${fmtEth(a.amount)}. You now own ${fmtPct(after)} of the pool.`)
    }

    case 'WITHDRAW': {
      if (!(a.amount > 0) || validateWithdraw(s, a.amount)) return s
      let next: State = {
        ...s,
        wallet: s.wallet + a.amount,
        totalDeposits: s.totalDeposits - a.amount,
        userDeposit: Math.max(0, s.userDeposit - a.amount),
      }
      next = log(next, 'Withdraw', 'You withdrew', a.amount, a.at)
      return notify(next, 'pool', 'info', `Withdrew ${fmtEth(a.amount)}. Pool utilization is now ${fmtPct(utilization(next))}.`)
    }

    case 'CLAIM': {
      if (s.userRewards <= 0) return s
      const amount = s.userRewards
      let next: State = {
        ...s,
        wallet: s.wallet + amount,
        rewardPool: Math.max(0, s.rewardPool - amount),
        userRewards: 0,
      }
      next = log(next, 'Claim', 'You claimed rewards', amount, a.at)
      return notify(next, 'pool', 'good', `Claimed ${fmtEth(amount)} of rewards.`)
    }
  }
}
