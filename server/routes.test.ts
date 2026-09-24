import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * End-to-end through the real route handlers, the real service code and a real database file. Only the Privy identity
 * check is replaced (its own behaviour is covered in auth.test.ts): a request acts as the wallet in `x-test-wallet`.
 */
vi.mock('./auth.js', async () => {
  class AuthError extends Error {
    code: string
    status: number
    constructor(code: string, message: string, status: number) {
      super(message)
      this.code = code
      this.status = status
    }
  }
  return {
    AuthError,
    authenticate: async (request: Request) => {
      const wallet = request.headers.get('x-test-wallet')
      if (!wallet) throw new AuthError('UNAUTHENTICATED', 'Connect your wallet to continue.', 401)
      return { userId: `did:privy:${wallet}`, wallet }
    },
  }
})

const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 300 }, (_, i) => i % 251)])

let dir: string
let account: typeof import('../api/account/index.js')
let setup: typeof import('../api/account/setup.js')
let avatarApi: typeof import('../api/account/avatar.js')
let avatarGet: typeof import('../api/avatar/[username].js')
let db: Awaited<ReturnType<typeof import('./db.js').getDb>>

const url = (p: string) => `http://localhost${p}`
const json = (method: string, p: string, wallet: string | null, body?: unknown) =>
  new Request(url(p), {
    method,
    headers: { ...(wallet ? { 'x-test-wallet': wallet } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  })
const upload = (wallet: string, bytes: Uint8Array, type = 'image/png', name = 'me.png') => {
  const form = new FormData()
  form.append('avatar', new File([bytes.slice().buffer as ArrayBuffer], name, { type }))
  return new Request(url('/api/account/avatar'), { method: 'POST', headers: { 'x-test-wallet': wallet }, body: form })
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'marginpad-test-'))
  process.env.MARGINPAD_DB_PATH = path.join(dir, 'routes.db')
  delete process.env.TURSO_DATABASE_URL
  delete process.env.VERCEL
  account = await import('../api/account/index.js')
  setup = await import('../api/account/setup.js')
  avatarApi = await import('../api/account/avatar.js')
  avatarGet = await import('../api/avatar/[username].js')
  db = await (await import('./db.js')).getDb()
})

beforeEach(async () => {
  await db.execute('DELETE FROM avatars')
  await db.execute('DELETE FROM accounts')
})

afterAll(() => {
  db.close()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows can hold the database file for a moment after close.
  }
})

async function body(res: Response) {
  return (await res.json()) as { account?: Record<string, unknown>; error?: { code: string; message: string; availableAt?: number } }
}

describe('the account flow, as the browser drives it', () => {
  it('connect -> choose username -> edit name -> locked', async () => {
    // First connect creates the account (setup incomplete), and connecting again is harmless.
    let res = await account.POST(json('POST', '/api/account', A))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await body(res)).account).toMatchObject({ walletAddress: A, setupComplete: false, username: null })
    res = await account.POST(json('POST', '/api/account', A))
    expect(res.status).toBe(200)

    // Setup.
    res = await setup.POST(json('POST', '/api/account/setup', A, { username: 'Alice' }))
    expect(res.status).toBe(200)
    expect((await body(res)).account).toMatchObject({ username: 'Alice', displayName: 'Alice', setupComplete: true })
    res = await setup.POST(json('POST', '/api/account/setup', A, { username: 'Other' }))
    expect(res.status).toBe(409)
    expect((await body(res)).error?.code).toBe('ALREADY_SET_UP')

    // A first change works and starts the cooldown; the second is refused with 429 + Retry-After.
    res = await account.PATCH(json('PATCH', '/api/account', A, { displayName: 'Alice Cooper' }))
    expect(res.status).toBe(200)
    expect((await body(res)).account?.displayName).toBe('Alice Cooper')
    res = await account.PATCH(json('PATCH', '/api/account', A, { displayName: 'Again' }))
    expect(res.status).toBe(429)
    const err = (await body(res)).error
    expect(err?.code).toBe('COOLDOWN')
    expect(err?.availableAt).toBeGreaterThan(Date.now())
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(60 * 60 * 24 * 6)
  })

  it('maps validation and conflict errors to the right statuses', async () => {
    await account.POST(json('POST', '/api/account', A))
    await account.POST(json('POST', '/api/account', B))
    await setup.POST(json('POST', '/api/account/setup', A, { username: 'Alice' }))

    let res = await setup.POST(json('POST', '/api/account/setup', B, { username: 'alice' }))
    expect(res.status).toBe(409)
    expect((await body(res)).error?.code).toBe('USERNAME_TAKEN')
    res = await setup.POST(json('POST', '/api/account/setup', B, { username: 'admin' }))
    expect(res.status).toBe(400)
    expect((await body(res)).error?.code).toBe('INVALID_USERNAME')
    res = await account.PATCH(json('PATCH', '/api/account', B, { displayName: 'Bob' }))
    expect(res.status).toBe(409)
    expect((await body(res)).error?.code).toBe('SETUP_REQUIRED')
  })

  it('rejects unauthenticated requests and malformed bodies before doing anything', async () => {
    for (const handler of [account.POST, account.PATCH, setup.POST, avatarApi.POST, avatarApi.DELETE]) {
      const res = await handler(json('POST', '/api/x', null))
      expect(res.status).toBe(401)
      expect((await body(res)).error?.code).toBe('UNAUTHENTICATED')
    }
    await account.POST(json('POST', '/api/account', A))
    for (const bad of ['not json', '[]', '"str"', 'x'.repeat(5000)]) {
      const res = await setup.POST(json('POST', '/api/account/setup', A, bad))
      expect(res.status, bad.slice(0, 10)).toBe(400)
      expect((await body(res)).error?.code).toBe('BAD_REQUEST')
    }
    const nothing = await account.PATCH(json('PATCH', '/api/account', A, {}))
    expect(nothing.status).toBe(400)
    expect((await body(nothing)).error?.code).toBe('NO_CHANGES')
  })

  it('never leaks internals: an unexpected failure becomes a plain 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await db.execute('ALTER TABLE accounts RENAME TO accounts_gone')
    try {
      const res = await account.POST(json('POST', '/api/account', A))
      expect(res.status).toBe(500)
      const text = JSON.stringify(await body(res))
      expect(text).toContain('INTERNAL')
      expect(text).not.toMatch(/sqlite|accounts_gone|no such table/i)
    } finally {
      await db.execute('ALTER TABLE accounts_gone RENAME TO accounts')
      spy.mockRestore()
    }
  })
})

describe('avatar upload and download over HTTP', () => {
  beforeEach(async () => {
    await account.POST(json('POST', '/api/account', A))
    await setup.POST(json('POST', '/api/account/setup', A, { username: 'Alice' }))
  })

  it('uploads, serves the exact bytes publicly with safe headers, and reflects the new version', async () => {
    const res = await avatarApi.POST(upload(A, PNG))
    expect(res.status).toBe(200)
    const acct = (await body(res)).account
    expect(acct).toMatchObject({ username: 'Alice', avatarVersion: 1 }) // a real account object, not an empty shell

    const got = await avatarGet.GET(new Request(url('/api/avatar/Alice?v=1')))
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(got.headers.get('x-content-type-options')).toBe('nosniff')
    expect(got.headers.get('cache-control')).toContain('immutable')
    expect(Array.from(new Uint8Array(await got.arrayBuffer()))).toEqual(Array.from(PNG))

    // Username lookups are case-insensitive.
    expect((await avatarGet.GET(new Request(url('/api/avatar/ALICE?v=1')))).status).toBe(200)
  })

  it('refuses non-images even when the browser labels them image/png', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const res = await avatarApi.POST(upload(A, svg, 'image/png', 'evil.png'))
    expect(res.status).toBe(400)
    expect((await body(res)).error?.code).toBe('BAD_REQUEST')
    expect((await avatarGet.GET(new Request(url('/api/avatar/Alice')))).status).toBe(404)
  })

  it('refuses a body that is not multipart, a missing file field, and an oversized declared upload', async () => {
    const notForm = new Request(url('/api/account/avatar'), { method: 'POST', headers: { 'x-test-wallet': A, 'content-type': 'text/plain' }, body: 'hi' })
    expect((await avatarApi.POST(notForm)).status).toBe(400)

    const empty = new FormData()
    empty.append('other', 'x')
    const noFile = new Request(url('/api/account/avatar'), { method: 'POST', headers: { 'x-test-wallet': A }, body: empty })
    expect((await avatarApi.POST(noFile)).status).toBe(400)

    const huge = new Request(url('/api/account/avatar'), {
      method: 'POST',
      headers: { 'x-test-wallet': A, 'content-length': String(5 * 1024 * 1024) },
      body: new FormData(),
    })
    const res = await avatarApi.POST(huge)
    expect(res.status).toBe(400)
    expect((await body(res)).error?.message).toMatch(/2 MB/)
  })

  it('removing it returns the fresh account and the picture is gone', async () => {
    await avatarApi.POST(upload(A, PNG))
    const res = await avatarApi.DELETE(json('DELETE', '/api/account/avatar', A))
    expect(res.status).toBe(200)
    expect((await body(res)).account).toMatchObject({ avatarVersion: 2 })
    expect((await avatarGet.GET(new Request(url('/api/avatar/Alice?v=2')))).status).toBe(404)
  })

  it("one user's upload never shows under another user's name", async () => {
    await account.POST(json('POST', '/api/account', B))
    await setup.POST(json('POST', '/api/account/setup', B, { username: 'Bobby' }))
    await avatarApi.POST(upload(A, PNG))
    expect((await avatarGet.GET(new Request(url('/api/avatar/Bobby')))).status).toBe(404)
  })

  it('unknown, malformed and hostile usernames are plain 404s', async () => {
    for (const name of ['nobody', 'x', '%E0%A4%A', '..%2F..%2Fetc', 'a'.repeat(50), '<script>']) {
      const res = await avatarGet.GET(new Request(url(`/api/avatar/${name}`)))
      expect(res.status, name).toBe(404)
    }
  })
})
