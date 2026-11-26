import { describe, expect, it } from 'vitest'
import type {
  CodemodeLearnCall,
  CodemodeLearnRun
} from '../../../../shared/codemode/codemode-learn-types'
import { canonicalJson, replayHost } from './codemode-learn-replay-host'

const recorded = (
  seq: number,
  tool: string,
  input: unknown,
  output: unknown,
  extra: Partial<CodemodeLearnCall> = {}
): CodemodeLearnCall => ({ seq, tool, input, ok: true, output, ms: 1, ...extra })

const run = (calls: CodemodeLearnCall[], runId = 'r1'): CodemodeLearnRun => ({
  runId,
  sessionId: 's1',
  projectRoot: '/p',
  startedAt: 0,
  ms: 5,
  ok: true,
  code: 'return 1',
  calls
})

const mcpCall = (server: string, tool: string, args: unknown) => ({
  tool: 'mcp.call',
  input: { server, tool, args }
})

describe('canonicalJson', () => {
  it('sorts keys at every depth and treats undefined as null', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: 3 } })).toBe(
      '{"a":{"c":3,"d":[{"x":2,"y":1}]},"b":1}'
    )
    expect(canonicalJson(undefined)).toBe('null')
  })

  it('keeps a __proto__ key as data', () => {
    const value: unknown = JSON.parse('{"__proto__":{"x":1},"a":1}')
    expect(canonicalJson(value)).toBe('{"__proto__":{"x":1},"a":1}')
  })
})

describe('replayHost', () => {
  it('answers a call from a recording whatever its key order, and reuses it', async () => {
    const { host, unrecorded, failures, lines } = replayHost([
      run([recorded(1, 'mcp.crm.search', { b: 1, a: 2 }, { id: 7 })])
    ])
    const first = await host(mcpCall('crm', 'search', { a: 2, b: 1 }))
    const again = await host(mcpCall('crm', 'search', { a: 2, b: 1 }))
    expect(first).toEqual({ ok: true, value: { id: 7 } })
    expect(again).toEqual({ ok: true, value: { id: 7 } })
    expect(unrecorded).toEqual([])
    expect(failures).toEqual([])
    expect(lines).toEqual(['✓ mcp.crm.search', '✓ mcp.crm.search'])
  })

  it('fails a call with no recording', async () => {
    const { host, unrecorded, failures, lines } = replayHost([
      run([recorded(1, 'mcp.crm.search', { a: 2 }, { id: 7 })])
    ])
    const reply = await host(mcpCall('crm', 'search', { a: 3 }))
    expect(reply).toEqual({ ok: false, error: 'unrecorded call: mcp.crm.search' })
    expect(unrecorded).toEqual(['mcp.crm.search'])
    expect(failures).toEqual(['unrecorded call: mcp.crm.search'])
    expect(lines).toEqual(['✗ unrecorded call: mcp.crm.search'])
  })

  it('never matches a cut recording, but uses an uncut twin', async () => {
    const cut = replayHost([
      run([
        recorded(1, 'read', { path: 'a' }, 'partial', { outputTruncated: true }),
        recorded(2, 'read', '{"path":"b"', 'x', { inputTruncated: true }),
        recorded(3, 'read', null, undefined, { inputTruncated: true, outputTruncated: true })
      ])
    ])
    expect(await cut.host({ tool: 'read', input: { path: 'a' } })).toMatchObject({ ok: false })
    expect(await cut.host({ tool: 'read', input: { path: 'b' } })).toMatchObject({ ok: false })
    expect(cut.unrecorded).toEqual(['read', 'read'])

    const twin = replayHost([
      run([recorded(1, 'read', { path: 'a' }, 'partial', { outputTruncated: true })]),
      run([recorded(1, 'read', { path: 'a' }, 'whole')], 'r2')
    ])
    expect(await twin.host({ tool: 'read', input: { path: 'a' } })).toEqual({
      ok: true,
      value: 'whole'
    })
  })

  it('replays a recorded failure as the same error', async () => {
    const { host, failures } = replayHost([
      run([{ seq: 1, tool: 'orca.worktree.list', input: null, ok: false, error: 'no repo', ms: 1 }])
    ])
    const reply = await host({ tool: 'orca.call', input: { method: 'worktree.list' } })
    expect(reply).toEqual({ ok: false, error: 'no repo' })
    expect(failures).toEqual([])
  })

  it('refuses lib calls', async () => {
    const { host, unrecorded, failures, lines } = replayHost([
      run([recorded(1, 'lib.other', { name: 'other' }, { source: 'x' })])
    ])
    expect(await host({ tool: 'lib.load', input: { name: 'other' } })).toEqual({
      ok: false,
      error: 'lib calls are not replayed'
    })
    expect(await host({ tool: 'lib.list', input: {} })).toMatchObject({ ok: false })
    expect(unrecorded).toEqual([])
    expect(failures).toEqual(['lib calls are not replayed', 'lib calls are not replayed'])
    expect(lines).toEqual([
      '✗ lib calls are not replayed: lib.other',
      '✗ lib calls are not replayed: lib.list'
    ])
  })
})
