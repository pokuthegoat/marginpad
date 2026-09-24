import { avatarUrl } from '../lib/avatar'

/**
 * A profile picture, or a generated initial-letter circle (from the display name) if none has been uploaded.
 * Pure (no hooks), so it works anywhere a picture is shown.
 */
export function Avatar({
  username,
  displayName,
  avatarVersion,
  size = 72,
}: {
  username: string
  displayName: string
  avatarVersion: number
  size?: number
}) {
  const src = avatarUrl(username, avatarVersion)
  const initial = (displayName || username || '?').trim().charAt(0).toUpperCase() || '?'
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}>
      {src ? <img src={src} alt="" width={size} height={size} /> : <span aria-hidden="true">{initial}</span>}
    </span>
  )
}
