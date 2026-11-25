// The recorder wired into a real code-mode session: real QuickJS worker, real fake-crm MCP server.
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLaunchSession } from '../codemode-launch-session'
import type { CodemodeSession } from '../host/codemode-run-host'
import type { CodemodeServerSpec } from '../mcp-pool/codemode-mcp-pool'
import { fakeCrmServerSpec } from '../mcp-pool/testing/fake-crm-command'
import { CodemodeRunStore } from '../runs/codemode-run-store'
import { CodemodeLearnRecorder, learnNote } from './codemode-learn-recorder'
import { fakeLearnStore, type Recorded } from './testing/fake-learn-store'

let bundleRoot: string
let workerPath: string
let crmSpec: CodemodeServerSpec

beforeAll(async () => {
  const cacheRoot = resolve('node_modules/.cache')
  mkdirSync(cacheRoot, { recursive: true })
  bundleRoot = mkdtempSync(join(cacheRoot, 'orca-codemode-learn-recorder-'))
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

let root: string
const sessions: CodemodeSession[] = []

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codemode-learn-recorder-')))
})
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  await rm(root, { recursive: true, force: true })
})

function launch(opts: { enabled: boolean; recorded?: Recorded }) {
  const store = fakeLearnStore(
    async () => opts.recorded ?? { shape: 'h', otherSessions: 0, dismissed: false }
  )
  const storeFactory = vi.fn(() => store)
  const runs = new CodemodeRunStore()
  const recorder = new CodemodeLearnRecorder({
    enabled: () => opts.enabled,
    store: storeFactory,
    log: () => {}
  })
  const session = createLaunchSession({
    input: { sessionId: 's1', launchId: 'l1', root, env: process.env, mode: () => 'full-access' },
    specs: [crmSpec],
    wiring: null,
    connectorsOff: () => new Set(),
    trustedServers: () => [],
    onEvent: () => {},
    onRun: (event) => runs.run('s1', event),
    learn: { recorder, annotate: (runId, patch) => runs.annotate('s1', runId, patch) },
    workerPath
  })
  sessions.push(session)
  const run = (code: string) =>
    session.run(code, {
      signal: new AbortController().signal,
      approver: () => Promise.resolve('allow_once')
    })
  return { store, storeFactory, runs, run }
}

const twoCalls = `
  const user = JSON.parse(await mcp['fake-crm'].find_user({ email: 'x@y.com' }))
  return JSON.parse(await mcp['fake-crm'].add_credits({ user_id: user.id, amount: 5 })).credits`

describe('Learn recording in a code-mode session', () => {
  it('records code and full replies', async () => {
    const h = launch({ enabled: true })
    // The script itself can't take 5 MB (over its 4 MB result limit); the host still saw it whole.
    const code = `
      await mcp['fake-crm'].big({}).catch(() => null)
      return JSON.parse(await mcp['fake-crm'].find_user({ email: 'x@y.com' })).id`
    const result = await h.run(code)
    expect(result.isError).toBe(false)
    expect(h.store.record).toHaveBeenCalledTimes(1)
    const [run, now] = h.store.record.mock.calls[0]
    expect(now).toEqual(expect.any(Number))
    expect(run).toMatchObject({
      sessionId: 's1',
      projectRoot: root,
      code,
      ok: true,
      ms: expect.any(Number),
      startedAt: expect.any(Number)
    })
    expect(run.runId).toBe(h.runs.runs('s1')[0].runId)
    expect(run.calls.map((entry) => [entry.seq, entry.tool, entry.ok])).toEqual([
      [1, 'mcp.fake-crm.big', true],
      [2, 'mcp.fake-crm.find_user', true]
    ])
    // Capping is the store's job: the whole 5 MB reply reaches it.
    expect(run.calls[0].output).toBe('x'.repeat(5 * 1024 * 1024))
    expect(run.calls[1].input).toEqual({ email: 'x@y.com' })
  })

  it('records a failed inner call with its error', async () => {
    const h = launch({ enabled: true })
    await h.run(`
      await mcp['fake-crm'].find_user({ email: 'nobody@y.com' }).catch(() => null)
      return 1`)
    const [run] = h.store.record.mock.calls[0]
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]).toMatchObject({ tool: 'mcp.fake-crm.find_user', ok: false })
    expect(run.calls[0].error).toEqual(expect.any(String))
    expect(run.calls[0]).not.toHaveProperty('output')
  })

  it('appends the nudge to the run_js result and marks the run', async () => {
    const h = launch({
      enabled: true,
      recorded: { shape: 'h', otherSessions: 1, dismissed: false }
    })
    const { text, isError } = await h.run(twoCalls)
    expect(isError).toBe(false)
    expect(text.startsWith('=> 5')).toBe(true)
    expect(text.endsWith(learnNote(1))).toBe(true)
    expect(h.runs.runs('s1')[0]).toMatchObject({ state: 'ok', seenInChats: 2 })
  })

  it('switch off: no store, no nudge', async () => {
    const h = launch({
      enabled: false,
      recorded: { shape: 'h', otherSessions: 1, dismissed: false }
    })
    const { text } = await h.run(twoCalls)
    expect(text).not.toContain('Note:')
    expect(h.storeFactory).not.toHaveBeenCalled()
    expect(h.runs.runs('s1')[0].seenInChats).toBeUndefined()
  })
})
