import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Row, Segmented } from '../components/controls'
import { useStore } from '../store/StoreContext'
import ChainNotice from '../chain/ChainNotice'
import { floor4, fmtEth, fmtPct, fmtTime } from '../store/format'
import { TOKENS } from '../store/market'
import {
  MAX_UTILIZATION,
  poolAvailable,
  poolUsed,
  userShare,
  utilization,
  validateDeposit,
  validateWithdraw,
  withdrawable,
} from '../store/store'

function parseAmount(text: string) {
  const n = Number.parseFloat(text)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function cleanInput(v: string) {
  const s = v.replace(/[^\d.]/g, '')
  return (s.match(/\./g) ?? []).length <= 1 ? s : null
}

export default function Pool() {
  const { state, actions, chain } = useStore()
  const ready = chain.status === 'ready' && chain.connected && !chain.busy
  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit')
  const [amountText, setAmountText] = useState('')

  const { totalDeposits: total, userDeposit: deposit, userRewards: rewards, wallet } = state
  const used = poolUsed(state)
  const available = poolAvailable(state)
  const util = utilization(state)
  const share = userShare(state)
  const canWithdraw = withdrawable(state)

  const amount = parseAmount(amountText)
  const isDeposit = tab === 'deposit'
  const error = isDeposit ? validateDeposit(state, amount) : validateWithdraw(state, amount)
  const canSubmit = amount > 0 && !error && ready

  const newTotal = isDeposit ? total + amount : total - amount
  const newDeposit = isDeposit ? deposit + amount : deposit - amount
  const newShare = newTotal > 0 ? newDeposit / newTotal : 0
  const newUtil = newTotal > 0 ? used / newTotal : 0

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    if (isDeposit) void actions.deposit(amount)
    else void actions.withdraw(amount)
    setAmountText('')
  }

  const switchTab = (t: 'deposit' | 'withdraw') => {
    setTab(t)
    setAmountText('')
  }

  const setMax = () => {
    const max = isDeposit ? floor4(wallet) : canWithdraw
    setAmountText(max > 0 ? String(max) : '')
  }

  const notice = state.notice?.scope === 'pool' ? state.notice : null

  return (
    <main className="wrap-wide stack">
      <div className="title">
        <p className="eyebrow">Margin Pool</p>
        <h1 className="t-h1">One pool. Every market.</h1>
        <p className="lead">Shared Robinhood ETH that funds leveraged positions across every Marginpad market.</p>
        <ChainNotice />
      </div>

      <dl className="pstats">
        <div className="card">
          <dt>Total pool size</dt>
          <dd className="num">{fmtEth(total)}</dd>
        </div>
        <div className="card">
          <dt>Available liquidity</dt>
          <dd className="num">{fmtEth(available)}</dd>
        </div>
        <div className="card">
          <dt>Used liquidity</dt>
          <dd className="num">{fmtEth(used)}</dd>
        </div>
        <div className="card">
          <dt>Utilization</dt>
          <dd className="num">{fmtPct(util)}</dd>
        </div>
      </dl>

      <div
        className="meter"
        role="img"
        aria-label={`Pool utilization ${fmtPct(util)}. Withdrawals are limited above ${fmtPct(MAX_UTILIZATION)}.`}
      >
        <div className="meter-fill" style={{ width: `${Math.min(100, util * 100)}%` }} />
        <div className="meter-cap" style={{ left: `${MAX_UTILIZATION * 100}%` }} />
      </div>
      <p className="caption">
        The marker shows the {fmtPct(MAX_UTILIZATION)} utilization limit. Withdrawals and new borrowing can’t push the
        pool past it.
      </p>

      <div className="pcols">
        <section className="card" aria-label="Your position in the pool">
          <h2>Your pool position</h2>
          <dl className="mine">
            <div>
              <dt>Deposited</dt>
              <dd className="num">{fmtEth(deposit)}</dd>
            </div>
            <div>
              <dt>Share of pool</dt>
              <dd className="num">{fmtPct(share)}</dd>
            </div>
            <div>
              <dt>Earned rewards</dt>
              <dd className="num">{fmtEth(rewards)}</dd>
            </div>
            <div>
              <dt>Withdrawable now</dt>
              <dd className="num">{fmtEth(canWithdraw)}</dd>
            </div>
          </dl>
          <button type="button" className="btn btn-glass btn-block" onClick={() => void actions.claim()} disabled={rewards <= 0 || !ready}>
            Claim rewards
          </button>
          <p className="help" style={{ textAlign: 'center' }}>
            LP reward pool: {fmtEth(state.rewardPool)} held for all liquidity providers.
          </p>

          <div className="markets">
            <h3>Borrowed by market</h3>
            <dl className="group">
              {TOKENS.map((t) => (
                <Row key={t.id} label={t.symbol} value={`${fmtEth(state.marketUsed[t.id])} of ${fmtEth(t.poolCap)}`} />
              ))}
            </dl>
          </div>
        </section>

        <section className="card" aria-label="Deposit or withdraw">
          <Segmented
            label="Action"
            value={tab}
            onChange={switchTab}
            options={[
              { value: 'deposit', label: 'Deposit' },
              { value: 'withdraw', label: 'Withdraw' },
            ]}
          />

          <form onSubmit={submit} className="pform" style={{ marginTop: 20 }}>
            <div>
              <label htmlFor="eth" className="field-label">
                {isDeposit ? 'Amount to deposit' : 'Amount to withdraw'}
              </label>
              <div className="amount" data-invalid={error ? '' : undefined}>
                <input
                  id="eth"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={amountText}
                  onChange={(e) => {
                    const v = cleanInput(e.target.value)
                    if (v !== null) setAmountText(v)
                  }}
                  aria-invalid={error ? true : undefined}
                  aria-describedby="eth-help"
                />
                <span className="unit">ETH</span>
                <button type="button" className="max-btn" onClick={setMax}>
                  Max
                </button>
              </div>
              <p id="eth-help" className={error ? 'help err' : 'help'} role={error ? 'alert' : undefined}>
                {error ??
                  (isDeposit
                    ? `Wallet: ${fmtEth(wallet)}`
                    : `You can withdraw up to ${fmtEth(canWithdraw)} right now.`)}
              </p>
              {!isDeposit && canWithdraw < deposit && (
                <p className="help">
                  {fmtEth(deposit - canWithdraw)} of your deposit is helping fund open positions and is locked until
                  utilization falls.
                </p>
              )}
            </div>

            <dl className="group">
              <Row label={isDeposit ? 'You deposit' : 'You withdraw'} value={fmtEth(amount)} />
              <Row label="Your deposit after" value={fmtEth(Math.max(0, newDeposit))} />
              <Row label="Your share of pool after" value={fmtPct(amount > 0 ? newShare : share)} strong />
              <Row label="Utilization after" value={fmtPct(amount > 0 ? newUtil : util)} />
            </dl>

            <button type="submit" className="btn btn-block btn-primary" disabled={!canSubmit}>
              {chain.busy ? 'Waiting for transaction…' : isDeposit ? 'Confirm deposit' : 'Confirm withdrawal'}
            </button>
            <p className="fine">Robinhood Chain testnet only. No real funds.</p>
          </form>

          {notice && (
            <p key={notice.id} className={`notice ${notice.kind}`} role="status" style={{ marginTop: 16 }}>
              {notice.text}
            </p>
          )}
        </section>
      </div>

      <section className="card pool-card" aria-label="How LP rewards work">
        <h2>How LPs earn</h2>
        <p className="rule">5% of realized profit from profitable leveraged positions is allocated to LPs.</p>
        <ol className="pflow">
          <li>
            <b>Trader profit</b>
            <span>A leveraged position closes in profit</span>
          </li>
          <li aria-hidden="true" className="arrow">
            <span className="num">5%</span>
          </li>
          <li>
            <b>Margin Pool</b>
            <span>The 5% is routed to the LP reward pool</span>
          </li>
          <li aria-hidden="true" className="arrow" />
          <li>
            <b>LPs</b>
            <span>Split pro rata by your share of the pool</span>
          </li>
        </ol>
        <p className="help" style={{ textAlign: 'center' }}>
          Open and close a profitable position on <Link to="/trade" style={{ textDecoration: 'underline' }}>Trade</Link>{' '}
          to see it arrive here. In the full design, rewards follow the pool capital that backed each position.
        </p>
      </section>

      <section className="card pool-card" aria-label="Pool activity">
        <h2>
          Pool activity <span className="count num">{state.activity.length}</span>
        </h2>
        <ul className="history">
          {state.activity.slice(0, 20).map((h) => (
            <li key={h.id}>
              <span className={`kind ${h.kind.toLowerCase()}`}>{h.kind}</span>
              <span className="text">{h.text}</span>
              <span className="num amt">{fmtEth(h.amount)}</span>
              <span className="time">{fmtTime(h.at)}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
