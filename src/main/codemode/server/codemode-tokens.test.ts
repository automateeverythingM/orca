import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { CodemodeTokens } from './codemode-tokens'

describe('CodemodeTokens', () => {
  it('resolves an issued token to its session until revoked', () => {
    const tokens = new CodemodeTokens()
    const a = tokens.issue('session-a')
    const b = tokens.issue('session-b')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
    expect(tokens.resolve(a)).toBe('session-a')
    expect(tokens.resolve(b)).toBe('session-b')
    tokens.revoke('session-a')
    expect(tokens.resolve(a)).toBeNull()
    expect(tokens.resolve(b)).toBe('session-b')
  })

  it('rejects wrong, empty and replaced tokens', () => {
    const tokens = new CodemodeTokens()
    const first = tokens.issue('session-a')
    expect(tokens.resolve('0'.repeat(64))).toBeNull()
    expect(tokens.resolve('')).toBeNull()
    expect(tokens.resolve(`${first}x`)).toBeNull()
    const second = tokens.issue('session-a')
    expect(tokens.resolve(first)).toBeNull()
    expect(tokens.resolve(second)).toBe('session-a')
  })

  it('never keeps the raw token', () => {
    const tokens = new CodemodeTokens()
    const token = tokens.issue('session-a')
    const dump = inspect(tokens, { depth: 10, showHidden: true, maxArrayLength: null })
    expect(dump).not.toContain(token)
  })
})
