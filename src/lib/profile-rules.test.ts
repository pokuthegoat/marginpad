import { describe, expect, it } from 'vitest'
import { DISPLAY_NAME_MAX, USERNAME_MAX, validateDisplayName, validateUsername } from './profile-rules'
import { normalizeWallet } from './wallet'
import { avatarUrl } from './avatar'

describe('validateUsername', () => {
  it('accepts normal names and trims them', () => {
    expect(validateUsername('Alice')).toEqual({ ok: true, value: 'Alice' })
    expect(validateUsername('  bob_99 ')).toEqual({ ok: true, value: 'bob_99' })
    expect(validateUsername('a'.repeat(USERNAME_MAX))).toMatchObject({ ok: true })
  })

  it('rejects the wrong length, characters and shapes', () => {
    for (const bad of ['', 'ab', 'a'.repeat(USERNAME_MAX + 1), 'has space', 'dash-name', '_start', 'end_', 'café', 'x😀y', 5, {}, undefined]) {
      expect(validateUsername(bad), String(bad)).toMatchObject({ ok: false })
    }
  })

  it('reserves names that could pass for the team, in any case', () => {
    for (const bad of ['admin', 'ADMIN', 'Support', 'marginpad', 'MarginPad', 'privy', 'wallet', 'root']) {
      expect(validateUsername(bad), bad).toEqual({ ok: false, message: 'That username is reserved.' })
    }
  })
})

describe('validateDisplayName', () => {
  it('accepts letters from any language, numbers and simple punctuation', () => {
    for (const good of ['Alice', 'José Núñez', '李小龍', "O'Brien-Smith", 'A.B. 7']) {
      expect(validateDisplayName(good), good).toMatchObject({ ok: true })
    }
  })

  it('collapses runs of whitespace so look-alike names cannot be forged', () => {
    expect(validateDisplayName('a    b')).toEqual({ ok: true, value: 'a b' })
  })

  it('rejects empty, too long, hidden characters and markup', () => {
    for (const bad of ['', '   ', 'x'.repeat(DISPLAY_NAME_MAX + 1), 'zero​width', 'rtl‮override', '<b>hi</b>', '-leading', 'emoji😀', 5, null]) {
      expect(validateDisplayName(bad), String(bad)).toMatchObject({ ok: false })
    }
  })
})

describe('wallet and avatar helpers', () => {
  it('lowercases EVM addresses but leaves other chains alone', () => {
    expect(normalizeWallet('0xAbCdEf0123456789aBcDeF0123456789AbCdEf01')).toBe('0xabcdef0123456789abcdef0123456789abcdef01')
    expect(normalizeWallet('  0x' + 'A'.repeat(40) + ' ')).toBe('0x' + 'a'.repeat(40))
    expect(normalizeWallet('So11111111111111111111111111111111111111112')).toBe('So11111111111111111111111111111111111111112')
  })

  it('builds a cache-busted avatar URL only when a picture exists', () => {
    expect(avatarUrl('Alice', 0)).toBeNull()
    expect(avatarUrl('Alice', 3)).toBe('/api/avatar/Alice?v=3')
    expect(avatarUrl('a b', 1)).toBe('/api/avatar/a%20b?v=1')
  })
})
