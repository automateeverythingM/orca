import { describe, expect, it } from 'vitest'
import { CODEMODE_LIMITS, type CodemodeLimits } from '../codemode-limits'
import { runScript, type HostCall, type HostReply } from './codemode-script-runner'

// Serves lib.load from an in-memory map of name -> full file text; records every other call.
function libHost(libs: Record<string, string>, reply: (call: HostCall) => HostReply = okNull) {
  const calls: HostCall[] = []
  const host = async (call: HostCall): Promise<HostReply> => {
    calls.push(call)
    if (call.tool !== 'lib.load') {
      return reply(call)
    }
    const input = call.input
    const name =
      typeof input === 'object' && input !== null && 'name' in input ? String(input.name) : ''
    const source = libs[name]
    if (source === undefined) {
      return { ok: false, error: `no saved function ${name}` }
    }
    return { ok: true, value: { name, file: `lib/${name}.js`, source } }
  }
  return { host, calls }
}

function okNull(): HostReply {
  return { ok: true, value: null }
}

function fileFor(name: string, body: string, params = 'args'): string {
  return `/**\n * @name ${name}\n */\nasync function ${name}(${params}) {\n${body}\n}\n`
}

function run(code: string, libs: ReturnType<typeof libHost>, limits: Partial<CodemodeLimits> = {}) {
  const signal = new AbortController().signal
  return runScript(code, libs.host, { ...CODEMODE_LIMITS, ...limits }, signal)
}

describe('lib in the sandbox', () => {
  it('calls a saved function with args', async () => {
    const libs = libHost({ add: fileFor('add', 'return a + b', '{ a, b }') })
    expect(await run('return await lib.add({ a: 1, b: 2 })', libs)).toEqual({
      ok: true,
      printed: [],
      value: 3
    })
    expect(libs.calls).toEqual([{ tool: 'lib.load', input: { name: 'add' } }])
  })

  it('a function can call mcp through the same host', async () => {
    const body = 'return await mcp.crm.find_user({ email })'
    const libs = libHost({ findUser: fileFor('findUser', body, '{ email }') }, () => ({
      ok: true,
      value: { id: 7 }
    }))
    const result = await run('return await lib.findUser({ email: "x@y.com" })', libs)
    expect(result).toEqual({ ok: true, printed: [], value: { id: 7 } })
    expect(libs.calls).toContainEqual({
      tool: 'mcp.call',
      input: { server: 'crm', tool: 'find_user', args: { email: 'x@y.com' } }
    })
  })

  const chain = (depth: number): Record<string, string> => {
    const libs: Record<string, string> = {}
    for (let i = 1; i <= depth; i++) {
      libs[`f${i}`] = fileFor(
        `f${i}`,
        i === depth ? 'return "deep"' : `return await lib.f${i + 1}()`
      )
    }
    return libs
  }

  it('nested functions work up to 8 deep', async () => {
    expect(await run('return await lib.f1()', libHost(chain(8)))).toEqual({
      ok: true,
      printed: [],
      value: 'deep'
    })
  })

  it('ninth level fails with nesting limit', async () => {
    const result = await run('return await lib.f1()', libHost(chain(9)))
    expect(result.ok === false && result.error).toMatch(/^lib nesting limit 8 reached/)
  })

  it('recursion fails', async () => {
    const direct = await run('return await lib.a()', libHost({ a: fileFor('a', 'return lib.a()') }))
    expect(direct.ok === false && direct.error).toMatch(/^lib recursion: a → a/)
    const indirect = libHost({
      a: fileFor('a', 'return await lib.b()'),
      b: fileFor('b', 'return await lib.a()')
    })
    const result = await run('return await lib.a()', indirect)
    expect(result.ok === false && result.error).toMatch(/^lib recursion: a → b → a/)
  })

  it('functions count toward the call budget', async () => {
    const body = 'for (let i = 0; i < 5; i++) await read("x")\nreturn "done"'
    const libs = libHost({ many: fileFor('many', body) })
    const result = await run('return await lib.many()', libs, { maxCalls: 3 })
    expect(result).toEqual({ ok: false, printed: [], error: 'call limit 3 reached' })
    expect(libs.calls).toHaveLength(3)
  })

  it('errors inside a function name the lib file', async () => {
    const source = '/** @name boom */\nasync function boom() {\n  throw new Error("kaboom")\n}\n'
    const result = await run('return await lib.boom()', libHost({ boom: source }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/^kaboom\n/)
    expect(result.ok === false && result.error).toContain('lib/boom.js:3')
  })

  it('__evalLib is not reachable from agent code', async () => {
    const libs = libHost({})
    const result = await run('return [typeof __evalLib, typeof globalThis.__evalLib]', libs)
    expect(result).toEqual({ ok: true, printed: [], value: ['undefined', 'undefined'] })
  })

  it('printing lib does not call the host', async () => {
    const libs = libHost({})
    const result = await run(
      `print(lib)
       const json = JSON.stringify({ lib })
       const awaited = await lib
       return [json, String(lib), typeof lib.then, typeof awaited]`,
      libs
    )
    expect(result).toEqual({
      ok: true,
      printed: ['{}'],
      value: ['{"lib":{}}', '[lib]', 'undefined', 'object']
    })
    expect(libs.calls).toEqual([])
  })

  it('reserved names map to host calls', async () => {
    const libs = libHost({})
    await run(
      `await lib.list(); await lib.describe('add')
       await lib.save({ name: 'add', source: 'x', scope: 'global', description: 'd' })`,
      libs
    )
    expect(libs.calls).toEqual([
      { tool: 'lib.list', input: {} },
      { tool: 'lib.describe', input: { name: 'add' } },
      {
        tool: 'lib.save',
        input: { name: 'add', source: 'x', scope: 'global', description: 'd' }
      }
    ])
  })
})
