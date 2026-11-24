import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CODEMODE_LIMITS, type CodemodeLimits } from '../codemode-limits'
import type { GateMode } from '../gate/codemode-gate'
import type { CodemodeServerSpec } from '../mcp-pool/codemode-mcp-pool'
import { fakeCrmServerSpec } from '../mcp-pool/testing/fake-crm-command'
import {
  type ApprovalDecision,
  type ApprovalRequest,
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
    external: ['quickjs-emscripten'],
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

  it('asks once for an untrusted call in ask mode and leaves state unchanged on deny', async () => {
    let mode: GateMode = 'ask'
    const h = makeSession({ mode: () => mode, answer: async () => 'deny' })
    const denied = await h.run(`
      try { await ${crm('add_credits', "{ user_id: 'u1', amount: 5 }")} } catch (e) { return e.message }`)
    expect(denied).toEqual({ text: '=> "denied by user"', isError: false })
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]).toMatchObject({ personOnly: false })
    expect(h.requests[0].title).toContain('add_credits')
    expect(h.events.at(-1)).toMatchObject({ state: 'error', output: 'denied by user' })
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
      text: '=> ["denied by user","denied by user","denied by user"]',
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
    const running = h.run(`await write({ path: 'a.txt', content: 'x' })`, controller.signal)
    await pendingAsk
    const stoppedAt = Date.now()
    controller.abort()
    const result = await running
    expect(Date.now() - stoppedAt).toBeLessThan(1000)
    expect(result).toEqual({ text: 'Error: Interrupted by user', isError: true })
    expect(h.requests[0].signal.aborted).toBe(true)
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
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
      expect(await h.run(writeOutside)).toEqual({ text: '=> "denied by user"', isError: false })
      expect(existsSync(join(base, 'outside.txt'))).toBe(false)
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
