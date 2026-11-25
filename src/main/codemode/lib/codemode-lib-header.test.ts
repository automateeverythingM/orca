import { describe, expect, it } from 'vitest'
import { definesFunction, libSignature, parseLibHeader, renderLibFile } from './codemode-lib-header'

const SRC = `/**
 * @name addCredits
 * @description Add credits by email.
 * @param {string} email The user email
 * @param {number} amount
 * @saved-by agent
 */
async function addCredits({ email, amount }) { return 1 }
`

describe('codemode lib header', () => {
  it('parses name, description, params and saved-by', () => {
    const { meta, body } = parseLibHeader(SRC)
    expect(meta).toEqual({
      name: 'addCredits',
      description: 'Add credits by email.',
      params: [
        { name: 'email', type: 'string', description: 'The user email' },
        { name: 'amount', type: 'number' }
      ],
      savedBy: 'agent'
    })
    expect(body).toBe('async function addCredits({ email, amount }) { return 1 }\n')
  })

  it('renderLibFile replaces an existing header and keeps the body', () => {
    const out = renderLibFile(
      { name: 'addCredits', description: 'New', params: [{ name: 'x' }], savedBy: 'user' },
      SRC
    )
    expect(out.startsWith('/**\n * @name addCredits\n * @description New\n * @param x\n')).toBe(
      true
    )
    expect(out).toContain('@saved-by user')
    expect(out).not.toContain('Add credits by email.')
    expect(out.endsWith('async function addCredits({ email, amount }) { return 1 }\n')).toBe(true)
    expect(out.match(/\/\*\*/g)).toHaveLength(1)
  })

  it('libSignature renders params as an object pattern', () => {
    expect(libSignature({ name: 'f', params: [{ name: 'a' }, { name: 'b' }] })).toBe('f({a, b})')
    expect(libSignature({ name: 'f', params: [] })).toBe('f()')
  })

  it('definesFunction finds async and plain declarations only for that name', () => {
    expect(definesFunction('async function foo ({a}) {}', 'foo')).toBe(true)
    expect(definesFunction('function foo() {}', 'foo')).toBe(true)
    expect(definesFunction('function foobar() {}', 'foo')).toBe(false)
    expect(definesFunction('const foo = () => {}', 'foo')).toBe(false)
    expect(definesFunction('function $x() {}', '$x')).toBe(true)
  })
})
