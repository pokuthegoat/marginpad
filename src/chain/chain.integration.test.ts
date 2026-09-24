/**
 * End-to-end check of the frontend's chain layer (ABIs, deployments, snapshot reads, transaction helper) against a
 * real local Anvil node with the contracts deployed. Skipped unless CHAIN_TEST is set:
 *
 *   anvil                                                        # terminal 1
 *   npm run chain:deploy
 *   npm run contracts:sync
 *   npm run test:chain
 */
import fs from 'node:fs'
import path from 'node:path'
import { createWalletClient, http, parseEther, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { marginPoolAbi, marginTradingAbi, priceOracleAbi } from './abis'
import { TARGET_CHAIN, getDeployment } from './config'
import { publicClient, readSnapshot, toPosition } from './read'
import { describeError, submit } from './tx'
import { registryTokens } from '../pons/registered'
import { setExtraMarkets } from '../store/market'

// Anvil's well-known dev accounts (public keys; local chain only).
const DEPLOYER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const TRADER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')

const run = process.env.CHAIN_TEST ? describe : describe.skip

run('frontend chain layer against local Anvil', () => {
  const dep = getDeployment(TARGET_CHAIN.id)!
  const wallet = (account: typeof DEPLOYER) =>
    createWalletClient({ account, chain: TARGET_CHAIN, transport: http() })
  const send = async (account: typeof DEPLOYER, req: Parameters<typeof submit>[1]) => {
    const hash = await submit(wallet(account), req)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    expect(receipt.status).toBe('success')
    return receipt
  }
  const tide = () => dep.markets.TIDE
  const movePrice = async (factor: number) => {
    const [raw] = await publicClient.readContract({ address: dep.priceOracle, abi: priceOracleAbi, functionName: 'getPrice', args: [tide()] })
    await send(DEPLOYER, {
      address: dep.priceOracle,
      abi: priceOracleAbi,
      functionName: 'setPrice',
      args: [tide(), (raw * BigInt(Math.round(factor * 10_000))) / 10_000n],
    })
  }

  it('is deployed and readable', async () => {
    expect(TARGET_CHAIN.id).toBe(31337)
    expect(dep).toBeTruthy()
    const s = await readSnapshot(dep, TRADER.address)
    expect(s.prices.tidal).toBeGreaterThan(0)
    expect(s.risk.tidal.maxLeverage).toBe(7)
    expect(s.risk.plnk.maxLeverage).toBe(1.5)
    expect(s.risk.ponsx.poolCap).toBe(160)
    expect(s.stale.tidal).toBe(false)
    expect(s.wallet).toBeGreaterThan(0)
  })

  it('deposit -> open -> profitable close -> claim -> withdraw', async () => {
    const before = await readSnapshot(dep, TRADER.address)

    await send(TRADER, { address: dep.marginPool, abi: marginPoolAbi, functionName: 'deposit', value: parseEther('10') })
    const afterDeposit = await readSnapshot(dep, TRADER.address)
    expect(afterDeposit.userDeposit).toBeCloseTo(before.userDeposit + 10, 6)
    expect(afterDeposit.totalDeposits).toBeCloseTo(before.totalDeposits + 10, 6)

    await send(TRADER, {
      address: dep.marginTrading,
      abi: marginTradingAbi,
      functionName: 'openPosition',
      args: [tide(), 0, 30_000n], // long, 3x
      value: parseEther('1'),
    })
    const opened = await readSnapshot(dep, TRADER.address)
    const pos = opened.positions[0]
    expect(pos.side).toBe('long')
    expect(pos.leverage).toBe(3)
    expect(pos.collateral).toBe(1)
    expect(pos.borrowed).toBe(2)
    expect(pos.tokenId).toBe('tidal')
    expect(opened.marketUsed.tidal).toBeCloseTo(before.marketUsed.tidal + 2, 6)

    await movePrice(1.1)
    const walletBefore = (await readSnapshot(dep, TRADER.address)).wallet
    await send(TRADER, { address: dep.marginTrading, abi: marginTradingAbi, functionName: 'closePosition', args: [BigInt(pos.id)] })
    const closed = await readSnapshot(dep, TRADER.address)
    // 3 ETH position +10% = 0.3 profit, 5% LP share = 0.015 -> trader gets 1.285 back (minus gas)
    expect(closed.wallet - walletBefore).toBeGreaterThan(1.28)
    expect(closed.wallet - walletBefore).toBeLessThan(1.286)
    expect(closed.positions.find((p) => p.id === pos.id)).toBeUndefined()
    expect(closed.settlements[0].id).toBe(pos.id)
    expect(closed.settlements[0].kind).toBe('closed')
    expect(closed.settlements[0].toLps).toBeCloseTo(0.015, 6)
    expect(closed.userRewards).toBeGreaterThan(0)
    expect(closed.activity.some((a) => a.kind === 'Reward')).toBe(true)

    await send(TRADER, { address: dep.marginPool, abi: marginPoolAbi, functionName: 'claimRewards' })
    expect((await readSnapshot(dep, TRADER.address)).userRewards).toBe(0)

    await send(TRADER, { address: dep.marginPool, abi: marginPoolAbi, functionName: 'withdraw', args: [parseEther('5')] })
    const w = await readSnapshot(dep, TRADER.address)
    expect(w.userDeposit).toBeCloseTo(closed.userDeposit - 5, 6)
  })

  it('a short past its liquidation price can be liquidated', async () => {
    await send(TRADER, {
      address: dep.marginTrading,
      abi: marginTradingAbi,
      functionName: 'openPosition',
      args: [tide(), 1, 30_000n], // short, 3x
      value: parseEther('1'),
    })
    const opened = await readSnapshot(dep, TRADER.address)
    const pos = opened.positions[0]
    expect(pos.side).toBe('short')
    expect(pos.liq).toBeGreaterThan(pos.entry)

    await movePrice(1.6) // well past the short's liquidation price
    const s = await readSnapshot(dep, TRADER.address)
    expect(s.prices.tidal).toBeGreaterThanOrEqual(pos.liq)

    await send(DEPLOYER, { address: dep.marginTrading, abi: marginTradingAbi, functionName: 'liquidate', args: [BigInt(pos.id)] })
    const after = await readSnapshot(dep, TRADER.address)
    expect(after.positions.find((p) => p.id === pos.id)).toBeUndefined()
    expect(after.settlements[0].kind).toBe('liquidated')
    expect(after.settlements[0].payout).toBe(0)
    await movePrice(1 / 1.6) // put the price back for the next run
  })

  it('reports the contract reason when a transaction would fail', async () => {
    const err = await send(TRADER, {
      address: dep.marginTrading,
      abi: marginTradingAbi,
      functionName: 'openPosition',
      args: [tide(), 0, 90_000n], // 9x on a 7x market
      value: parseEther('1'),
    }).catch((e) => e)
    expect(describeError(err)).toMatch(/above the market maximum/)
  })

  it('maps a raw position to the UI shape with the same liquidation price the contract uses', () => {
    const p = toPosition(
      {
        id: 1,
        owner: TRADER.address as Address,
        market: tide(),
        side: 'long',
        status: 'open',
        leverageBps: 20_000,
        openedAt: 100,
        collateral: parseEther('2'),
        borrowed: parseEther('2'),
        entryPrice: parseEther('1'),
      },
      'tidal',
      0.05,
    )
    expect(p.size).toBe(4)
    expect(p.liq).toBeCloseTo(0.55, 9)
    expect(p.openedAt).toBe(100_000)
  })

  it('synthetic Pons markets (registered by scripts/pons-mirror.mjs) trade like any market', async () => {
    const file = path.join(process.cwd(), 'src/chain/pons-markets.local.json')
    if (!fs.existsSync(file)) return // nothing registered: run `npm run pons:register`
    const tokens = registryTokens(TARGET_CHAIN.id)
    setExtraMarkets(tokens)
    expect(tokens.length).toBeGreaterThan(0)
    const pons = tokens[0]
    const market = pons.address as Address
    const move = async (factor: number) => {
      const [raw] = await publicClient.readContract({ address: dep.priceOracle, abi: priceOracleAbi, functionName: 'getPrice', args: [market] })
      await send(DEPLOYER, { address: dep.priceOracle, abi: priceOracleAbi, functionName: 'setPrice', args: [market, (raw * BigInt(Math.round(factor * 10_000))) / 10_000n] })
    }
    const open = (side: number) =>
      send(TRADER, { address: dep.marginTrading, abi: marginTradingAbi, functionName: 'openPosition', args: [market, side, 15_000n], value: parseEther('1') })

    await send(TRADER, { address: dep.marginPool, abi: marginPoolAbi, functionName: 'deposit', value: parseEther('10') })
    const s0 = await readSnapshot(dep, TRADER.address)
    expect(s0.prices[pons.id]).toBeGreaterThan(0)
    expect(s0.stale[pons.id]).toBe(false)
    expect(s0.risk[pons.id].maxLeverage).toBe(1.5)

    // profitable long, closed
    await open(0)
    let snap = await readSnapshot(dep, TRADER.address)
    const long = snap.positions.find((p) => p.tokenId === pons.id)!
    expect(long.borrowed).toBe(0.5)
    expect(long.entry).toBeCloseTo(s0.prices[pons.id], 15)
    await move(1.1)
    await send(TRADER, { address: dep.marginTrading, abi: marginTradingAbi, functionName: 'closePosition', args: [BigInt(long.id)] })
    snap = await readSnapshot(dep, TRADER.address)
    expect(snap.settlements[0].id).toBe(long.id)
    expect(snap.settlements[0].kind).toBe('closed')
    expect(snap.settlements[0].pnl).toBeGreaterThan(0)

    // short liquidated
    await open(1)
    snap = await readSnapshot(dep, TRADER.address)
    const short = snap.positions.find((p) => p.tokenId === pons.id)!
    await move(1.6)
    await send(DEPLOYER, { address: dep.marginTrading, abi: marginTradingAbi, functionName: 'liquidate', args: [BigInt(short.id)] })
    snap = await readSnapshot(dep, TRADER.address)
    expect(snap.settlements[0].id).toBe(short.id)
    expect(snap.settlements[0].kind).toBe('liquidated')
    await move(1 / (1.1 * 1.6)) // restore the mirrored price
  })
})
