import { describe, expect, it } from 'vitest'
import {
  LP_PROFIT_SHARE,
  borrowRoom,
  closeOutcome,
  createInitialState,
  netResult,
  poolAvailable,
  poolUsed,
  reducer,
  userShare,
  utilization,
  validateOpen,
  validateWithdraw,
  withdrawable,
  type State,
} from './store'

const AT = 1_000
const fresh = () => createInitialState(0, () => 0.5)

const open = (s: State, tokenId: string, side: 'long' | 'short', collateral: number, leverage: number) =>
  reducer(s, { type: 'OPEN', tokenId, side, collateral, leverage, at: AT })
const nudge = (s: State, tokenId: string, pct: number) => reducer(s, { type: 'NUDGE', tokenId, pct, at: AT })

describe('shared mock state: full flow', () => {
  it('deposit -> open -> profitable close -> withdraw keeps wallet and pool in sync', () => {
    let s = fresh()
    const start = { wallet: s.wallet, total: s.totalDeposits, avail: poolAvailable(s), rewards: s.rewardPool }

    // 1. Deposit into the pool
    s = reducer(s, { type: 'DEPOSIT', amount: 5, at: AT })
    expect(s.wallet).toBe(start.wallet - 5)
    expect(s.totalDeposits).toBe(start.total + 5)
    expect(s.userDeposit).toBe(17)
    expect(poolAvailable(s)).toBeCloseTo(start.avail + 5)

    // 2. Open a 2x long on FERRY with 2 ETH -> borrows 2 ETH from the pool
    const availBefore = poolAvailable(s)
    const walletBefore = s.wallet
    const usedBefore = poolUsed(s)
    s = open(s, 'ferry', 'long', 2, 2)
    expect(s.positions).toHaveLength(1)
    expect(s.positions[0]).toMatchObject({ collateral: 2, borrowed: 2, size: 4 })
    expect(s.wallet).toBeCloseTo(walletBefore - 2)

    // 3. Pool liquidity decreases by exactly the borrowed amount
    expect(poolAvailable(s)).toBeCloseTo(availBefore - 2)
    expect(poolUsed(s)).toBeCloseTo(usedBefore + 2)
    expect(s.totalDeposits).toBe(start.total + 5) // deposits themselves don't change

    // 4. Force a profit: price +10% on a 4 ETH position = 0.4 ETH profit
    s = nudge(s, 'ferry', 0.1)
    const rewardsBefore = s.rewardPool
    const userRewardsBefore = s.userRewards
    const share = userShare(s)
    const walletPreClose = s.wallet
    s = reducer(s, { type: 'CLOSE', id: s.positions[0].id, at: AT })

    // 5. 5% of the realized profit reaches the LP reward pool
    const profit = 0.4
    const lp = profit * LP_PROFIT_SHARE
    expect(lp).toBeCloseTo(0.02)
    expect(s.rewardPool).toBeCloseTo(rewardsBefore + lp)
    expect(s.userRewards).toBeCloseTo(userRewardsBefore + lp * share)

    // 6. The trader gets collateral + the other 95% of the profit
    expect(s.wallet).toBeCloseTo(walletPreClose + 2 + profit - lp)
    expect(s.settlements[0]).toMatchObject({ kind: 'closed' })
    expect(s.settlements[0].pnl).toBeCloseTo(0.4)
    expect(s.settlements[0].toLps).toBeCloseTo(0.02)
    expect(s.settlements[0].payout).toBeCloseTo(2.38)

    // 7. Borrowed liquidity is back in the pool
    expect(s.positions).toHaveLength(0)
    expect(poolAvailable(s)).toBeCloseTo(availBefore)
    expect(poolUsed(s)).toBeCloseTo(usedBefore)

    // 8. Withdraw from the pool
    const w = s.wallet
    s = reducer(s, { type: 'WITHDRAW', amount: 4, at: AT })
    expect(s.wallet).toBeCloseTo(w + 4)
    expect(s.userDeposit).toBeCloseTo(13)
    expect(s.totalDeposits).toBeCloseTo(start.total + 1)
  })

  it('a losing close is absorbed by collateral and returns the borrowed capital', () => {
    let s = open(fresh(), 'ferry', 'long', 2, 2)
    const used = poolUsed(s)
    const rewards = s.rewardPool
    s = nudge(s, 'ferry', -0.1) // -10% on 4 ETH = -0.4 ETH, still above the liquidation price
    expect(s.positions).toHaveLength(1)
    const wallet = s.wallet
    s = reducer(s, { type: 'CLOSE', id: s.positions[0].id, at: AT })
    expect(s.wallet).toBeCloseTo(wallet + 1.6) // 2 collateral - 0.4 loss
    expect(s.rewardPool).toBe(rewards) // no profit share on a loss
    expect(poolUsed(s)).toBeCloseTo(used - 2) // borrowed returned in full
    expect(s.totalDeposits).toBe(500) // pool took no loss
  })

  it('liquidates a long that falls through its liquidation price and repays the pool', () => {
    let s = open(fresh(), 'ferry', 'long', 2, 2)
    const p = s.positions[0]
    const usedWith = poolUsed(s)
    const wallet = s.wallet
    s = nudge(s, 'ferry', -0.45) // price = 0.55 x entry, below the 0.57 x liquidation price
    expect(s.prices.ferry).toBeLessThan(p.liq)
    expect(s.positions).toHaveLength(0)
    expect(s.settlements[0].kind).toBe('liquidated')
    expect(s.wallet).toBe(wallet) // trader gets nothing back
    expect(poolUsed(s)).toBeCloseTo(usedWith - 2) // borrowed capital returned
    expect(s.totalDeposits).toBe(500) // no loss to the pool
    // Remaining equity (2 - 1.8 = 0.2 ETH) goes to the LP reward pool
    expect(s.settlements[0].toLps).toBeCloseTo(0.2)
    expect(s.rewardPool).toBeCloseTo(6.8 + 0.2)
  })

  it('liquidates a short when the price rises', () => {
    let s = open(fresh(), 'ferry', 'short', 2, 2)
    s = nudge(s, 'ferry', 0.5)
    expect(s.positions).toHaveLength(0)
    expect(s.settlements[0].kind).toBe('liquidated')
    expect(s.marketUsed.ferry).toBe(4) // back to the seed amount
  })

  it('a price gap past zero equity is absorbed by the pool, pro rata', () => {
    let s = open(fresh(), 'ferry', 'long', 2, 2)
    s = nudge(s, 'ferry', -0.8) // equity = 2 - 3.2 = -1.2
    expect(s.settlements[0].poolLoss).toBeCloseTo(1.2)
    expect(s.settlements[0].payout).toBe(0)
    expect(s.totalDeposits).toBeCloseTo(500 - 1.2)
    expect(s.userDeposit).toBeCloseTo(12 - 1.2 * (12 / 500))
    expect(poolUsed(s)).toBeCloseTo(159.5)
  })
})

describe('limits', () => {
  it('blocks withdrawals that break the utilization limit', () => {
    let s = fresh()
    // Push utilization to 450 / 500 = 90%: nothing can leave.
    s = { ...s, marketUsed: { ...s.marketUsed, ponsx: 450 - (159.5 - 90) } }
    expect(utilization(s)).toBeCloseTo(0.9)
    expect(withdrawable(s)).toBe(0)
    expect(validateWithdraw(s, 1)).toMatch(/can be withdrawn/)
    expect(reducer(s, { type: 'WITHDRAW', amount: 1, at: AT })).toBe(s)
  })

  it('caps withdrawals at the room the pool has under the limit', () => {
    let s = fresh()
    s = { ...s, userDeposit: 100, wallet: 0, marketUsed: { ...s.marketUsed, ponsx: 90 + (400 - 159.5) } }
    // used = 400 -> pool must stay >= 400 / 0.9 = 444.44, so room = 55.5555
    expect(withdrawable(s)).toBeCloseTo(55.5555, 3)
    const ok = reducer(s, { type: 'WITHDRAW', amount: 55, at: AT })
    expect(ok.totalDeposits).toBe(445)
    expect(utilization(ok)).toBeLessThanOrEqual(0.9)
    expect(reducer(s, { type: 'WITHDRAW', amount: 56, at: AT })).toBe(s)
  })

  it('cannot withdraw more than you deposited or deposit more than the wallet holds', () => {
    const s = fresh()
    expect(reducer(s, { type: 'WITHDRAW', amount: 13, at: AT })).toBe(s)
    expect(reducer(s, { type: 'DEPOSIT', amount: 26, at: AT })).toBe(s)
  })

  it('refuses positions that exceed the market cap, wallet or leverage', () => {
    const s = fresh()
    expect(validateOpen(s, 'ferry', 5, 2)).toBeNull() // borrows 5 of 8 left
    expect(validateOpen(s, 'ferry', 9, 2)).toMatch(/Only .* can be borrowed/) // needs 9 of 8 left
    expect(validateOpen(s, 'ferry', 30, 1)).toMatch(/wallet/)
    expect(validateOpen(s, 'ferry', 1, 3)).toMatch(/allows/)
    expect(reducer(s, { type: 'OPEN', tokenId: 'ferry', side: 'long', collateral: 9, leverage: 2, at: AT })).toBe(s)
  })

  it('shares one pool across markets: borrowing on one market shrinks room for all', () => {
    // A small pool: 200 ETH deposited, 159.5 already lent, so 90% of 200 leaves 20.5 ETH of room.
    let s = { ...fresh(), totalDeposits: 200 }
    expect(borrowRoom(s, 'ponsx')).toBeCloseTo(20.5)
    s = open(s, 'ferry', 'long', 5, 2) // borrows 5 ETH on a different market
    expect(borrowRoom(s, 'ponsx')).toBeCloseTo(15.5)
    expect(poolAvailable(s)).toBeCloseTo(200 - 164.5)
  })
})

describe('closeOutcome', () => {
  const p = { collateral: 2, side: 'long' as const, size: 4, entry: 1 }
  it('profit: 5% to LPs, rest to the trader', () => {
    expect(closeOutcome(p, 1.1, 'closed')).toMatchObject({ toLps: expect.closeTo(0.02), payout: expect.closeTo(2.38) })
  })
  it('loss: collateral absorbs first', () => {
    const o = closeOutcome(p, 0.9, 'closed')
    expect(o.payout).toBeCloseTo(1.6)
    expect(o.toLps).toBe(0)
  })
})

describe('closed-trade history (what the dashboard lists)', () => {
  const closeFirst = (s: State) => reducer(s, { type: 'CLOSE', id: s.positions[0].id, at: AT })

  it('a profit is reported after the 5% LP share', () => {
    let s = open(fresh(), 'ferry', 'long', 2, 2)
    s = closeFirst(nudge(s, 'ferry', 0.1)) // +0.4 profit, 0.02 to LPs
    expect(netResult(s.settlements[0])).toBeCloseTo(0.38)
  })

  it('a loss is what the collateral absorbed', () => {
    let s = open(fresh(), 'ferry', 'long', 2, 2)
    s = closeFirst(nudge(s, 'ferry', -0.1))
    expect(netResult(s.settlements[0])).toBeCloseTo(-0.4)
  })

  it('a liquidation loses the whole collateral, and so does a gap that eats through it', () => {
    const liquidated = nudge(open(fresh(), 'ferry', 'long', 2, 2), 'ferry', -0.45)
    expect(liquidated.settlements[0].kind).toBe('liquidated')
    expect(netResult(liquidated.settlements[0])).toBeCloseTo(-2)
    const gapped = nudge(open(fresh(), 'ferry', 'long', 2, 2), 'ferry', -0.8)
    expect(netResult(gapped.settlements[0])).toBeCloseTo(-2)
  })

  it('keeps the newest trade first, with its side, leverage and time', () => {
    let s = fresh()
    s = open(s, 'ferry', 'long', 1, 2)
    s = reducer(s, { type: 'CLOSE', id: s.positions[0].id, at: 5_000 })
    s = open(s, 'tidal', 'short', 1, 3)
    s = reducer(s, { type: 'CLOSE', id: s.positions[0].id, at: 9_000 })
    expect(s.settlements.map((t) => t.tokenId)).toEqual(['tidal', 'ferry'])
    expect(s.settlements[0]).toMatchObject({ side: 'short', leverage: 3, at: 9_000 })
    expect(s.settlements[1]).toMatchObject({ side: 'long', leverage: 2, at: 5_000 })
  })
})
