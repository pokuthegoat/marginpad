import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parseEther, parseEventLogs, type Address, type TransactionReceipt } from 'viem'
import { marginPoolAbi, marginTradingAbi, priceOracleAbi } from '../chain/abis'
import { TARGET_CHAIN, explorerTx, getDeployment } from '../chain/config'
import { publicClient, readSnapshot, type ChainSnapshot } from '../chain/read'
import { describeError, submit, type WriteRequest } from '../chain/tx'
import { useWalletAccess } from '../chain/wallet'
import { fmtEth, fmtPrice } from './format'
import { TOKENS, applyOnchainRisk, sizeFor, tokenById, type Side } from './market'
import { createBlankState, type Notice, type State } from './store'

export type ChainStatus = 'loading' | 'ready' | 'no-deployment' | 'error'

/** Every action is a real contract transaction. It resolves once the transaction is confirmed or has failed. */
interface Actions {
  open: (tokenId: string, side: Side, collateral: number, leverage: number) => Promise<void>
  close: (id: number) => Promise<void>
  liquidate: (id: number) => Promise<void>
  deposit: (amount: number) => Promise<void>
  withdraw: (amount: number) => Promise<void>
  claim: () => Promise<void>
  /** Testnet oracle operator only: push a new price for a token, moved by a fraction (0.1 = +10%). */
  nudge: (tokenId: string, pct: number) => Promise<void>
}

export interface ChainInfo {
  status: ChainStatus
  chainName: string
  address?: Address
  /** A wallet is connected, so transactions can be sent */
  connected: boolean
  /** A transaction is waiting for the wallet or for confirmation */
  busy: boolean
  /** The connected wallet owns the testnet price oracle and may move prices */
  isOracleOwner: boolean
}

interface Store {
  state: State
  actions: Actions
  chain: ChainInfo
}

const StoreContext = createContext<Store | null>(null)

const POLL_MS = 5_000
const bps = (n: number) => BigInt(Math.round(n * 10_000))
/** ETH amount from the UI (a float) to wei, without float noise. */
const toWei = (n: number) => parseEther(n.toFixed(8))

/** Shared state for every page, read from the deployed contracts. Each action sends a real testnet transaction. */
export function StoreProvider({ children }: { children: ReactNode }) {
  const dep = useMemo(() => getDeployment(TARGET_CHAIN.id), [])
  const wallet = useWalletAccess()
  const [snap, setSnap] = useState<ChainSnapshot | null>(null)
  const [status, setStatus] = useState<ChainStatus>(dep ? 'loading' : 'no-deployment')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const noticeId = useRef(1)
  const requestId = useRef(0)
  const snapRef = useRef<ChainSnapshot | null>(null)

  const refresh = useCallback(async () => {
    if (!dep) return
    const n = ++requestId.current
    try {
      const s = await readSnapshot(dep, wallet.address)
      if (n !== requestId.current) return // a newer read is already in flight
      // The contract is the source of truth for max leverage, maintenance margin and the pool cap.
      for (const [id, r] of Object.entries(s.risk)) applyOnchainRisk(id, r)
      snapRef.current = s
      setSnap(s)
      setStatus('ready')
    } catch {
      if (n === requestId.current) setStatus((prev) => (prev === 'ready' ? prev : 'error'))
    }
  }, [dep, wallet.address])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      if (!document.hidden) void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const state = useMemo<State>(() => {
    const base = createBlankState()
    if (!snap) return { ...base, notice }
    const history: Record<string, number[]> = {}
    for (const t of TOKENS) history[t.id] = snap.priceHistory[t.id] ?? base.history[t.id]
    return {
      ...base,
      wallet: snap.wallet,
      totalDeposits: snap.totalDeposits,
      rewardPool: snap.rewardPool,
      userDeposit: snap.userDeposit,
      userRewards: snap.userRewards,
      marketUsed: snap.marketUsed,
      prices: snap.prices,
      history,
      stale: snap.stale,
      positions: snap.positions,
      settlements: snap.settlements,
      activity: snap.activity,
      notice,
    }
  }, [snap, notice])

  const say = useCallback((scope: Notice['scope'], kind: Notice['kind'], text: string) => {
    setNotice({ id: noticeId.current++, scope, kind, text })
  }, [])

  /** Wallet prompt -> pending -> confirmed or failed, shown as a notice on the page. */
  const run = useCallback(
    async (
      scope: Notice['scope'],
      request: WriteRequest,
      onDone: (receipt: TransactionReceipt) => { kind: Notice['kind']; text: string },
    ) => {
      if (busyRef.current) return
      if (!dep) return say(scope, 'bad', 'The contracts are not deployed on this network yet.')
      if (!wallet.getWalletClient) return say(scope, 'bad', 'Connect your wallet first.')
      busyRef.current = true
      setBusy(true)
      try {
        say(scope, 'info', 'Confirm the transaction in your wallet…')
        const wc = await wallet.getWalletClient()
        const hash = await submit(wc, request)
        const link = explorerTx(hash)
        say(scope, 'info', `Transaction sent. Waiting for confirmation…${link ? ` ${link}` : ''}`)
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('The transaction was reverted on chain.')
        await refresh()
        const done = onDone(receipt)
        say(scope, done.kind, done.text)
      } catch (e) {
        say(scope, 'bad', `Transaction failed. ${describeError(e)}`)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [dep, wallet, refresh, say],
  )

  const actions = useMemo<Actions>(() => {
    const trading = dep && { address: dep.marginTrading, abi: marginTradingAbi }
    const pool = dep && { address: dep.marginPool, abi: marginPoolAbi }
    const label = (tokenId: string, side: Side) => `${side === 'long' ? 'Long' : 'Short'} on ${tokenById(tokenId).symbol}`
    const positionLabel = (id: number) => {
      const p = snapRef.current?.positions.find((x) => x.id === id)
      return p ? label(p.tokenId, p.side) : 'Position'
    }
    const unavailable = { address: '0x' as Address, abi: [] as never, functionName: '' }

    return {
      open: (tokenId, side, collateral, leverage) => {
        const { size, borrowed } = sizeFor(collateral, leverage)
        const market = dep?.markets[tokenById(tokenId).symbol]
        return run(
          'trade',
          trading && market
            ? { ...trading, functionName: 'openPosition', args: [market, side === 'long' ? 0 : 1, bps(leverage)], value: toWei(collateral) }
            : unavailable,
          () => ({
            kind: 'good',
            text: `Opened ${leverage.toFixed(1)}x ${side} on ${tokenById(tokenId).symbol}: ${fmtEth(size)} position. ${fmtEth(borrowed)} came from the pool.`,
          }),
        )
      },

      close: (id) => {
        const name = positionLabel(id)
        return run('trade', trading ? { ...trading, functionName: 'closePosition', args: [BigInt(id)] } : unavailable, (receipt) => {
          const [ev] = parseEventLogs({ abi: marginTradingAbi, eventName: 'PositionClosed', logs: receipt.logs })
          if (!ev) return { kind: 'info', text: `Closed ${name}.` }
          const pnl = Number(ev.args.pnl) / 1e18
          const lp = Number(ev.args.lpShare) / 1e18
          const out = Number(ev.args.payout) / 1e18
          return pnl > 0
            ? { kind: 'good', text: `Closed ${name}: profit ${fmtEth(pnl)}. ${fmtEth(lp)} (5%) went to LPs. You received ${fmtEth(out)}.` }
            : { kind: 'info', text: `Closed ${name} at a loss of ${fmtEth(-pnl)}. Your collateral absorbed it. You received ${fmtEth(out)}.` }
        })
      },

      liquidate: (id) => {
        const name = positionLabel(id)
        return run('trade', trading ? { ...trading, functionName: 'liquidate', args: [BigInt(id)] } : unavailable, (receipt) => {
          const [ev] = parseEventLogs({ abi: marginTradingAbi, eventName: 'PositionLiquidated', logs: receipt.logs })
          const price = ev ? Number(ev.args.exitPrice) / 1e18 : 0
          return { kind: 'bad', text: `${name} was liquidated${price ? ` at ${fmtPrice(price)}` : ''}. The pool was repaid first.` }
        })
      },

      deposit: (amount) =>
        run('pool', pool ? { ...pool, functionName: 'deposit', value: toWei(amount) } : unavailable, () => ({
          kind: 'good',
          text: `Deposited ${fmtEth(amount)}. It now counts toward your pool shares.`,
        })),

      withdraw: (amount) =>
        run('pool', pool ? { ...pool, functionName: 'withdraw', args: [toWei(amount)] } : unavailable, () => ({
          kind: 'info',
          text: `Withdrew ${fmtEth(amount)}.`,
        })),

      claim: () =>
        run('pool', pool ? { ...pool, functionName: 'claimRewards' } : unavailable, () => ({
          kind: 'good',
          text: 'Claimed your rewards.',
        })),

      nudge: async (tokenId, pct) => {
        const market = dep?.markets[tokenById(tokenId).symbol]
        if (!dep || !market) return
        const [raw] = await publicClient.readContract({
          address: dep.priceOracle,
          abi: priceOracleAbi,
          functionName: 'getPrice',
          args: [market],
        })
        const next = (raw * bps(1 + pct)) / 10_000n
        await run(
          'trade',
          { address: dep.priceOracle, abi: priceOracleAbi, functionName: 'setPrice', args: [market, next > 0n ? next : 1n] },
          () => ({ kind: 'info', text: `Moved the ${tokenById(tokenId).symbol} testnet oracle price by ${pct > 0 ? '+' : ''}${(pct * 100).toFixed(0)}%.` }),
        )
      },
    }
  }, [dep, run])

  const chain = useMemo<ChainInfo>(
    () => ({
      status,
      chainName: TARGET_CHAIN.name,
      address: wallet.address,
      connected: !!wallet.getWalletClient,
      busy,
      isOracleOwner: !!wallet.address && !!snap && snap.oracleOwner.toLowerCase() === wallet.address.toLowerCase(),
    }),
    [status, wallet, busy, snap],
  )

  const value = useMemo(() => ({ state, actions, chain }), [state, actions, chain])
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used inside <StoreProvider>')
  return ctx
}
