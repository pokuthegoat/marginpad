import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from 'jose'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AuthError, authenticate, type AuthDeps } from './auth.js'

const APP_ID = 'test-app-id'
const USER = 'did:privy:user-1'
const WALLET = '0x' + 'ab'.repeat(20)
const OTHER = '0x' + 'cd'.repeat(20)

let signKey: CryptoKey
let keys: (appId: string) => JWTVerifyGetKey
let strangerKey: CryptoKey

async function token(opts: { key?: CryptoKey; aud?: string; iss?: string; sub?: string; exp?: string | number } = {}) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(opts.iss ?? 'privy.io')
    .setAudience(opts.aud ?? APP_ID)
    .setSubject(opts.sub ?? USER)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? signKey)
}

const req = (headers: Record<string, string>) => new Request('http://localhost/api/account', { method: 'POST', headers })

const deps = (wallets: string[]): AuthDeps => ({ keys, linkedWallets: async () => wallets })

beforeAll(async () => {
  const pair = await generateKeyPair('ES256')
  signKey = pair.privateKey
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }
  const set = createLocalJWKSet({ keys: [jwk] })
  keys = () => set
  strangerKey = (await generateKeyPair('ES256')).privateKey
})

afterEach(() => {
  process.env.PRIVY_APP_ID = APP_ID
  process.env.PRIVY_APP_SECRET = 'test-secret'
})

async function expectAuthError(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(AuthError)
  expect(err).toMatchObject({ code, status })
}

describe('authenticate', () => {
  it('accepts a valid token for a wallet linked to that user', async () => {
    process.env.PRIVY_APP_ID = APP_ID
    process.env.PRIVY_APP_SECRET = 'test-secret'
    const auth = await authenticate(req({ authorization: `Bearer ${await token()}`, 'x-wallet-address': WALLET }), deps([WALLET]))
    expect(auth).toEqual({ userId: USER, wallet: WALLET })
  })

  it('treats a mixed-case (checksum) wallet header as the same wallet', async () => {
    const mixed = '0x' + 'aB'.repeat(20)
    const auth = await authenticate(req({ authorization: `Bearer ${await token()}`, 'x-wallet-address': mixed }), deps([WALLET]))
    expect(auth.wallet).toBe(WALLET)
  })

  it("refuses a wallet that is not linked to the user, however valid the token is", async () => {
    await expectAuthError(
      authenticate(req({ authorization: `Bearer ${await token()}`, 'x-wallet-address': OTHER }), deps([WALLET])),
      'UNAUTHENTICATED',
      401,
    )
  })

  it('refuses a missing or malformed Authorization header', async () => {
    await expectAuthError(authenticate(req({ 'x-wallet-address': WALLET }), deps([WALLET])), 'UNAUTHENTICATED', 401)
    await expectAuthError(authenticate(req({ authorization: 'Bearer ', 'x-wallet-address': WALLET }), deps([WALLET])), 'UNAUTHENTICATED', 401)
    await expectAuthError(authenticate(req({ authorization: `Basic ${await token()}` }), deps([WALLET])), 'UNAUTHENTICATED', 401)
    await expectAuthError(authenticate(req({ authorization: 'Bearer not-a-jwt', 'x-wallet-address': WALLET }), deps([WALLET])), 'UNAUTHENTICATED', 401)
  })

  it('refuses a token signed by someone else, for another app, from another issuer, or expired', async () => {
    const cases = [
      await token({ key: strangerKey }),
      await token({ aud: 'another-app' }),
      await token({ iss: 'evil.example' }),
      await token({ exp: Math.floor(Date.now() / 1000) - 60 }),
    ]
    for (const t of cases) {
      await expectAuthError(authenticate(req({ authorization: `Bearer ${t}`, 'x-wallet-address': WALLET }), deps([WALLET])), 'UNAUTHENTICATED', 401)
    }
  })

  it('refuses a token with no subject', async () => {
    const t = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer('privy.io').setAudience(APP_ID).setExpirationTime('5m').sign(signKey)
    await expectAuthError(authenticate(req({ authorization: `Bearer ${t}`, 'x-wallet-address': WALLET }), deps([WALLET])), 'UNAUTHENTICATED', 401)
  })

  it('without a wallet header, works only when the user has exactly one linked wallet', async () => {
    const t = await token()
    expect((await authenticate(req({ authorization: `Bearer ${t}` }), deps([WALLET]))).wallet).toBe(WALLET)
    await expectAuthError(authenticate(req({ authorization: `Bearer ${t}` }), deps([WALLET, OTHER])), 'UNAUTHENTICATED', 401)
    await expectAuthError(authenticate(req({ authorization: `Bearer ${t}` }), deps([])), 'UNAUTHENTICATED', 401)
  })

  it('reports NOT_CONFIGURED (503) when the server has no app secret, before touching anything else', async () => {
    delete process.env.PRIVY_APP_SECRET
    await expectAuthError(authenticate(req({ authorization: `Bearer ${await token()}`, 'x-wallet-address': WALLET }), deps([WALLET])), 'NOT_CONFIGURED', 503)
  })

  it('never calls Privy to look up wallets when the token is invalid', async () => {
    let called = false
    const spy: AuthDeps = { keys, linkedWallets: async () => ((called = true), [WALLET]) }
    await expectAuthError(authenticate(req({ authorization: `Bearer ${await token({ key: strangerKey })}`, 'x-wallet-address': WALLET }), spy), 'UNAUTHENTICATED', 401)
    expect(called).toBe(false)
  })
})
