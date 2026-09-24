/** Where an account's uploaded profile picture is served from, by USERNAME (never by wallet address, see
 * server/avatars.ts), or null if it hasn't set one (callers fall back to an initial-letter default). */
export function avatarUrl(username: string, avatarVersion: number): string | null {
  return avatarVersion > 0 ? `/api/avatar/${encodeURIComponent(username)}?v=${avatarVersion}` : null
}
