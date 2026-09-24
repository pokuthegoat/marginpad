import { useEffect, useRef, useState } from 'react'
import { USERNAME_MAX, validateUsername } from '../../lib/profile-rules'
import { ApiError } from './api-error'

/**
 * First-time setup. Deliberately not dismissable (no close button, Escape or backdrop click):
 * an account isn't finished until it has a username. The only way out is to disconnect.
 */
export function UsernameModal({
  onSubmit,
  onDisconnect,
}: {
  onSubmit: (username: string) => Promise<void>
  onDisconnect: () => void
}) {
  const [value, setValue] = useState('')
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  const check = validateUsername(value)
  const fieldError = serverError ?? (touched && value && !check.ok ? check.message : null)

  // Lock page scroll behind the modal.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  // Keep keyboard focus inside the dialog, and ignore Escape (setup is required).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return e.preventDefault()
    if (e.key !== 'Tab') return
    const items = dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])')
    if (!items?.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (!check.ok || busy) return
    setBusy(true)
    setServerError(null)
    try {
      await onSubmit(check.value) // on success the provider closes this modal
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onKeyDown={onKeyDown} data-lenis-prevent>
      <div
        ref={dialogRef}
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="username-title"
        aria-describedby="username-desc"
      >
        <span className="eyebrow">Welcome to Marginpad</span>
        <h2 id="username-title" className="t-h1 modal-title">
          Choose username
        </h2>
        <p id="username-desc" className="lead">
          This is how you&apos;ll appear on Marginpad. It also becomes your display name to start.
        </p>

        <form onSubmit={submit} noValidate>
          <label className="field">
            <span className="field-label">Username</span>
            <input
              className={`text-input${fieldError ? ' has-error' : ''}`}
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setServerError(null)
              }}
              onBlur={() => setTouched(true)}
              maxLength={USERNAME_MAX + 5}
              autoFocus
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="e.g. TraderOne"
              aria-invalid={!!fieldError}
              aria-describedby="username-hint"
            />
          </label>
          <p id="username-hint" className={`field-note${fieldError ? ' is-error' : ''}`} role={fieldError ? 'alert' : undefined}>
            {fieldError ?? '3-20 letters, numbers or underscores.'}
          </p>

          <button type="submit" className="btn btn-primary btn-block" disabled={busy || !check.ok}>
            {busy ? 'Saving…' : 'Continue'}
          </button>
        </form>

        <p className="fine">You can change your username or display name later, but only once every 7 days.</p>
        <button type="button" className="link-btn" onClick={onDisconnect} disabled={busy}>
          Disconnect wallet
        </button>
      </div>
    </div>
  )
}
