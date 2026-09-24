import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Slider } from './components/controls'
import { scrollToSection } from './lib/smooth-scroll'

/* Illustrative only: real thresholds are a risk-engine parameter. */
const STAGES = [
  { cap: 'Under $50k', depth: 'Thin', max: 1.5 },
  { cap: '$50k to $250k', depth: 'Early', max: 2 },
  { cap: '$250k to $1M', depth: 'Growing', max: 4 },
  { cap: '$1M to $5M', depth: 'Deep', max: 7 },
  { cap: 'Over $5M', depth: 'Established', max: 10 },
]

function Head({ eyebrow, children, lead }: { eyebrow: string; children: React.ReactNode; lead?: string }) {
  return (
    <div className="section-head">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="t-h1">{children}</h2>
      {lead && <p className="lead">{lead}</p>}
    </div>
  )
}

function Hero() {
  return (
    <section className="hero wrap-wide">
      <div className="hero-inner">
        <p className="eyebrow">Launch spot. Trade margin.</p>
        <h1 className="t-display">
          Launch a token.
          <br />
          Unlock margin.
        </h1>
        <p className="lead">The margin layer for Pons launches.</p>
        <div className="actions">
          <Link className="btn btn-primary" to="/trade">
            Start trading
          </Link>
          <a
            className="btn btn-glass"
            href="#how"
            onClick={(e) => {
              if (scrollToSection('how')) e.preventDefault()
            }}
          >
            How it works
          </a>
        </div>
      </div>
    </section>
  )
}

function Idea() {
  return (
    <section className="section wrap" data-scene-anchor="0.06">
      <Head
        eyebrow="The idea"
        lead="A token launched through Pons can get a Marginpad market right away. Traders get leverage from day one, funded by a shared pool of Robinhood ETH instead of a separate market built later."
      >
        Spot trading shouldn’t be where a launch ends.
      </Head>
      <p className="flow">
        <span>Launch</span>
        <i aria-hidden="true" />
        <span>Margin</span>
      </p>
    </section>
  )
}

function How() {
  const steps = [
    ['Launch on Pons', 'A creator launches a token. Marginpad activates a margin market for it.'],
    ['Choose your leverage', 'Pick any level up to the token’s current maximum, never above 10x.'],
    ['The pool funds the rest', 'Your balance is the collateral. The shared pool supplies the extra buying power.'],
  ]
  return (
    <section className="section wrap-wide" id="how" data-scene-anchor="0.14">
      <Head eyebrow="How it works">Three steps from launch to leverage.</Head>
      <ol className="grid3">
        {steps.map(([title, text], i) => (
          <li key={title} className="card">
            <span className="step-num num">{i + 1}</span>
            <h3 className="t-h3">{title}</h3>
            <p>{text}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

function PoolSection() {
  const [lev, setLev] = useState(1.5)
  const collateral = 1
  const borrowed = collateral * (lev - 1)
  const size = collateral * lev
  return (
    <section className="section wrap" data-scene-anchor="0.3">
      <Head
        eyebrow="One shared pool"
        lead="Anyone can add Robinhood ETH to a single pool. It backs eligible positions across every supported market, and the risk engine decides how much each market can draw."
      >
        Deposit ETH. Fund positions. Earn.
      </Head>

      <figure className="card demo" aria-label="Example position">
        <figcaption className="field-label">Example: $1 of your own balance</figcaption>
        <div className="demo-row">
          <label htmlFor="demo-lev" className="muted">
            Leverage
          </label>
          <Slider
            id="demo-lev"
            min={1}
            max={2}
            step={0.1}
            value={lev}
            onChange={setLev}
            valueText={`${lev.toFixed(1)}x`}
          />
          <b className="num">{lev.toFixed(1)}x</b>
        </div>
        <div
          className="bar"
          role="img"
          aria-label={`Collateral $${collateral.toFixed(2)}, pool capital $${borrowed.toFixed(2)}`}
        >
          <div className="seg-a" style={{ flexGrow: collateral }}>
            <span className="num">${collateral.toFixed(2)}</span>
            <small>Yours</small>
          </div>
          <div className="seg-b" style={{ flexGrow: Math.max(borrowed, 0.0001) }}>
            {borrowed > 0.05 && (
              <>
                <span className="num">${borrowed.toFixed(2)}</span>
                <small>From the pool</small>
              </>
            )}
          </div>
        </div>
        <div className="group">
          <div className="strong">
            <dt>Position size</dt>
            <dd className="num">${size.toFixed(2)}</dd>
          </div>
        </div>
      </figure>

      <p className="share">
        <b className="num">5%</b>
        <span>
          of realized profit on a winning leveraged trade goes to the pool providers that backed it, split by how much
          capital each supplied.
        </span>
      </p>
    </section>
  )
}

function Growth() {
  const [i, setI] = useState(1)
  const s = STAGES[i]
  return (
    <section className="section wrap" data-scene-anchor="0.44">
      <Head eyebrow="Leverage that grows">
        Thin markets start low. Deep markets earn more, up to <mark>10x</mark>.
      </Head>
      <div className="card growth">
        <label htmlFor="stage" className="field-label">
          Market maturity
        </label>
        <Slider
          id="stage"
          min={0}
          max={STAGES.length - 1}
          step={1}
          value={i}
          onChange={setI}
          valueText={`${s.depth}, maximum ${s.max}x`}
        />
        <div className="ticks" aria-hidden="true">
          <span>Thin</span>
          <span>Deep</span>
        </div>
        <div className="readout" aria-live="polite">
          <div>
            <small>Market cap</small>
            <p className="num">{s.cap}</p>
          </div>
          <div>
            <small>Max leverage</small>
            <p className="max num">{s.max}x</p>
          </div>
        </div>
        <p className="small" style={{ textAlign: 'center' }}>
          Illustrative steps. Market cap is one input. Liquidity depth, volume, volatility and pool utilization also
          set the limit.
        </p>
      </div>
    </section>
  )
}

function Sides() {
  const sides = [
    ['Creators', 'Launch a token and get an attached margin market. No lending pool to bootstrap.'],
    ['Traders', 'Enter with your own balance, pick leverage, and see size and liquidation level first.'],
    ['Liquidity providers', 'Supply Robinhood ETH once. It works across markets while you earn a share of profits.'],
  ]
  return (
    <section className="section wrap-wide" id="who" data-scene-anchor="0.58">
      <Head eyebrow="Who it’s for">Built for creators, traders and liquidity providers.</Head>
      <div className="grid3">
        {sides.map(([t, d]) => (
          <div key={t} className="card">
            <h3 className="t-h3">{t}</h3>
            <p>{d}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function Risk() {
  return (
    <section className="section wrap" data-scene-anchor="0.72">
      <Head
        eyebrow="Risk engine"
        lead="Your collateral absorbs losses first, and positions are closed before losses reach the pool. Each market has its own borrowing cap, position limits and liquidity checks, so leverage only expands where the market can carry it."
      >
        Automated controls sit under every position.
      </Head>
      <ul className="checks">
        <li>Leverage limits set per market</li>
        <li>Liquidity and slippage checks at liquidation size</li>
        <li>Borrowing caps and utilization limits</li>
        <li>Emergency controls</li>
      </ul>
    </section>
  )
}

function Final() {
  return (
    <section className="section wrap" data-scene-anchor="0.86">
      <div className="card final">
        <h2 className="t-h1">Launch spot. Trade margin.</h2>
        <Link className="btn btn-white" to="/trade">
          Get started
        </Link>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="foot wrap">
      <p>
        Marginpad is a proposal. The profit share, leverage curve, liquidation rules and pool protections are still
        under technical, economic, security and legal review. Leveraged trading can lose your entire collateral.
      </p>
    </footer>
  )
}

export default function App() {
  return (
    <main>
      <Hero />
      <Idea />
      <How />
      <PoolSection />
      <Growth />
      <Sides />
      <Risk />
      <Final />
      <Footer />
    </main>
  )
}
