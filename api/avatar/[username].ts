import { walletForUsername } from '../../server/accounts.js'
import { readAvatar } from '../../server/avatars.js'

/**
 * GET /api/avatar/[username]: that account's own uploaded profile picture, or a 404 if it hasn't set one (the
 * browser falls back to drawing its own initial-letter default; see src/components/Avatar.tsx). Public and
 * unauthenticated: an avatar sits at the same privacy tier as a username, which is already shown to anyone.
 */
export async function GET(request: Request) {
  const segment = new URL(request.url).pathname.split('/').filter(Boolean).pop() ?? ''
  let username = segment
  try {
    username = decodeURIComponent(segment)
  } catch {
    return new Response(null, { status: 404 })
  }
  const wallet = await walletForUsername(username)
  const found = wallet ? await readAvatar(wallet) : null
  if (!found) return new Response(null, { status: 404 })
  return new Response(found.bytes.slice().buffer as ArrayBuffer, {
    headers: {
      'Content-Type': found.contentType,
      // The URL's own ?v= is the cache-buster (see src/lib/avatar.ts): a given URL's bytes never change, so this
      // response itself never needs revalidating.
      'Cache-Control': 'public, max-age=31536000, immutable',
      // Never let a browser sniff an uploaded file into something executable.
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
