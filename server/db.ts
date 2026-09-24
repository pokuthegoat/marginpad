import { createClient, type Client } from '@libsql/client'
import fs from 'node:fs'

/**
 * Marginpad's database: libSQL (a SQLite-compatible engine) via @libsql/client. Server-only. Never import this from
 * browser code.
 *
 * Two targets, picked by which environment variables are set:
 *   - Local dev (no TURSO_DATABASE_URL): a local file (data/marginpad.db, or MARGINPAD_DB_PATH), opened directly by
 *     this same client library.
 *   - Production (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, a Turso database): a remote libSQL server. This is what
 *     makes the database survive on Vercel, whose own filesystem is ephemeral and can't keep a local file around.
 * Both targets go through the same client and the same SQL, so what works against the local file is a strong signal
 * it works against Turso too.
 *
 * Every method on the client is async: a plain `execute()` runs on its own logical connection, so a PRAGMA set
 * outside a transaction does not carry over to the next call.
 */

export const COOLDOWN_SQL_MS = 7 * 24 * 60 * 60 * 1000

// One client per server process; survives dev hot-reloads. `ready` is the in-flight (or finished) migration, so
// concurrent early callers all wait on the SAME migration instead of racing to run it twice.
const g = globalThis as unknown as {
  __marginpadDb?: { url: string; client: Client; ready: Promise<void> }
}

function databaseUrl(): string {
  const remote = process.env.TURSO_DATABASE_URL
  if (remote) return remote
  if (process.env.VERCEL) {
    // A local file on Vercel would silently lose every account between requests. Refuse instead.
    throw new Error('TURSO_DATABASE_URL is not set. Add your Turso database URL and token in the Vercel project settings.')
  }
  const file = process.env.MARGINPAD_DB_PATH
  if (file) {
    const dir = file.replace(/[\\/][^\\/]*$/, '')
    if (dir && dir !== file) fs.mkdirSync(dir, { recursive: true })
    return `file:${file}`
  }
  fs.mkdirSync('data', { recursive: true })
  return 'file:data/marginpad.db'
}

export async function getDb(): Promise<Client> {
  const url = databaseUrl()
  const cached = g.__marginpadDb
  if (cached && cached.url === url) {
    await cached.ready
    return cached.client
  }
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN })
  const entry = { url, client, ready: migrate(client) }
  g.__marginpadDb = entry
  await entry.ready
  return client
}

async function migrate(db: Client) {
  // The schema version lives in this tiny table, not PRAGMA user_version: Turso's hosted server allows READING that
  // pragma but rejects WRITING it, so every migration below ends by writing here instead.
  await db.execute(
    'CREATE TABLE IF NOT EXISTS _schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL) STRICT',
  )
  const row = (await db.execute('SELECT version FROM _schema_version WHERE id = 1')).rows[0] as unknown as
    | { version: number }
    | undefined
  let version = 0
  if (row) {
    version = row.version
  } else {
    await db.execute({ sql: 'INSERT INTO _schema_version (id, version) VALUES (1, ?)', args: [0] })
  }
  if (version < 1) await migrateV1(db)
  if (version < 2) await migrateV2(db)
}

/** v1: one row per wallet, with the name rules enforced by the database itself as a backstop. */
function migrateV1(db: Client) {
  return db.executeMultiple(`
    BEGIN;

    -- One row per wallet. The wallet address IS the account identity.
    CREATE TABLE accounts (
      wallet_address  TEXT PRIMARY KEY,
      privy_user_id   TEXT NOT NULL,
      username        TEXT,
      username_key    TEXT,           -- lower(username); uniqueness is case-insensitive
      display_name    TEXT,
      name_changed_at INTEGER,        -- epoch ms of the last username/display-name change (cooldown clock)
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      -- Account setup is all-or-nothing: no username without a key and display name, and vice versa.
      CHECK ((username IS NULL) = (username_key IS NULL) AND (username IS NULL) = (display_name IS NULL))
    ) STRICT;

    -- NULLs are distinct in SQLite, so accounts that haven't chosen a name yet don't collide.
    CREATE UNIQUE INDEX accounts_username_key ON accounts (username_key);

    -- Cooldown backstop enforced by the database itself, using the database's own clock.
    -- Even a buggy or hand-written UPDATE cannot change a name inside the 7-day window.
    CREATE TRIGGER accounts_name_cooldown
    BEFORE UPDATE OF username, display_name ON accounts
    WHEN OLD.username IS NOT NULL
     AND (NEW.username IS NOT OLD.username OR NEW.display_name IS NOT OLD.display_name)
     AND OLD.name_changed_at IS NOT NULL
     AND CAST(unixepoch('subsec') * 1000 AS INTEGER) < OLD.name_changed_at + ${COOLDOWN_SQL_MS}
    BEGIN
      SELECT RAISE(ABORT, 'NAME_COOLDOWN');
    END;

    -- Every post-setup name change must move the cooldown clock forward.
    CREATE TRIGGER accounts_name_change_must_stamp
    BEFORE UPDATE OF username, display_name ON accounts
    WHEN OLD.username IS NOT NULL
     AND (NEW.username IS NOT OLD.username OR NEW.display_name IS NOT OLD.display_name)
     AND (NEW.name_changed_at IS NULL OR NEW.name_changed_at IS OLD.name_changed_at)
    BEGIN
      SELECT RAISE(ABORT, 'NAME_CHANGE_NOT_STAMPED');
    END;

    -- The cooldown clock can never be rewound or cleared to sneak a change through.
    CREATE TRIGGER accounts_name_changed_at_forward_only
    BEFORE UPDATE OF name_changed_at ON accounts
    WHEN OLD.name_changed_at IS NOT NULL
     AND (NEW.name_changed_at IS NULL OR NEW.name_changed_at < OLD.name_changed_at)
    BEGIN
      SELECT RAISE(ABORT, 'NAME_CHANGED_AT_FORWARD_ONLY');
    END;

    INSERT INTO _schema_version (id, version) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET version = excluded.version;
    COMMIT;
  `)
}

/**
 * v2: profile pictures. The image bytes live in the database (a serverless host has no durable disk), keyed by
 * wallet. avatar_version counts every upload/removal so the picture's URL can carry it as a cache-buster.
 */
function migrateV2(db: Client) {
  return db.executeMultiple(`
    BEGIN;

    ALTER TABLE accounts ADD COLUMN avatar_version INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE avatars (
      wallet_address TEXT PRIMARY KEY REFERENCES accounts (wallet_address),
      content_type   TEXT NOT NULL,
      bytes          BLOB NOT NULL,
      updated_at     INTEGER NOT NULL
    ) STRICT;

    INSERT INTO _schema_version (id, version) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET version = excluded.version;
    COMMIT;
  `)
}
