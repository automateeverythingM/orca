import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODEMODE_LIMITS, type CodemodeLimits } from '../codemode-limits'
import type { GateMode } from '../gate/codemode-gate'
import type { CodemodeServerSpec } from '../mcp-pool/codemode-mcp-pool'
import { fakeCrmServerSpec } from '../mcp-pool/testing/fake-crm-command'
import {
  type ApprovalDecision,
  type ApprovalRequest,
  type CodemodeRunEvent,
  CodemodeSession,
  type InnerCallEvent
} from './codemode-run-host'

const UNSUPPORTED =
  'approval needed but this agent cannot show approval cards; switch the chat to full access or call the tool directly'

let bundleRoot: string
let workerPath: string
let crmSpec: CodemodeServerSpec

beforeAll(async () => {
  const cacheRoot = resolve('node_modules/.cache')
  mkdirSync(cacheRoot, { recursive: true })
  bundleRoot = mkdtempSync(join(cacheRoot, 'orca-codemode-run-host-'))
  workerPath = join(bundleRoot, 'codemode-worker-entry.js')
  await build({
    entryPoints: [resolve('src/main/codemode/sandbox/codemode-worker-entry.ts')],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync'],
    logLevel: 'silent'
  })
  crmSpec = { name: 'fake-crm', ...(await fakeCrmServerSpec()), source: 'orca' }
}, 30_000)
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

let base: string
let root: string
const sessions: CodemodeSession[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'codemode-run-host-')))
  root = join(base, 'root')
  await mkdir(root)
})
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  await rm(base, { recursive: true, force: true })
})

type Harness = {
  session: CodemodeSession
  events: InnerCallEvent[]
  runs: CodemodeRunEvent[]
  requests: ApprovalRequest[]
  run: (code: string, signal?: AbortSignal) => Promise<{ text: string; isError: boolean }>
}

function makeSession(opts: {
  mode: () => GateMode
  answer?: (request: ApprovalRequest) => Promise<ApprovalDecision>
  trusted?: boolean
  limits?: CodemodeLimits
  onEvent?: (event: InnerCallEvent) => void
}): Harness {
  const events: InnerCallEvent[] = []
  const runs: CodemodeRunEvent[] = []
  const requests: ApprovalRequest[] = []
  const session = new CodemodeSession({
    sessionId: 's1',
    root,
    env: process.env,
    mode: opts.mode,
    trusted: () => opts.trusted ?? false,
    specs: [crmSpec],
    limits: opts.limits ?? CODEMODE_LIMITS,
    onEvent: (event) => {
      events.push(event)
      opts.onEvent?.(event)
    },
    onRun: (event) => runs.push(event),
    workerPath
  })
  sessions.push(session)
  const approver = (request: ApprovalRequest): Promise<ApprovalDecision> => {
    requests.push(request)
    return opts.answer ? opts.answer(request) : Promise.resolve('allow_once')
  }
  return {
    session,
    events,
    runs,
    requests,
    run: (code, signal = new AbortController().signal) => session.run(code, { signal, approver })
  }
}

const crm = (tool: string, args: string) => `mcp['fake-crm'].${tool}(${args})`
const creditsScript = `return JSON.parse(await ${crm('get_state', '')})[0].credits`

describe('CodemodeSession', () => {
  it('runs a multi-step script in full access without asking and reports each call', async () => {
    const h = makeSession({ mode: () => 'full-access' })
    const result = await h.run(`
      const user = JSON.parse(await ${crm('find_user', "{ email: 'x@y.com' }")})
      await ${crm('update_user', "{ user_id: user.id, name: 'Y' }")}
      await ${crm('add_to_group', "{ user_id: user.id, group: 'g' }")}
      return JSON.parse(await ${crm('add_credits', '{ user_id: user.id, amount: 5 }')})`)
    expect(result).toEqual({
      text: '=> {"id":"u1","email":"x@y.com","name":"Y","groups":["g"],"credits":5}',
      isError: false
    })
    expect(h.requests).toEqual([])
    expect(h.events.map((e) => [e.seq, e.state, e.tool])).toEqual([
      [1, 'running', 'mcp.fake-crm.find_user'],
      [1, 'ok', 'mcp.fake-crm.find_user'],
      [2, 'running', 'mcp.fake-crm.update_user'],
      [2, 'ok', 'mcp.fake-crm.update_user'],
      [3, 'running', 'mcp.fake-crm.add_to_group'],
      [3, 'ok', 'mcp.fake-crm.add_to_group'],
      [4, 'running', 'mcp.fake-crm.add_credits'],
      [4, 'ok', 'mcp.fake-crm.add_credits']
    ])
    expect(new Set(h.events.map((e) => e.runId)).size).toBe(1)
    expect(h.events[1]).toMatchObject({ input: { email: 'x@y.com' }, ms: expect.any(Number) })
    expect(h.events[1].output).toContain('"id":"u1"')
  })

  it("reports a run's start and end under the run id its inner calls carry", async () => {
    const h = makeSession({ mode: () => 'full-access' })
    await h.run(creditsScript)
    await h.run('throw new Error("boom")')
    expect(h.runs.map((e) => [e.code, e.state])).toEqual([
      [creditsScript, 'running'],
      [creditsScript, 'ok'],
      ['throw new Error("boom")', 'running'],
      ['throw new Error("boom")', 'error']
    ])
    expect(h.runs[0].runId).toBe(h.events[0].runId)
    expect(h.runs[1].ms).toEqual(expect.any(Number))
  })

  it('asks once for an untrusted call in ask mode and leaves state unchanged on deny', async () => {
    let mode: GateMode = 'ask'
    const h = makeSession({ mode: () => mode, answer: async () => 'deny' })
    const denied = await h.run(`
      try { await ${crm('add_credits', "{ user_id: 'u1', amount: 5 }")} } catch (e) { return e.message }`)
    expect(denied).toEqual({
      text: '=> "mcp.fake-crm.add_credits: denied by user"',
      isError: false
    })
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]).toMatchObject({ personOnly: false })
    expect(h.requests[0].title).toContain('add_credits')
    expect(h.events.at(-1)).toMatchObject({
      state: 'error',
      output: 'mcp.fake-crm.add_credits: denied by user'
    })
    mode = 'full-access'
    expect(await h.run(creditsScript)).toEqual({ text: '=> 0', isError: false })
  })

  it('remembers allow_session for the same tool across calls and runs', async () => {
    const h = makeSession({ mode: () => 'ask', answer: async () => 'allow_session' })
    const add = `await ${crm('add_credits', "{ user_id: 'u1', amount: 1 }")}`
    expect(await h.run(`${add}; ${add}; return 'ok'`)).toEqual({ text: '=> "ok"', isError: false })
    expect(await h.run(`${add}; return 'ok'`)).toEqual({ text: '=> "ok"', isError: false })
    const callAsks = h.requests.filter((r) => !r.personOnly)
    expect(callAsks).toHaveLength(1)
    expect(callAsks[0].title).toContain('add_credits')
  })

  it('reads the mode again for every call', async () => {
    let mode: GateMode = 'full-access'
    const h = makeSession({
      mode: () => mode,
      onEvent: (event) => {
        if (event.state === 'ok') {
          mode = 'read-only'
        }
      }
    })
    const result = await h.run(`
      await write({ path: 'a.txt', content: '1' })
      try { await write({ path: 'b.txt', content: '2' }) } catch (e) { return e.message }`)
    expect(result).toEqual({ text: '=> "not allowed in this chat mode"', isError: false })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('1')
    expect(existsSync(join(root, 'b.txt'))).toBe(false)
  })

  it('refuses with a clear text when the agent cannot show approval cards', async () => {
    const h = makeSession({ mode: () => 'ask', answer: async () => 'unsupported' })
    const result = await h.run(`await write({ path: 'a.txt', content: 'x' })`)
    expect(result).toEqual({ text: `Error: ${UNSUPPORTED}`, isError: true })
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
  })

  it('asks the person before the first start of a local server in ask mode', async () => {
    const h = makeSession({ mode: () => 'ask', trusted: true })
    const result = await h.run(`return (await mcp.describe('fake-crm')).length > 0`)
    expect(result).toEqual({ text: '=> true', isError: false })
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]).toMatchObject({ personOnly: true })
    expect(h.requests[0].title).toContain('fake-crm')
  })

  it('does not ask again for a refused server start within one run', async () => {
    const h = makeSession({ mode: () => 'ask', answer: async () => 'deny' })
    const retry = `
      const out = []
      for (let i = 0; i < 3; i++) {
        try { await mcp.describe('fake-crm') } catch (e) { out.push(e.message) }
      }
      return out`
    expect(await h.run(retry)).toEqual({
      text: '=> ["mcp.describe: denied by user","mcp.describe: denied by user","mcp.describe: denied by user"]',
      isError: false
    })
    expect(h.requests).toHaveLength(1)
    await h.run(retry)
    expect(h.requests).toHaveLength(2)
  })

  it('gives concurrent runs their own run id and call budget', async () => {
    await writeFile(join(root, 'a.txt'), 'A')
    const h = makeSession({
      mode: () => 'full-access',
      limits: { ...CODEMODE_LIMITS, maxCalls: 3 }
    })
    const script = `return (await read('a.txt')) + (await read('a.txt')) + (await read('a.txt'))`
    const results = await Promise.all([h.run(script), h.run(script)])
    expect(results).toEqual([
      { text: '=> "AAA"', isError: false },
      { text: '=> "AAA"', isError: false }
    ])
    const runIds = [...new Set(h.events.map((e) => e.runId))]
    expect(runIds).toHaveLength(2)
    for (const runId of runIds) {
      const seqs = h.events.filter((e) => e.runId === runId && e.state === 'ok').map((e) => e.seq)
      expect(seqs).toEqual([1, 2, 3])
    }
  })

  it('stops promptly while an approval is pending and aborts that approval', async () => {
    let asked: () => void = () => {}
    const pendingAsk = new Promise<void>((resolveAsk) => {
      asked = resolveAsk
    })
    const h = makeSession({
      mode: () => 'ask',
      answer: () => {
        asked()
        return new Promise<ApprovalDecision>(() => {})
      }
    })
    const controller = new AbortController()
    let settled = false
    const running = h
      .run(`await write({ path: 'a.txt', content: 'x' })`, controller.signal)
      .finally(() => {
        settled = true
      })
    await pendingAsk
    controller.abort()
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000 })
    const result = await running
    expect(result).toEqual({ text: 'Error: Interrupted by user', isError: true })
    expect(h.requests[0].signal.aborted).toBe(true)
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
  })

  it('returns structured MCP content to the script as an object', async () => {
    const h = makeSession({ mode: () => 'full-access' })
    const result = await h.run(`
      const user = await ${crm('structured_user', "{ email: 'x@y.com' }")}
      return [typeof user, user.id, user.credits]`)
    expect(result).toEqual({ text: '=> ["object","u1",0]', isError: false })
  })

  it.skipIf(process.platform === 'win32')('reads the bash timeout in seconds', async () => {
    const h = makeSession({ mode: () => 'full-access' })
    let settled = false
    const running = h.run(`return await bash('sleep 5', { timeout: 0.3 })`).finally(() => {
      settled = true
    })
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 4_000 })
    const result = await running
    expect(result.text).toContain('"exit_code":124')
    expect(result.text).toContain('[timed out after 0.3s]')
  })

  describe('paths outside the workspace', () => {
    const writeOutside = `
      try { return await write({ path: '../outside.txt', content: 'hi' }) } catch (e) { return e.message }`

    it('writes outside only after the approver allows it', async () => {
      const h = makeSession({ mode: () => 'auto' })
      expect(await h.run(`await write({ path: 'in.txt', content: 'x' }); return 1`)).toEqual({
        text: '=> 1',
        isError: false
      })
      expect(h.requests).toEqual([])
      expect(await h.run(writeOutside)).toEqual({
        text: '=> "wrote ../outside.txt"',
        isError: false
      })
      expect(h.requests).toHaveLength(1)
      expect(await readFile(join(base, 'outside.txt'), 'utf8')).toBe('hi')
    })

    it('refuses an outside write the approver denies', async () => {
      const h = makeSession({ mode: () => 'auto', answer: async () => 'deny' })
      expect(await h.run(writeOutside)).toEqual({
        text: '=> "write: denied by user"',
        isError: false
      })
      expect(existsSync(join(base, 'outside.txt'))).toBe(false)
    })

    it('asks before reading outside in auto and reads on allow_once', async () => {
      await writeFile(join(base, 'secret.txt'), 's3cret')
      const h = makeSession({ mode: () => 'auto' })
      expect(await h.run(`return await read('../secret.txt')`)).toEqual({
        text: '=> "s3cret"',
        isError: false
      })
      expect(h.requests).toHaveLength(1)
      expect(h.requests[0].title).toContain(join(base, 'secret.txt'))
    })

    it.each(['ask', 'read-only'] as const)(
      'refuses outside reads and searches in %s mode without asking',
      async (mode) => {
        await writeFile(join(base, 'secret.txt'), 's3cret')
        const h = makeSession({ mode: () => mode })
        const result = await h.run(`
          const out = []
          for (const attempt of [() => read('../secret.txt'), () => find({ pattern: '*', path: '..' })]) {
            try { await attempt() } catch (e) { out.push(e.message) }
          }
          return out`)
        expect(result).toEqual({
          text: '=> ["not allowed in this chat mode","not allowed in this chat mode"]',
          isError: false
        })
        expect(h.requests).toEqual([])
      }
    )

    it('remembers allow_session per outside path', async () => {
      const h = makeSession({ mode: () => 'auto', answer: async () => 'allow_session' })
      const write = (name: string) => `await write({ path: '../${name}', content: 'x' })`
      await h.run(`${write('one.txt')}; ${write('one.txt')}; ${write('two.txt')}; return 1`)
      expect(h.requests.map((r) => r.title)).toEqual([
        expect.stringContaining(join(base, 'one.txt')),
        expect.stringContaining(join(base, 'two.txt'))
      ])
      expect(await readFile(join(base, 'two.txt'), 'utf8')).toBe('x')
    })

    it('refuses an outside write in ask mode without asking', async () => {
      const h = makeSession({ mode: () => 'ask' })
      expect(await h.run(writeOutside)).toEqual({
        text: '=> "not allowed in this chat mode"',
        isError: false
      })
      expect(h.requests).toEqual([])
      expect(existsSync(join(base, 'outside.txt'))).toBe(false)
    })
  })
})
