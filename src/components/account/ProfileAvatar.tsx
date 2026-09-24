import { useRef, useState } from 'react'
import type { AccountDTO } from '../../lib/account-types'
import { Avatar } from '../Avatar'
import { useAccount } from './AccountProvider'
import { ApiError } from './api-error'

/** Kept in sync with server/avatars.ts's AVATAR_MAX_BYTES: checked here too, so an oversized file is rejected
 * before it's even uploaded, not just after. */
const MAX_BYTES = 2 * 1024 * 1024
const ACCEPT = 'image/jpeg,image/png,image/webp'

/**
 * The editable avatar on the player's own dashboard: click it (or the label under it) to open the file picker and
 * upload a new picture.
 */
export function ProfileAvatar({ account }: { account: AccountDTO }) {
  const { uploadAvatar, removeAvatar } = useAccount()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onFile = async (file: File | undefined) => {
    if (!file || busy) return
    if (file.size > MAX_BYTES) {
      setError('Images must be 2 MB or smaller.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await uploadAvatar(file)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't upload that image. Please try again.")
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const onRemove = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await removeAvatar()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't remove your picture. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="profile-avatar">
      <button
        type="button"
        className="avatar-edit"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        aria-label={account.avatarVersion > 0 ? 'Change profile picture' : 'Add a profile picture'}
      >
        <Avatar username={account.username ?? ''} displayName={account.displayName ?? ''} avatarVersion={account.avatarVersion} size={96} />
        <span className="avatar-edit-hint">{busy ? 'Uploading…' : 'Change'}</span>
      </button>
      <input ref={inputRef} type="file" accept={ACCEPT} hidden onChange={(e) => void onFile(e.target.files?.[0])} />
      {account.avatarVersion > 0 && (
        <button type="button" className="link-btn" onClick={onRemove} disabled={busy}>
          Remove picture
        </button>
      )}
      {error && (
        <p className="field-note is-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
