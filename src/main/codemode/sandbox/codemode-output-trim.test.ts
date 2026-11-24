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

  it('lists the inner calls after the result, one line each', () => {
    const calls = [
      { tool: 'mcp.fcu.add_credits', ok: true, ms: 120 },
      { tool: 'bash', ok: false, ms: 3 }
    ]
    expect(formatScriptResult({ ok: true, printed: [], value: 1 }, 1000, calls).text).toBe(
      '=> 1\nInner calls:\nmcp.fcu.add_credits ✓ 120ms\nbash ✗ 3ms'
    )
  })

  it('keeps output and the calls list within the budget together', () => {
    const calls = Array.from({ length: 500 }, (_, i) => ({ tool: `mcp.s.t${i}`, ok: true, ms: i }))
    const { text } = formatScriptResult(
      { ok: true, printed: ['x'.repeat(50_000)], value: 'end' },
      30_000,
      calls
    )
    const markers = [...text.matchAll(/\n…\[\d+ bytes cut\]…\n/g)].map(([marker]) => marker)
    const markerBytes = markers.reduce((sum, marker) => sum + bytes(marker), 0)
    expect(bytes(text)).toBeLessThanOrEqual(30_000 + markerBytes)
    expect(text).toContain('\n=> "end"\nInner calls:\nmcp.s.t0 ✓ 0ms')
    expect(text.endsWith('mcp.s.t499 ✓ 499ms')).toBe(true)
  })

  it('formats errors', () => {
    expect(formatScriptResult({ ok: false, printed: ['a'], error: 'boom' }, 1000)).toEqual({
      text: 'a\nError: boom',
      isError: true
    })
  })
})
