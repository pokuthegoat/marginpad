import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)

/** Minimal valid-looking headers for each accepted format, padded with filler bytes. */
const jpeg = (n = 64) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: n }, (_, i) => i % 251)])
const png = (n = 64) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: n }, (_, i) => i % 251)])
const webp = (n = 64) =>
  Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, ...Array.from({ length: n }, (_, i) => i % 251)])

let dir: string
let accounts: typeof import('./accounts.js')
let avatars: typeof import('./avatars.js')
let db: Awaited<ReturnType<typeof import('./db.js').getDb>>

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'marginpad-test-'))
  process.env.MARGINPAD_DB_PATH = path.join(dir, 'avatars.db')
  delete process.env.TURSO_DATABASE_URL
  delete process.env.VERCEL
  accounts = await import('./accounts.js')
  avatars = await import('./avatars.js')
  db = await (await import('./db.js')).getDb()
})

beforeEach(async () => {
  await db.execute('DELETE FROM avatars')
  await db.execute('DELETE FROM accounts')
  await accounts.ensureAccount(A, 'did:privy:1')
  await accounts.completeSetup(A, 'Alice')
})

afterAll(() => {
  db.close()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows can hold the database file for a moment after close; the OS temp folder cleans it up.
  }
})

describe('image sniffing', () => {
  it('recognises JPEG, PNG and WebP from their own bytes', () => {
    expect(avatars.sniff(jpeg())).toBe('jpg')
    expect(avatars.sniff(png())).toBe('png')
    expect(avatars.sniff(webp())).toBe('webp')
  })

  it('refuses SVG (it can carry a script), HTML, text, GIF and empty input', () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    expect(avatars.sniff(enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull()
    expect(avatars.sniff(enc('<html><script>alert(1)</script></html>'))).toBeNull()
    expect(avatars.sniff(enc('GIF89a....'))).toBeNull()
    expect(avatars.sniff(enc('hello'))).toBeNull()
    expect(avatars.sniff(new Uint8Array())).toBeNull()
  })

  it('does not accept a RIFF file that is not WebP', () => {
    const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45, 0, 0])
    expect(avatars.sniff(wav)).toBeNull()
  })
})

describe('uploading and replacing', () => {
  it('stores the picture and bumps the version, and the bytes come back exactly', async () => {
    const img = png(200)
    const res = await avatars.setAvatar(A, img)
    expect(res).toEqual({ ok: true, version: 1 })
    const stored = await avatars.readAvatar(A)
    expect(stored?.contentType).toBe('image/png')
    expect(Array.from(stored!.bytes)).toEqual(Array.from(img))
    expect((await accounts.getAccount(A))?.avatarVersion).toBe(1)
  })

  it('replaces an earlier picture of any format and bumps the version each time', async () => {
    await avatars.setAvatar(A, png())
    const res = await avatars.setAvatar(A, jpeg(10))
    expect(res).toEqual({ ok: true, version: 2 })
    expect((await avatars.readAvatar(A))?.contentType).toBe('image/jpeg')
    const rows = await db.execute('SELECT COUNT(*) AS n FROM avatars')
    expect(Number(rows.rows[0].n)).toBe(1)
  })

  it('rejects files that are not real images, whatever they claim to be', async () => {
    const fake = new TextEncoder().encode('<svg onload=alert(1)>')
    expect(await avatars.setAvatar(A, fake)).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
    expect(await avatars.readAvatar(A)).toBeNull()
    expect((await accounts.getAccount(A))?.avatarVersion).toBe(0)
  })

  it('rejects empty and oversized uploads (over 2 MB) and changes nothing', async () => {
    expect(await avatars.setAvatar(A, new Uint8Array())).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
    const big = jpeg(avatars.AVATAR_MAX_BYTES)
    expect(big.byteLength).toBeGreaterThan(avatars.AVATAR_MAX_BYTES)
    expect(await avatars.setAvatar(A, big)).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
    expect((await accounts.getAccount(A))?.avatarVersion).toBe(0)
  })

  it('accepts a file right at the limit', async () => {
    const atLimit = jpeg(avatars.AVATAR_MAX_BYTES - 4)
    expect(atLimit.byteLength).toBe(avatars.AVATAR_MAX_BYTES)
    expect(await avatars.setAvatar(A, atLimit)).toMatchObject({ ok: true })
  })

  it('reports NOT_FOUND for a wallet with no account', async () => {
    expect(await avatars.setAvatar(B, png())).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await avatars.removeAvatar(B)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })
})

describe('removing and isolation', () => {
  it('removing reverts to the default: no picture, and the version still moves so caches drop it', async () => {
    await avatars.setAvatar(A, png())
    const res = await avatars.removeAvatar(A)
    expect(res).toEqual({ ok: true, version: 2 })
    expect(await avatars.readAvatar(A)).toBeNull()
  })

  it("one account's picture is never served for another", async () => {
    await accounts.ensureAccount(B, 'did:privy:2')
    await accounts.completeSetup(B, 'Bobby')
    await avatars.setAvatar(A, png())
    expect(await avatars.readAvatar(B)).toBeNull()
    expect(await avatars.readAvatar(A)).not.toBeNull()
  })

  it('the picture follows the wallet, so a username change does not orphan it', async () => {
    await avatars.setAvatar(A, png())
    await accounts.updateProfile(A, { username: 'AliceNew' })
    const wallet = await accounts.walletForUsername('AliceNew')
    expect(wallet).toBe(A)
    expect(await avatars.readAvatar(wallet!)).not.toBeNull()
  })
})
