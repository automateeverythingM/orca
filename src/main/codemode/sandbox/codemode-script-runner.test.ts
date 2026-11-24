import { describe, expect, it } from 'vitest'
import { CODEMODE_LIMITS, type CodemodeLimits } from '../codemode-limits'
import { runScript, type HostCall, type HostReply, type ScriptHost } from './codemode-script-runner'

const MB = 1024 * 1024

function stubHost(reply: (call: HostCall) => HostReply | Promise<HostReply>): {
  host: ScriptHost
  calls: HostCall[]
} {
  const calls: HostCall[] = []
  return {
    calls,
    host: async (call) => {
      calls.push(call)
      return reply(call)
    }
  }
}

function run(
  code: string,
  host: ScriptHost = stubHost(() => ({ ok: true, value: null })).host,
  limits: Partial<CodemodeLimits> = {},
  signal: AbortSignal = new AbortController().signal
) {
  return runScript(code, host, { ...CODEMODE_LIMITS, ...limits }, signal)
}

describe('runScript', () => {
  it('returns value and printed lines', async () => {
    expect(await run('print("a"); return 1+1')).toEqual({ ok: true, printed: ['a'], value: 2 })
  })

  it('host calls look synchronous and await works', async () => {
    const { host, calls } = stubHost(() => ({ ok: true, value: { n: 3 } }))
    const result = await run('const r = await mcp.crm.find_user({id:1}); return r.n', host)
    expect(result).toEqual({ ok: true, printed: [], value: 3 })
    expect(calls).toEqual([
      { tool: 'mcp.call', input: { server: 'crm', tool: 'find_user', args: { id: 1 } } }
    ])
  })

  it('runs sequential host calls after an await', async () => {
    let n = 0
    const { host } = stubHost(() => ({ ok: true, value: ++n }))
    const result = await run(
      'const a = await read("a"); const b = await read("b"); return a + b',
      host
    )
    expect(result).toEqual({ ok: true, printed: [], value: 3 })
  })

  it('host error throws inside the script', async () => {
    const { host } = stubHost(() => ({ ok: false, error: 'nope' }))
    const result = await run('try { await read("x") } catch (e) { return e.message }', host)
    expect(result).toEqual({ ok: true, printed: [], value: 'nope' })
  })

  it('bash does not throw', async () => {
    const { host } = stubHost(() => ({ ok: true, value: { exit_code: 1, output: 'x' } }))
    const result = await run('return (await bash("false")).exit_code', host)
    expect(result).toEqual({ ok: true, printed: [], value: 1 })
  })

  it('infinite loop stops', async () => {
    const result = await run('while(true){}', undefined, { jsTimeMs: 200 })
    expect(result).toEqual({ ok: false, printed: [], error: 'script exceeded 0.2s JS time' })
    expect(result.ok === false && result.error).toMatch(/exceeded .*s JS time/)
  })

  it('host time does not count', async () => {
    const { host } = stubHost(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return { ok: true, value: 1 }
    })
    const result = await run('return (await read("a")) + (await read("b"))', host, {
      jsTimeMs: 200
    })
    expect(result).toEqual({ ok: true, printed: [], value: 2 })
  })

  it('call limit', async () => {
    const { host, calls } = stubHost(() => ({ ok: true, value: 1 }))
    const code = 'for (let i = 0; i < 3; i++) { try { await read("x") } catch {} }; return "done"'
    const result = await run(code, host, { maxCalls: 2 })
    expect(result).toEqual({ ok: false, printed: [], error: 'call limit 2 reached' })
    expect(calls).toHaveLength(2)
  })

  it('memory limit', async () => {
    const result = await run('return "x".repeat(50 * 1024 * 1024).length', undefined, {
      memoryBytes: 8 * MB
    })
    expect(result).toEqual({ ok: false, printed: [], error: 'memory limit 8MB' })
  })

  it('deep recursion fails the script instead of the host', async () => {
    const result = await run('function f() { return f() + 1 }; return f()')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/stack overflow/)
  })

  it('reserved names', async () => {
    const { host, calls } = stubHost(() => ({ ok: true, value: [] }))
    await run(
      'await mcp.list(); await mcp.describe("x"); await mcp.call("list", "t", {a: 1})',
      host
    )
    expect(calls).toEqual([
      { tool: 'mcp.list', input: {} },
      { tool: 'mcp.describe', input: { server: 'x' } },
      { tool: 'mcp.call', input: { server: 'list', tool: 't', args: { a: 1 } } }
    ])
  })

  it('abort', async () => {
    const controller = new AbortController()
    const { host } = stubHost(() => {
      controller.abort()
      return { ok: true, value: 1 }
    })
    const code = 'let first = true; while (true) { if (first) { first = false; await read("x") } }'
    const result = await run(code, host, {}, controller.signal)
    expect(result).toEqual({ ok: false, printed: [], error: 'Interrupted by user' })
  })

  it('abort while a host call is pending', async () => {
    const controller = new AbortController()
    const host: ScriptHost = () => {
      setTimeout(() => controller.abort(), 20)
      return new Promise<HostReply>(() => {})
    }
    const result = await run('print("before"); await read("x")', host, {}, controller.signal)
    expect(result).toEqual({ ok: false, printed: ['before'], error: 'Interrupted by user' })
  })

  it('unsettled promise', async () => {
    const result = await run('await new Promise(() => {})')
    expect(result).toEqual({
      ok: false,
      printed: [],
      error: 'script ended with an unsettled promise'
    })
  })

  it('oversize tool result throws inside the script', async () => {
    const { host } = stubHost(() => ({ ok: true, value: 'x'.repeat(70 * 1024) }))
    const result = await run('try { await read("x") } catch (e) { return e.message }', host, {
      resultBytes: 64 * 1024
    })
    expect(result).toEqual({ ok: true, printed: [], value: 'tool result exceeds 64KB' })
  })

  it('error line numbers', async () => {
    const result = await run('const a = 1\nnull.x')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('line 2')
  })

  it('syntax error line numbers', async () => {
    const result = await run('const a = 1\nlet let = 2')
    expect(result.ok === false && result.error).toMatch(/^SyntaxError: .*\n.*line 2/)
  })
})
