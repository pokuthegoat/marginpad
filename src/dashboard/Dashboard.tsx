import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AccountDTO } from '../lib/account-types'
import { DISPLAY_NAME_MAX, USERNAME_MAX, validateDisplayName, validateUsername } from '../lib/profile-rules'
import ConnectWallet from '../components/ConnectWallet'
import { useAccount } from '../components/account/AccountProvider'
import { ApiError } from '../components/account/api-error'
import { ProfileAvatar } from '../components/account/ProfileAvatar'
import { useStore } from '../store/StoreContext'
import { fmtSignedEth } from '../store/format'
import { tokenById } from '../store/market'
import { netResult } from '../store/store'

const formatDate = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))

const formatDay = (ms: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(ms))

const formatTradeTime = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms))

function formatRemaining(ms: number) {
  const mins = Math.max(1, Math.ceil(ms / 60000))
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  if (days > 0) return `${days} day${days === 1 ? '' : 's'}${hours ? `, ${hours} hour${hours === 1 ? '' : 's'}` : ''}`
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'}`
  return 'less than an hour'
}

/** Current time, refreshed every 30 seconds, so the countdown and unlock happen without a reload. */
function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now
}

export default function Dashboard() {
  const { status, account, error, retry } = useAccount()

  let body: ReactNode
  if (status === 'loading') {
    body = <Notice title="Loading your dashboard…" />
  } else if (status === 'error') {
    body = (
      <Notice title="We couldn't load your dashboard" body={error ?? 'Something went wrong.'}>
        <button type="button" className="btn btn-primary" onClick={retry}>
          Try again
        </button>
      </Notice>
    )
  } else if (status === 'signed-out' || !account) {
    body = (
      <Notice title="Connect your wallet" body="Your Marginpad dashboard is tied to your wallet. Connect it to see your dashboard.">
        <ConnectWallet />
      </Notice>
    )
  } else if (!account.setupComplete) {
    body = <Notice title="Finish setting up your account" body="Choose a username to continue." />
  } else {
    body = <DashboardForm key={account.walletAddress} account={account} />
  }

  return <main className="wrap stack">{body}</main>
}

function Notice({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <section className="card notice-card">
      <h1 className="t-h1">{title}</h1>
      {body && <p className="lead">{body}</p>}
      {children && <div className="notice-actions">{children}</div>}
    </section>
  )
}

/** How many closed trades the dashboard shows before "View all". */
const RECENT_TRADES = 5

/**
 * The 5 most recent closed trades, straight from the shared trade state (the same list the Trade page keeps when a
 * position is closed or liquidated). Newest first. P&L is what the trader actually made or lost after the 5% LP share.
 */
function RecentTrades() {
  const { state } = useStore()
  const trades = state.settlements.slice(0, RECENT_TRADES)

  return (
    <section className="card dash-card" aria-labelledby="recent-h">
      <h2 id="recent-h" className="h-center">
        Recent trades
      </h2>

      {trades.length === 0 ? (
        <div className="empty trades-empty">
          <p>No closed trades yet.</p>
          <p className="small">Trades you close or that get liquidated will show up here.</p>
          <Link to="/trade" className="btn btn-primary btn-sm">
            Open a trade
          </Link>
        </div>
      ) : (
        <ul className="trade-list">
          {trades.map((t) => {
            const token = tokenById(t.tokenId)
            const net = netResult(t)
            const tone = net > 0 ? 'gain' : net < 0 ? 'loss' : ''
            return (
              <li key={t.id} className={`trade-row ${tone}`}>
                <div className="trade-main">
                  <b className="trade-sym">{token.symbol}</b>
                  <span className={`badge badge-${t.side}`}>{t.side === 'long' ? 'Long' : 'Short'}</span>
                  <span className="badge num">{t.leverage.toFixed(1)}x</span>
                  {t.kind === 'liquidated' && <span className="badge badge-short">Liquidated</span>}
                </div>
                <time className="trade-time" dateTime={new Date(t.at).toISOString()}>
                  {formatTradeTime(t.at)}
                </time>
                <div className={`trade-pnl num ${tone}`}>
                  <span className="sr">{net > 0 ? 'Profit: ' : net < 0 ? 'Loss: ' : 'Break-even: '}</span>
                  <span aria-hidden="true" className="trade-arrow">
                    {net > 0 ? '▲' : net < 0 ? '▼' : ''}
                  </span>
                  {fmtSignedEth(net)}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <div className="trades-foot">
        {/* A full trade history page doesn't exist yet, so this is a placeholder for it. */}
        <button type="button" className="btn btn-glass btn-sm" disabled title="The full trade history is coming soon">
          View all →
        </button>
        <p className="fine">Your closed and liquidated trades on the Robinhood Chain testnet.</p>
      </div>
    </section>
  )
}

function DashboardForm({ account }: { account: AccountDTO }) {
  const { updateNames } = useAccount()
  const now = useNow()

  const [username, setUsername] = useState(account.username ?? '')
  const [displayName, setDisplayName] = useState(account.displayName ?? '')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; displayName?: string }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // The server sends the unlock time; the UI just counts down to it. The server still re-checks on save.
  const availableAt = account.nameChangeAvailableAt
  const locked = availableAt !== null && availableAt > now

  // Keep inputs in sync with the saved account (after a save, or if it changes elsewhere).
  useEffect(() => {
    setUsername(account.username ?? '')
    setDisplayName(account.displayName ?? '')
  }, [account.username, account.displayName])

  const u = validateUsername(username)
  const d = validateDisplayName(displayName)
  const usernameChanged = u.ok ? u.value !== account.username : username.trim() !== account.username
  const displayChanged = d.ok ? d.value !== account.displayName : displayName.trim() !== account.displayName
  const dirty = usernameChanged || displayChanged
  const valid = u.ok && d.ok

  const inlineError = {
    username: fieldErrors.username ?? (usernameChanged && !u.ok ? u.message : undefined),
    displayName: fieldErrors.displayName ?? (displayChanged && !d.ok ? d.message : undefined),
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(account.walletAddress)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked: the address is still selectable on screen */
    }
  }

  const save = async () => {
    if (!valid || !dirty || busy) return
    setBusy(true)
    setFormError(null)
    setFieldErrors({})
    setSaved(false)
    try {
      await updateNames({
        ...(usernameChanged && u.ok ? { username: u.value } : {}),
        ...(displayChanged && d.ok ? { displayName: d.value } : {}),
      })
      setSaved(true)
      setConfirming(false)
    } catch (e) {
      setConfirming(false)
      if (e instanceof ApiError) {
        if (e.code === 'USERNAME_TAKEN' || e.code === 'INVALID_USERNAME') setFieldErrors({ username: e.message })
        else if (e.code === 'INVALID_DISPLAY_NAME') setFieldErrors({ displayName: e.message })
        else if (e.code === 'COOLDOWN') setFormError("Your name was changed recently, so it's locked for now.")
        else setFormError(e.message)
      } else {
        setFormError('Something went wrong. Please try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className="title dash-head">
        <p className="eyebrow">Dashboard</p>
        <ProfileAvatar account={account} />
        <h1 className="t-display dash-name">{account.displayName}</h1>
        <p className="lead">
          @{account.username} · Member since {formatDay(account.createdAt)}
        </p>
      </header>

      <section className="card dash-card" aria-labelledby="account-h">
        <h2 id="account-h" className="h-center">
          Account
        </h2>

        <div className="field">
          <span className="field-label">Connected wallet</span>
          <div className="wallet-row">
            <output className="wallet-addr">{account.walletAddress}</output>
            <button type="button" className="btn btn-glass btn-sm" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        {locked && availableAt !== null && (
          <div className="lock-note" role="status">
            <b>Name changes are locked.</b> You changed your username or display name recently. You can change either
            again on <b>{formatDate(availableAt)}</b> ({formatRemaining(availableAt - now)} from now).
          </div>
        )}

        <form
          className="dash-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (valid && dirty && !locked) setConfirming(true)
          }}
          noValidate
        >
          <label className="field">
            <span className="field-label">Username</span>
            <input
              className={`text-input${inlineError.username ? ' has-error' : ''}`}
              value={username}
              disabled={locked || busy}
              maxLength={USERNAME_MAX + 5}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => {
                setUsername(e.target.value)
                setFieldErrors((f) => ({ ...f, username: undefined }))
                setSaved(false)
                setConfirming(false)
              }}
              aria-invalid={!!inlineError.username}
            />
            <span className={`field-note${inlineError.username ? ' is-error' : ''}`} role={inlineError.username ? 'alert' : undefined}>
              {inlineError.username ?? 'Unique. 3-20 letters, numbers or underscores.'}
            </span>
          </label>

          <label className="field">
            <span className="field-label">Display name</span>
            <input
              className={`text-input${inlineError.displayName ? ' has-error' : ''}`}
              value={displayName}
              disabled={locked || busy}
              maxLength={DISPLAY_NAME_MAX + 8}
              autoComplete="off"
              onChange={(e) => {
                setDisplayName(e.target.value)
                setFieldErrors((f) => ({ ...f, displayName: undefined }))
                setSaved(false)
                setConfirming(false)
              }}
              aria-invalid={!!inlineError.displayName}
            />
            <span className={`field-note${inlineError.displayName ? ' is-error' : ''}`} role={inlineError.displayName ? 'alert' : undefined}>
              {inlineError.displayName ?? "Shown around Marginpad. Doesn't need to be unique."}
            </span>
          </label>

          {formError && (
            <p className="field-note is-error" role="alert">
              {formError}
            </p>
          )}
          {saved && !locked && <p className="field-note is-ok">Saved.</p>}
          {saved && locked && availableAt !== null && (
            <p className="field-note is-ok" role="status">
              Saved. You can change your name again on {formatDate(availableAt)}.
            </p>
          )}

          {!locked && !confirming && (
            <div className="dash-actions">
              <button type="submit" className="btn btn-primary btn-block" disabled={!dirty || !valid || busy}>
                Save changes
              </button>
              <span className="fine">Changing either name locks both for 7 days.</span>
            </div>
          )}

          {!locked && confirming && (
            <div className="confirm-box" role="alertdialog" aria-labelledby="confirm-h">
              <p id="confirm-h">
                <b>Save these changes?</b> You won&apos;t be able to change your username or display name again for 7
                days.
              </p>
              <div className="dash-actions two">
                <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
                  {busy ? 'Saving…' : 'Yes, save'}
                </button>
                <button type="button" className="btn btn-glass" onClick={() => setConfirming(false)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </form>
      </section>

      <RecentTrades />
    </>
  )
}
