import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NAME_COOLDOWN_MS } from '../src/lib/profile-rules.js'

const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)

let dir: string
let accounts: typeof import('./accounts.js')
let db: Awaited<ReturnType<typeof import('./db.js').getDb>>

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'marginpad-test-'))
  process.env.MARGINPAD_DB_PATH = path.join(dir, 'accounts.db')
  delete process.env.TURSO_DATABASE_URL
  delete process.env.VERCEL
  accounts = await import('./accounts.js')
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
    // Windows can hold the database file for a moment after close; the OS temp folder cleans it up.
  }
})

describe('account creation', () => {
  it('creates an account on first connect, with setup incomplete', async () => {
    const acc = await accounts.ensureAccount(A, 'did:privy:1')
    expect(acc).toMatchObject({ walletAddress: A, username: null, displayName: null, setupComplete: false, avatarVersion: 0 })
    expect(acc.nameChangeAvailableAt).toBeNull()
  })

  it('is idempotent: connecting again loads the same account, never a duplicate', async () => {
    const first = await accounts.ensureAccount(A, 'did:privy:1')
    const again = await accounts.ensureAccount(A, 'did:privy:1')
    expect(again.createdAt).toBe(first.createdAt)
    const count = await db.execute('SELECT COUNT(*) AS n FROM accounts')
    expect(Number(count.rows[0].n)).toBe(1)
  })

  it('survives a burst of simultaneous first connects', async () => {
    await Promise.all(Array.from({ length: 8 }, () => accounts.ensureAccount(A, 'did:privy:1')))
    const count = await db.execute('SELECT COUNT(*) AS n FROM accounts')
    expect(Number(count.rows[0].n)).toBe(1)
  })
})

describe('first-time setup', () => {
  it('sets the username, which also becomes the display name, without starting the cooldown', async () => {
    await accounts.ensureAccount(A, 'did:privy:1')
    const res = await accounts.completeSetup(A, 'Alice')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.account).toMatchObject({ username: 'Alice', displayName: 'Alice', setupComplete: true, nameChangedAt: null })
    expect(res.account.nameChangeAvailableAt).toBeNull()
  })

  it('cannot be run twice', async () => {
    await accounts.ensureAccount(A, 'did:privy:1')
    await accounts.completeSetup(A, 'Alice')
    const again = await accounts.completeSetup(A, 'Alice2')
    expect(again).toMatchObject({ ok: false, code: 'ALREADY_SET_UP' })
  })

  it('rejects bad, reserved and non-string usernames', async () => {
    await accounts.ensureAccount(A, 'did:privy:1')
    for (const bad of ['ab', 'x'.repeat(21), 'has space', '_lead', 'trail_', 'emoji😀', 'admin', 'MarginPad', 'PRIVY', 42, null]) {
      const res = await accounts.completeSetup(A, bad)
      expect(res, String(bad)).toMatchObject({ ok: false, code: 'INVALID_USERNAME' })
    }
  })

  it('makes usernames unique regardless of case', async () => {
    await accounts.ensureAccount(A, 'did:privy:1')
    await accounts.ensureAccount(B, 'did:privy:2')
    await accounts.completeSetup(A, 'Alice')
    const clash = await accounts.completeSetup(B, 'aLiCe')
    expect(clash).toMatchObject({ ok: false, code: 'USERNAME_TAKEN' })
  })

  it('reports NOT_FOUND for a wallet that never connected', async () => {
    expect(await accounts.completeSetup(A, 'Alice')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })
})

describe('changing names and the 7-day cooldown', () => {
  beforeEach(async () => {
    await accounts.ensureAccount(A, 'did:privy:1')
    await accounts.completeSetup(A, 'Alice')
  })

  it('needs setup first', async () => {
    await accounts.ensureAccount(B, 'did:privy:2')
    expect(await accounts.updateProfile(B, { displayName: 'Bob' })).toMatchObject({ ok: false, code: 'SETUP_REQUIRED' })
  })

  it('changes the display name and locks both names for 7 days', async () => {
    const res = await accounts.updateProfile(A, { displayName: 'Alice Cooper' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.account.displayName).toBe('Alice Cooper')
    expect(res.account.nameChangedAt).not.toBeNull()
    expect(res.account.nameChangeAvailableAt).toBeGreaterThan(Date.now() + NAME_COOLDOWN_MS - 5_000)
  })

  it('refuses a second change inside the window, for either field, and reports when it unlocks', async () => {
    await accounts.updateProfile(A, { displayName: 'Alice Cooper' })
    const byName = await accounts.updateProfile(A, { displayName: 'Someone Else' })
    const byUser = await accounts.updateProfile(A, { username: 'Alice2' })
    for (const res of [byName, byUser]) {
      expect(res).toMatchObject({ ok: false, code: 'COOLDOWN' })
      if (!res.ok) expect(res.availableAt).toBeGreaterThan(Date.now())
    }
  })

  it('the database itself blocks a name change inside the window, even for a hand-written UPDATE', async () => {
    await accounts.updateProfile(A, { displayName: 'Alice Cooper' })
    // Without stamping the clock forward, the "must stamp" backstop refuses it.
    await expect(
      db.execute({ sql: 'UPDATE accounts SET display_name = ? WHERE wallet_address = ?', args: ['Sneaky', A] }),
    ).rejects.toThrow(/NAME_CHANGE_NOT_STAMPED/)
    // Stamping the clock forward to look legitimate still hits the cooldown backstop.
    await expect(
      db.execute({
        sql: 'UPDATE accounts SET display_name = ?, name_changed_at = ? WHERE wallet_address = ?',
        args: ['Sneaky', Date.now() + 1000, A],
      }),
    ).rejects.toThrow(/NAME_COOLDOWN/)
    expect((await accounts.getAccount(A))?.displayName).toBe('Alice Cooper')
  })

  it('the database refuses to rewind the cooldown clock', async () => {
    await accounts.updateProfile(A, { displayName: 'Alice Cooper' })
    await expect(
      db.execute({ sql: 'UPDATE accounts SET name_changed_at = 1 WHERE wallet_address = ?', args: [A] }),
    ).rejects.toThrow(/FORWARD_ONLY/)
  })

  it('only one of many simultaneous changes gets through', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => accounts.updateProfile(A, { displayName: `Name ${i}` })),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok && r.code === 'COOLDOWN')).toHaveLength(5)
  })

  it('rejects unchanged, empty and invalid input', async () => {
    expect(await accounts.updateProfile(A, {})).toMatchObject({ ok: false, code: 'NO_CHANGES' })
    expect(await accounts.updateProfile(A, { username: 'Alice' })).toMatchObject({ ok: false, code: 'NO_CHANGES' })
    expect(await accounts.updateProfile(A, { displayName: '<script>' })).toMatchObject({ ok: false, code: 'INVALID_DISPLAY_NAME' })
    expect(await accounts.updateProfile(A, { username: 'no' })).toMatchObject({ ok: false, code: 'INVALID_USERNAME' })
  })

  it("won't let you take someone else's username", async () => {
    await accounts.ensureAccount(B, 'did:privy:2')
    await accounts.completeSetup(B, 'Bobby')
    expect(await accounts.updateProfile(A, { username: 'bobby' })).toMatchObject({ ok: false, code: 'USERNAME_TAKEN' })
  })
})

describe('looking up a wallet by username', () => {
  it('finds it regardless of case and returns null otherwise', async () => {
    await accounts.ensureAccount(A, 'did:privy:1')
    await accounts.completeSetup(A, 'Alice')
    expect(await accounts.walletForUsername('ALICE')).toBe(A)
    expect(await accounts.walletForUsername('nobody')).toBeNull()
    expect(await accounts.walletForUsername('x')).toBeNull()
    expect(await accounts.walletForUsername(undefined)).toBeNull()
  })
})
