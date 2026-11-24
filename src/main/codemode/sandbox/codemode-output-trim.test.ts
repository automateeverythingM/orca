import { describe, expect, it } from 'vitest'
import { formatScriptResult, trimOutput } from './codemode-output-trim'

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

describe('trimOutput', () => {
  it('keeps text under the limit unchanged', () => {
    expect(trimOutput('hello', 5)).toBe('hello')
  })

  it('keeps head and tail with a cut marker', () => {
    const text = `HEAD${'m'.repeat(1000)}TAIL`
    const out = trimOutput(text, 100)
    const marker = out.match(/\n…\[(\d+) bytes cut\]…\n/)
    expect(marker).not.toBeNull()
    expect(bytes(out)).toBeLessThanOrEqual(100 + bytes(marker![0]))
    expect(out.startsWith('HEAD')).toBe(true)
    expect(out.endsWith('TAIL')).toBe(true)
    expect(Number(marker![1])).toBe(bytes(text) - (bytes(out) - bytes(marker![0])))
  })

  it('never splits a multi-byte character', () => {
    const text = '€'.repeat(100)
    for (const max of [10, 11, 12, 13, 50]) {
      const out = trimOutput(text, max)
      expect(out).not.toContain('�')
      const [head, tail] = out.split(/\n…\[\d+ bytes cut\]…\n/)
      expect(head).toMatch(/^€*$/)
      expect(tail).toMatch(/^€*$/)
      expect(bytes(head) + bytes(tail)).toBeLessThanOrEqual(max)
    }
  })
})

describe('formatScriptResult', () => {
  it('prints lines then the JSON value', () => {
    expect(formatScriptResult({ ok: true, printed: ['a', 'b'], value: { n: 1 } }, 1000)).toEqual({
      text: 'a\nb\n=> {"n":1}',
      isError: false
    })
  })

  it('formats errors', () => {
    expect(formatScriptResult({ ok: false, printed: ['a'], error: 'boom' }, 1000)).toEqual({
      text: 'a\nError: boom',
      isError: true
    })
  })
})
