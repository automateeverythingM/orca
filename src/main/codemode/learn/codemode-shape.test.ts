import { describe, expect, it } from 'vitest'
import { codemodeShapeHash, codemodeShapeTokens } from './codemode-shape'

describe('codemode shape fingerprint', () => {
  it('same shape for different literals', () => {
    const a = "const r = await mcp.crm.find({ email: 'a@x.com', n: 5, t: `hi ${name} there` })"
    const b = 'const r = await mcp.crm.find({ email: "b@y.org", n: 42.5, t: `bye ${name} now` })'
    expect(codemodeShapeHash(a)).toBe(codemodeShapeHash(b))
    expect(codemodeShapeTokens(a)).toContain('_')
  })

  it('whitespace and comments do not matter', () => {
    const a = 'const x = 1 // note\n/* block */ foo(x)'
    const b = 'const   x=2;foo( x )'
    expect(codemodeShapeTokens(a).filter((t) => t !== ';')).toEqual(
      codemodeShapeTokens(b).filter((t) => t !== ';')
    )
    expect(codemodeShapeTokens('a // c\n/* d */ b')).toEqual(['a', 'b'])
  })

  it('bracket member keys are kept', () => {
    const a = "mcp['fake-crm'].x()"
    const b = "mcp['crm'].x()"
    expect(codemodeShapeHash(a)).not.toBe(codemodeShapeHash(b))
    expect(codemodeShapeTokens(a)).toContain("'fake-crm'")
    expect(codemodeShapeHash(a)).toBe(codemodeShapeHash("mcp['fake-crm'].x()"))
  })

  it('array literal strings are not kept', () => {
    expect(codemodeShapeTokens("x = ['a']")).toEqual(['x', '=', '[', '_', ']'])
  })

  it('computed key that is not a string literal is a token', () => {
    expect(codemodeShapeTokens('mcp[name].x()')).toEqual([
      'mcp',
      '[',
      'name',
      ']',
      '.',
      'x',
      '(',
      ')'
    ])
  })

  it('regex vs divide', () => {
    expect(codemodeShapeTokens('a / b / c')).toEqual(['a', '/', 'b', '/', 'c'])
    expect(codemodeShapeTokens("x.replace(/a\\/b/g, '')")).toEqual([
      'x',
      '.',
      'replace',
      '(',
      '_',
      ',',
      '_',
      ')'
    ])
    expect(codemodeShapeTokens('return /[/]x/.test(s)')).toEqual([
      'return',
      '_',
      '.',
      'test',
      '(',
      's',
      ')'
    ])
  })

  it('template with nested braces', () => {
    expect(codemodeShapeTokens('`a${ {k:1}.k }b` + z')).toEqual([
      '_',
      '${',
      '{',
      'k',
      ':',
      '_',
      '}',
      '.',
      'k',
      '}',
      '+',
      'z'
    ])
  })

  it('unterminated input does not throw', () => {
    for (const src of ["'abc", '`abc ${x', '/* open', '// x', 'a = /re', '"a\\']) {
      expect(() => codemodeShapeTokens(src)).not.toThrow()
    }
    expect(codemodeShapeHash('')).toMatch(/^[0-9a-f]{64}$/)
  })
})
