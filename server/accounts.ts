import type { AccountDTO, ApiErrorCode } from '../src/lib/account-types.js'
import { NAME_COOLDOWN_MS, usernameKey, validateDisplayName, validateUsername } from '../src/lib/profile-rules.js'
import { getDb } from './db.js'

/**
 * The account service: the only module that reads or writes account rows.
 * All validation and cooldown logic lives here (plus database triggers as a backstop),
 * never in the browser.
 */

interface Row {
  wallet_address: string
  privy_user_id: string
  username: string | null
  username_key: string | null
  display_name: string | null
  name_changed_at: number | null
  created_at: number
  updated_at: number
  avatar_version: number
}

export type ServiceResult =
  | { ok: true; account: AccountDTO }
  | { ok: false; code: ApiErrorCode; message: string; availableAt?: number }

const fail = (code: ApiErrorCode, message: string, availableAt?: number): ServiceResult => ({
  ok: false,
  code,
  message,
  ...(availableAt !== undefined ? { availableAt } : {}),
})

async function readRow(wallet: string): Promise<Row | undefined> {
  const db = await getDb()
  const res = await db.execute({ sql: 'SELECT * FROM accounts WHERE wallet_address = ?', args: [wallet] })
  return res.rows[0] as unknown as Row | undefined
}

function toDTO(row: Row, now = Date.now()): AccountDTO {
  const availableAt = row.name_changed_at === null ? null : row.name_changed_at + NAME_COOLDOWN_MS
  return {
    walletAddress: row.wallet_address,
    username: row.username,
    displayName: row.display_name,
    setupComplete: row.username !== null,
    nameChangedAt: row.name_changed_at,
    nameChangeAvailableAt: availableAt !== null && availableAt > now ? availableAt : null,
    createdAt: row.created_at,
    avatarVersion: row.avatar_version,
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const isUsernameTaken = (e: unknown) => /UNIQUE constraint failed: accounts\.username_key/.test(errorText(e))
const isCooldownAbort = (e: unknown) => errorText(e).includes('NAME_COOLDOWN')

/**
 * Create the account for a wallet if it doesn't exist, otherwise load it.
 * Idempotent: the wallet address is the primary key, so duplicates are impossible even under races.
 */
export async function ensureAccount(wallet: string, privyUserId: string): Promise<AccountDTO> {
  const now = Date.now()
  const db = await getDb()
  await db.execute({
    sql: `INSERT INTO accounts (wallet_address, privy_user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?) ON CONFLICT (wallet_address) DO NOTHING`,
    args: [wallet, privyUserId, now, now],
  })
  return toDTO((await readRow(wallet))!, now)
}

export async function getAccount(wallet: string): Promise<AccountDTO | null> {
  const row = await readRow(wallet)
  return row ? toDTO(row) : null
}

/** The wallet behind a username (case-insensitive), or null. Lets a public request (e.g. for an avatar) resolve a
 * username to the account it needs without the browser ever seeing the wallet address itself. */
export async function walletForUsername(usernameInput: unknown): Promise<string | null> {
  const name = validateUsername(usernameInput)
  if (!name.ok) return null
  const db = await getDb()
  const res = await db.execute({
    sql: 'SELECT wallet_address FROM accounts WHERE username_key = ?',
    args: [usernameKey(name.value)],
  })
  const row = res.rows[0] as unknown as { wallet_address: string } | undefined
  return row?.wallet_address ?? null
}

/**
 * First-time setup: choose a username, which also becomes the display name.
 * Does not start the 7-day cooldown (choosing your first name isn't a "change").
 */
export async function completeSetup(wallet: string, usernameInput: unknown): Promise<ServiceResult> {
  const username = validateUsername(usernameInput)
  if (!username.ok) return fail('INVALID_USERNAME', username.message)

  const now = Date.now()
  const db = await getDb()
  try {
    const res = await db.execute({
      sql: `UPDATE accounts SET username = ?, username_key = ?, display_name = ?, updated_at = ?
            WHERE wallet_address = ? AND username IS NULL`,
      args: [username.value, usernameKey(username.value), username.value, now, wallet],
    })
    if (res.rowsAffected === 0) {
      return (await readRow(wallet))
        ? fail('ALREADY_SET_UP', 'This account already has a username.')
        : fail('NOT_FOUND', 'Account not found.')
    }
  } catch (e) {
    if (isUsernameTaken(e)) return fail('USERNAME_TAKEN', 'That username is already taken.')
    throw e
  }
  return { ok: true, account: toDTO((await readRow(wallet))!, now) }
}

/**
 * Change the username and/or display name. One shared 7-day cooldown covers both fields:
 * any successful change locks both for a week.
 *
 * The cooldown is decided by the database (atomic conditional UPDATE + triggers), not by this
 * function's earlier read, so concurrent requests can't slip two changes through.
 */
export async function updateProfile(
  wallet: string,
  input: { username?: unknown; displayName?: unknown },
): Promise<ServiceResult> {
  const wantsUsername = input.username !== undefined
  const wantsDisplayName = input.displayName !== undefined
  if (!wantsUsername && !wantsDisplayName) return fail('NO_CHANGES', 'Nothing to change.')

  let nextUsername: string | undefined
  if (wantsUsername) {
    const v = validateUsername(input.username)
    if (!v.ok) return fail('INVALID_USERNAME', v.message)
    nextUsername = v.value
  }
  let nextDisplayName: string | undefined
  if (wantsDisplayName) {
    const v = validateDisplayName(input.displayName)
    if (!v.ok) return fail('INVALID_DISPLAY_NAME', v.message)
    nextDisplayName = v.value
  }

  const current = await readRow(wallet)
  if (!current) return fail('NOT_FOUND', 'Account not found.')
  if (current.username === null) return fail('SETUP_REQUIRED', 'Choose a username first.')

  const username = nextUsername ?? current.username
  const displayName = nextDisplayName ?? current.display_name!
  if (username === current.username && displayName === current.display_name) {
    return fail('NO_CHANGES', "That's already your current name.")
  }

  const now = Date.now()
  if (current.name_changed_at !== null && current.name_changed_at + NAME_COOLDOWN_MS > now) {
    return fail('COOLDOWN', "You can't change your name yet.", current.name_changed_at + NAME_COOLDOWN_MS)
  }

  const db = await getDb()
  try {
    const res = await db.execute({
      sql: `UPDATE accounts
               SET username = ?, username_key = ?, display_name = ?, name_changed_at = ?, updated_at = ?
             WHERE wallet_address = ?
               AND username IS NOT NULL
               AND (name_changed_at IS NULL OR name_changed_at <= ?)`,
      args: [username, usernameKey(username), displayName, now, now, wallet, now - NAME_COOLDOWN_MS],
    })

    if (res.rowsAffected === 0) {
      // Lost a race with another change between our read and the write.
      const latest = await readRow(wallet)
      const availableAt = latest?.name_changed_at != null ? latest.name_changed_at + NAME_COOLDOWN_MS : undefined
      return fail('COOLDOWN', "You can't change your name yet.", availableAt)
    }
  } catch (e) {
    if (isUsernameTaken(e)) return fail('USERNAME_TAKEN', 'That username is already taken.')
    if (isCooldownAbort(e)) {
      const latest = await readRow(wallet)
      const availableAt = latest?.name_changed_at != null ? latest.name_changed_at + NAME_COOLDOWN_MS : undefined
      return fail('COOLDOWN', "You can't change your name yet.", availableAt)
    }
    throw e
  }
  return { ok: true, account: toDTO((await readRow(wallet))!, now) }
}
