/**
 * Username / display-name rules, shared by the browser (instant feedback) and the server
 * (the authority). Nothing here is trusted client-side: the API re-validates every request.
 */

export const NAME_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000

export const USERNAME_MIN = 3
export const USERNAME_MAX = 20
export const DISPLAY_NAME_MAX = 32

export type FieldResult = { ok: true; value: string } | { ok: false; message: string }

/** Letters/digits/underscore, starting and ending with a letter or digit. */
const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_]*[A-Za-z0-9])?$/

/** Names that could be mistaken for the team or system. Compared case-insensitively. */
const RESERVED = new Set([
  'admin',
  'administrator',
  'mod',
  'moderator',
  'staff',
  'support',
  'help',
  'official',
  'security',
  'team',
  'system',
  'root',
  'null',
  'undefined',
  'marginpad',
  'marginpadteam',
  'wallet',
  'privy',
])

/** Usernames are unique case-insensitively ("Bob" and "bob" are the same name). */
export const usernameKey = (username: string) => username.toLowerCase()

export function validateUsername(input: unknown): FieldResult {
  if (typeof input !== 'string') return { ok: false, message: 'Enter a username.' }
  const value = input.trim()
  if (value.length < USERNAME_MIN || value.length > USERNAME_MAX) {
    return { ok: false, message: `Usernames are ${USERNAME_MIN}-${USERNAME_MAX} characters.` }
  }
  if (!USERNAME_RE.test(value)) {
    return {
      ok: false,
      message: 'Use letters, numbers and underscores only, starting and ending with a letter or number.',
    }
  }
  if (RESERVED.has(usernameKey(value))) return { ok: false, message: 'That username is reserved.' }
  return { ok: true, value }
}

// Control, format (zero-width / bidi overrides), private-use and unassigned code points.
const DISALLOWED_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u
const DISPLAY_NAME_RE = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} ._'-]*$/u

export function validateDisplayName(input: unknown): FieldResult {
  if (typeof input !== 'string') return { ok: false, message: 'Enter a display name.' }
  // NFKC folds look-alike forms; whitespace runs collapse so "a   b" can't impersonate "a b".
  const value = input.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  const length = [...value].length
  if (length < 1 || length > DISPLAY_NAME_MAX) {
    return { ok: false, message: `Display names are 1-${DISPLAY_NAME_MAX} characters.` }
  }
  if (DISALLOWED_CHARS.test(value) || !DISPLAY_NAME_RE.test(value)) {
    return { ok: false, message: "Use letters, numbers, spaces and . _ ' - only." }
  }
  return { ok: true, value }
}
