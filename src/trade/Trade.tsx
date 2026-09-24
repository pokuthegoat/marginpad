import { useState } from 'react'
import { Row, Segmented, Slider } from '../components/controls'
import { useStore } from '../store/StoreContext'
import { fmtCompact, fmtEth, fmtPct, fmtPrice, fmtSignedEth, floor4 } from '../store/format'
import { TOKENS, liquidationPrice, pnlFor, sizeFor, tokenById, type Side, type Token } from '../store/market'
import { LP_PROFIT_SHARE, borrowRoom, closeOutcome, validateOpen, type Settlement } from '../store/store'

function Sparkline({ points }: { points: number[] }) {
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * 200
      const y = 44 - ((p - min) / span) * 40
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const up = points[points.length - 1] >= points[0]
  return (
    <svg
      className={`spark ${up ? 'up' : 'down'}`}
      viewBox="0 0 200 48"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Recent price ${up ? 'rising' : 'falling'}`}
    >
      <polyline points={d} fill="none" strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function SettlementCard({ s }: { s: Settlement }) {
  const t = tokenById(s.tokenId)
  const profit = s.kind === 'closed' && s.pnl > 0
  return (
    <li className="card pcard settled">
      <div className="pcard-top">
        <b>{t.symbol}</b>
        <span className={`badge badge-${s.side}`}>{s.side === 'long' ? 'Long' : 'Short'}</span>
        <span className="badge num">{s.leverage.toFixed(1)}x</span>
        <span className={`badge ${s.kind === 'liquidated' ? 'badge-short' : ''}`}>
          {s.kind === 'liquidated' ? 'Liquidated' : 'Closed'}
        </span>
      </div>
      <dl className="group">
        <Row label="Your collateral" value={fmtEth(s.collateral)} />
        <Row label="Profit or loss" value={fmtSignedEth(s.pnl)} tone={s.pnl >= 0 ? 'gain' : 'loss'} />
        {profit && (
          <>
            <Row label={`LP share (${fmtPct(LP_PROFIT_SHARE)} of profit)`} value={`-${fmtEth(s.toLps)}`} />
            <Row label="Profit you keep" value={fmtEth(s.pnl - s.toLps)} />
          </>
        )}
        {s.kind === 'liquidated' && (
          <>
            <Row label="Borrowed, back to pool" value={fmtEth(s.borrowed)} />
            <Row label="Left over, to LPs" value={fmtEth(s.toLps)} />
          </>
        )}
        {s.poolLoss > 0 && <Row label="Loss taken by the pool" value={fmtEth(s.poolLoss)} tone="loss" />}
        <Row label="Paid to your wallet" value={fmtEth(s.payout)} strong />
      </dl>
    </li>
  )
}

export default function Trade() {
  const { state, actions } = useStore()
  const [selectedId, setSelectedId] = useState(TOKENS[1].id)
  const [side, setSide] = useState<Side>('long')
  const [amountText, setAmountText] = useState('')
  const [leverage, setLeverage] = useState(1.5)

  const token = tokenById(selectedId)
  const price = state.prices[token.id]
  const room = borrowRoom(state, token.id)

  const amount = Number.parseFloat(amountText)
  const amountOk = Number.isFinite(amount) && amount > 0
  const collateral = amountOk ? amount : 0
  const { size, borrowed } = sizeFor(collateral, leverage)
  const liq = liquidationPrice(price, leverage, side, token.maintenance)
  const liqDistance = Math.abs(liq - price) / price

  const error = amountOk ? validateOpen(state, token.id, amount, leverage) : null
  const canOpen = amountOk && !error

  const selectToken = (t: Token) => {
    setSelectedId(t.id)
    setLeverage((l) => Math.min(l, t.maxLeverage))
  }

  const open = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canOpen) return
    actions.open(token.id, side, amount, leverage)
    setAmountText('')
  }

  const notice = state.notice?.scope === 'trade' ? state.notice : null
  const levStops = Array.from({ length: Math.floor(token.maxLeverage) }, (_, i) => i + 1)

  return (
    <main className="wrap stack">
      <div className="title">
        <p className="eyebrow">Trade</p>
        <h1 className="t-h1">Open a leveraged position</h1>
        <p className="lead">Choose a market and your collateral. The pool funds the rest.</p>
      </div>

      <div className="chips" aria-label="Markets">
        <div className="chips-inner">
          {TOKENS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="mchip"
              aria-pressed={t.id === selectedId}
              onClick={() => selectToken(t)}
            >
              <b>{t.symbol}</b>
              <small className="num">
                {fmtPrice(state.prices[t.id])} · {t.maxLeverage}x
              </small>
            </button>
          ))}
        </div>
      </div>

      <section className="card market" aria-label={`${token.name} market`}>
        <div>
          <h2>
            {token.name} <span>{token.symbol}</span>
          </h2>
          <p className="price num">{fmtPrice(price)}</p>
        </div>
        <Sparkline points={state.history[token.id]} />
        <dl className="stats">
          <div>
            <dt>Market cap</dt>
            <dd className="num">{fmtCompact(token.marketCap)}</dd>
          </div>
          <div>
            <dt>Liquidity</dt>
            <dd className="num">{fmtCompact(token.liquidity)}</dd>
          </div>
          <div>
            <dt>24h volume</dt>
            <dd className="num">{fmtCompact(token.volume24h)}</dd>
          </div>
          <div>
            <dt>Max leverage</dt>
            <dd className="num">{token.maxLeverage}x</dd>
          </div>
          <div>
            <dt>Can borrow now</dt>
            <dd className="num">{fmtEth(room)}</dd>
          </div>
        </dl>
        <div className="demo-ctl">
          <span>Demo: move the {token.symbol} price</span>
          {[-0.5, -0.3, -0.1, 0.1, 0.3].map((pct) => (
            <button key={pct} type="button" className="btn btn-glass btn-sm" onClick={() => actions.nudge(token.id, pct)}>
              {pct > 0 ? '+' : ''}
              {pct * 100}%
            </button>
          ))}
        </div>
      </section>

      <form className="card ticket" onSubmit={open}>
        <Segmented
          label="Direction"
          value={side}
          onChange={setSide}
          options={[
            { value: 'long', label: 'Long' },
            { value: 'short', label: 'Short' },
          ]}
          tone={(v) => v}
        />

        <div>
          <label htmlFor="amount" className="field-label">
            Your collateral
          </label>
          <div className="amount" data-invalid={error ? '' : undefined}>
            <input
              id="amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={amountText}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d.]/g, '')
                if ((v.match(/\./g) ?? []).length <= 1) setAmountText(v)
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby="amount-help"
            />
            <span className="unit">ETH</span>
          </div>
          <div className="presets">
            {[0.25, 0.5, 0.75, 1].map((pct) => (
              <button
                key={pct}
                type="button"
                className="btn btn-glass btn-sm"
                onClick={() => setAmountText(String(floor4(state.wallet * pct)))}
              >
                {pct === 1 ? 'Max' : `${pct * 100}%`}
              </button>
            ))}
          </div>
          <p id="amount-help" className={error ? 'help err' : 'help'} role={error ? 'alert' : undefined}>
            {error ?? `Wallet: ${fmtEth(state.wallet)}`}
          </p>
        </div>

        <div>
          <div className="lev-head">
            <label htmlFor="lev" className="field-label">
              Leverage
            </label>
            <b className="num lev-val">{leverage.toFixed(1)}x</b>
          </div>
          <Slider
            id="lev"
            min={1}
            max={token.maxLeverage}
            step={0.1}
            value={leverage}
            onChange={setLeverage}
            valueText={`${leverage.toFixed(1)}x`}
          />
          <div className="ticks num" aria-hidden="true">
            {levStops.map((n) => (
              <span key={n}>{n}x</span>
            ))}
          </div>
          <p className="help">
            {token.symbol} allows up to {token.maxLeverage}x right now.
          </p>
        </div>

        <dl className="group">
          <Row label="Your collateral" value={fmtEth(collateral)} />
          <Row label="Pool capital used" value={fmtEth(borrowed)} />
          <Row label="Selected leverage" value={`${leverage.toFixed(1)}x`} />
          <Row label="Total position size" value={fmtEth(size)} strong />
          <Row label="Entry price" value={fmtPrice(price)} />
          <div>
            <dt>Est. liquidation price</dt>
            <dd className="num loss">
              {fmtPrice(liq)}
              <small> {(liqDistance * 100).toFixed(1)}% {side === 'long' ? 'below' : 'above'}</small>
            </dd>
          </div>
        </dl>

        <button type="submit" className={`btn btn-block btn-${side}`} disabled={!canOpen}>
          Open Position
        </button>
        <p className="fine">
          Your collateral absorbs losses first. If a trade closes in profit, 5% of the profit goes to pool providers.
          Mock data only.
        </p>
      </form>

      <section aria-label="Open positions">
        <h2 className="h-center">
          Open positions <span className="count num">{state.positions.length}</span>
        </h2>
        {notice && (
          <p key={notice.id} className={`notice ${notice.kind}`} role="status" style={{ marginBottom: 16 }}>
            {notice.text}
          </p>
        )}
        {state.positions.length === 0 ? (
          <p className="empty">
            Nothing open yet. Pick a market, enter an amount and choose your leverage to open your first position.
          </p>
        ) : (
          <ul className="pos-list">
            {state.positions.map((p) => {
              const t = tokenById(p.tokenId)
              const mark = state.prices[p.tokenId]
              const pnl = pnlFor(p, mark)
              const roe = pnl / p.collateral
              const out = closeOutcome(p, mark, 'closed')
              return (
                <li key={p.id} className="card pcard">
                  <div className="pcard-top">
                    <b>{t.symbol}</b>
                    <span className={`badge badge-${p.side}`}>{p.side === 'long' ? 'Long' : 'Short'}</span>
                    <span className="badge num">{p.leverage.toFixed(1)}x</span>
                  </div>
                  <p className={`pnl num ${pnl >= 0 ? 'gain' : 'loss'}`}>
                    {fmtSignedEth(pnl)}
                    <small>
                      {roe >= 0 ? '+' : ''}
                      {(roe * 100).toFixed(1)}%
                    </small>
                  </p>
                  <dl className="group">
                    <Row label="Position size" value={fmtEth(p.size)} />
                    <Row label="Collateral" value={fmtEth(p.collateral)} />
                    <Row label="From pool" value={fmtEth(p.borrowed)} />
                    <Row label="Entry" value={fmtPrice(p.entry)} />
                    <Row label="Current" value={fmtPrice(mark)} />
                    <Row label="Liquidation" value={fmtPrice(p.liq)} />
                  </dl>
                  <p className="sub-title">If you close now</p>
                  <dl className="group">
                    {pnl > 0 ? (
                      <>
                        <Row label="Profit" value={fmtEth(out.pnl)} />
                        <Row label={`LP share (${fmtPct(LP_PROFIT_SHARE)})`} value={`-${fmtEth(out.toLps)}`} />
                        <Row label="Profit you keep" value={fmtEth(out.pnl - out.toLps)} />
                      </>
                    ) : (
                      <Row label="Loss, from your collateral" value={fmtEth(-out.pnl)} tone="loss" />
                    )}
                    <Row label="You receive" value={fmtEth(out.payout)} strong />
                    <Row label="Back to the pool" value={fmtEth(p.borrowed)} />
                  </dl>
                  <button type="button" className="btn btn-glass btn-block" onClick={() => actions.close(p.id)}>
                    Close position
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {state.settlements.length > 0 && (
          <>
            <h2 className="h-center" style={{ marginTop: 36 }}>
              Closed positions <span className="count num">{state.settlements.length}</span>
            </h2>
            <ul className="pos-list">
              {state.settlements.slice(0, 5).map((s) => (
                <SettlementCard key={s.id} s={s} />
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  )
}
