import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { normalizeWallet } from '../src/lib/wallet.js'

/**
 * Proves, server-side, which wallet a request is acting for. The browser is never trusted.
 *
 *  1. The request carries the user's Privy access token (`Authorization: Bearer ...`).
 *  2. We verify its signature against Privy's public keys (ES256, issuer "privy.io", audience = our app id).
 *     That yields the user's Privy DID.
 *  3. We ask Privy (with the app secret, server-side only) which wallets that DID has linked. Privy only links
 *     a wallet after the user signed a message proving they control it.
 *  4. The wallet the client says it is acting as must be one of them.
 *
 * So an attacker can't create or edit an account for a wallet they don't control, no matter what they send.
 * The App Secret (PRIVY_APP_SECRET) is server-only: it has no VITE_ prefix, so the browser build never sees it.
 */

const PRIVY_ISSUER = 'privy.io'

export type AuthFailure = 'UNAUTHENTICATED' | 'NOT_CONFIGURED'

export class AuthError extends Error {
  code: AuthFailure
  status: number
  constructor(code: AuthFailure, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface Authed {
  /** Privy user DID. */
  userId: string
  /** Normalised wallet address this request is acting as. */
  wallet: string
}

/** Overridable so tests can use their own signing key and skip the network. */
export interface AuthDeps {
  keys?: (appId: string) => JWTVerifyGetKey
  linkedWallets?: (userId: string, appId: string, appSecret: string) => Promise<string[]>
}

function config() {
  const appId = process.env.PRIVY_APP_ID ?? process.env.VITE_PRIVY_APP_ID
  const appSecret = process.env.PRIVY_APP_SECRET
  if (!appId || !appSecret) {
    throw new AuthError('NOT_CONFIGURED', 'Accounts are not configured on this server.', 503)
  }
  return { appId, appSecret }
}

// The key set is fetched once and cached (and refreshed by `jose` when Privy rotates keys).
const g = globalThis as unknown as { __privyJwks?: { appId: string; jwks: JWTVerifyGetKey } }
function remoteKeys(appId: string): JWTVerifyGetKey {
  if (!g.__privyJwks || g.__privyJwks.appId !== appId) {
    g.__privyJwks = {
      appId,
      jwks: createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`)),
    }
  }
  return g.__privyJwks.jwks
}

export async function verifyAccessToken(token: string, appId: string, keys: JWTVerifyGetKey): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: PRIVY_ISSUER,
      audience: appId,
      algorithms: ['ES256'],
    })
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('token has no subject')
    return payload.sub
  } catch {
    throw new AuthError('UNAUTHENTICATED', 'Your session is invalid or has expired. Reconnect your wallet.', 401)
  }
}

// Short-lived cache so a burst of requests doesn't hit Privy's API each time.
const WALLET_CACHE_MS = 60_000
const walletCache = new Map<string, { wallets: string[]; expires: number }>()

async function fetchLinkedWallets(userId: string, appId: string, appSecret: string): Promise<string[]> {
  const cached = walletCache.get(userId)
  if (cached && cached.expires > Date.now()) return cached.wallets

  const res = await fetch(`https://api.privy.io/v1/users/${encodeURIComponent(userId)}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
      'privy-app-id': appId,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Privy user lookup failed: HTTP ${res.status}`)

  const body = (await res.json()) as { linked_accounts?: { type?: string; address?: unknown }[] }
  const wallets = (body.linked_accounts ?? [])
    .filter((a) => a.type === 'wallet' && typeof a.address === 'string')
    .map((a) => normalizeWallet(a.address as string))

  if (walletCache.size > 500) walletCache.clear() // bound memory
  walletCache.set(userId, { wallets, expires: Date.now() + WALLET_CACHE_MS })
  return wallets
}

/** Authenticate a request and resolve the wallet it acts as. Throws AuthError (401/503) on failure. */
export async function authenticate(request: Request, deps: AuthDeps = {}): Promise<Authed> {
  const { appId, appSecret } = config()

  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) throw new AuthError('UNAUTHENTICATED', 'Connect your wallet to continue.', 401)

  const userId = await verifyAccessToken(token, appId, (deps.keys ?? remoteKeys)(appId))
  const wallets = await (deps.linkedWallets ?? fetchLinkedWallets)(userId, appId, appSecret)

  const claimed = request.headers.get('x-wallet-address')
  if (claimed) {
    const wallet = normalizeWallet(claimed)
    if (!wallets.includes(wallet)) {
      throw new AuthError('UNAUTHENTICATED', "That wallet isn't linked to your session.", 401)
    }
    return { userId, wallet }
  }
  if (wallets.length === 1) return { userId, wallet: wallets[0] }
  throw new AuthError('UNAUTHENTICATED', 'No wallet specified for this session.', 401)
}
