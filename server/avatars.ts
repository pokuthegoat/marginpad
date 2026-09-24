import type { ApiErrorCode } from '../src/lib/account-types.js'
import { getAccount } from './accounts.js'
import { getDb } from './db.js'

/**
 * Profile pictures. The ONLY module that reads or writes an account's avatar: the `avatar_version` counter in
 * `accounts` and the image bytes in the `avatars` table (migration v2 in server/db.ts).
 *
 * The bytes live in the database, not on disk: on a serverless host like Vercel the filesystem is ephemeral, so a
 * file written by one request is gone by the next. At the 2 MB limit this is cheap to store and serve.
 *
 * Nothing here trusts what the browser CLAIMS a file is. The bytes are sniffed for a real image signature
 * (JPEG/PNG/WebP) before anything is written; anything else, including SVG (which can carry a script), is refused.
 * The wallet, never the username, is the row's key, so a later username change never orphans or misroutes a picture.
 */

const fail = (code: ApiErrorCode, message: string) => ({ ok: false as const, code, message })

/** Largest upload accepted. Generous enough for an ordinary photo, small enough that this stays cheap. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

type ImageKind = 'jpg' | 'png' | 'webp'
export const AVATAR_CONTENT_TYPE: Record<ImageKind, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/** The real format of an image, read from its own leading bytes, never from a filename or a claimed content-type.
 * null if it isn't one of the accepted formats. */
export function sniff(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return 'png'
  // RIFF....WEBP: bytes 4-7 are the chunk size, so only 0-3 and 8-11 identify it.
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'webp'
  return null
}

export type AvatarResult = { ok: true; version: number } | ReturnType<typeof fail>

/** Replace the account's avatar with these bytes. */
export async function setAvatar(wallet: string, bytes: Uint8Array): Promise<AvatarResult> {
  if (!(await getAccount(wallet))) return fail('NOT_FOUND', 'Account not found.')
  if (bytes.byteLength === 0) return fail('BAD_REQUEST', 'No image file given.')
  if (bytes.byteLength > AVATAR_MAX_BYTES) return fail('BAD_REQUEST', 'Images must be 2 MB or smaller.')
  const kind = sniff(bytes)
  if (!kind) return fail('BAD_REQUEST', "That doesn't look like a JPEG, PNG or WebP image.")

  const now = Date.now()
  const db = await getDb()
  // One atomic batch: the picture and its version counter move together or not at all.
  const results = await db.batch(
    [
      {
        sql: `INSERT INTO avatars (wallet_address, content_type, bytes, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT (wallet_address) DO UPDATE SET content_type = excluded.content_type,
                bytes = excluded.bytes, updated_at = excluded.updated_at`,
        args: [wallet, AVATAR_CONTENT_TYPE[kind], bytes, now],
      },
      {
        sql: 'UPDATE accounts SET avatar_version = avatar_version + 1, updated_at = ? WHERE wallet_address = ? RETURNING avatar_version',
        args: [now, wallet],
      },
    ],
    'write',
  )
  const row = results[1].rows[0] as unknown as { avatar_version: number }
  return { ok: true, version: Number(row.avatar_version) }
}

/** Remove the account's avatar, if it has one. Reverts it to the initial-letter default. */
export async function removeAvatar(wallet: string): Promise<AvatarResult> {
  if (!(await getAccount(wallet))) return fail('NOT_FOUND', 'Account not found.')
  const db = await getDb()
  const results = await db.batch(
    [
      { sql: 'DELETE FROM avatars WHERE wallet_address = ?', args: [wallet] },
      {
        sql: 'UPDATE accounts SET avatar_version = avatar_version + 1, updated_at = ? WHERE wallet_address = ? RETURNING avatar_version',
        args: [Date.now(), wallet],
      },
    ],
    'write',
  )
  const row = results[1].rows[0] as unknown as { avatar_version: number }
  return { ok: true, version: Number(row.avatar_version) }
}

/** The stored picture for a wallet that HAS one, or null. Callers resolve username -> wallet themselves
 * (see walletForUsername in server/accounts.ts): this module never takes a username. */
export async function readAvatar(wallet: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const db = await getDb()
  const res = await db.execute({
    sql: 'SELECT content_type, bytes FROM avatars WHERE wallet_address = ?',
    args: [wallet],
  })
  const row = res.rows[0] as unknown as { content_type: string; bytes: ArrayBuffer } | undefined
  if (!row) return null
  return { bytes: new Uint8Array(row.bytes), contentType: row.content_type }
}
