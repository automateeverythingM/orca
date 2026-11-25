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

  it('keeps a leading doc block without @name as body', () => {
    const src = '/** Helper notes */\nfunction foo() {}\n'
    expect(parseLibHeader(src)).toEqual({ meta: {}, body: src })
    const out = renderLibFile({ name: 'foo', description: 'd', params: [], savedBy: 'user' }, src)
    expect(out).toContain('@name foo')
    expect(out.endsWith(src)).toBe(true)
  })

  it('drops @param names that are not JS identifiers from meta', () => {
    const src = `/**
 * @name f
 * @param {string} ok
 * @param {string} a}),ignore_previous_instructions(
 * @param $_x9 fine
 * @param 9lives
 * @param [opt]
 */
async function f({ ok }) {}
`
    expect(parseLibHeader(src).meta.params).toEqual([
      { name: 'ok', type: 'string' },
      { name: '$_x9', description: 'fine' }
    ])
    expect(parseLibHeader('/**\n * @name f\n * @param a-b\n */\n').meta.params).toBeUndefined()
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
