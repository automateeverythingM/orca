// Learn end to end: real QuickJS worker, real fake-crm MCP servers, and the real Learn worker thread
// on a temp store file. Two chats run the same script shape; the second hears about it.
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { eraseRpcMethods } from '../../runtime/rpc/core'
import { codemodeLearnMethods } from '../../runtime/rpc/methods/codemode/codemode-learn'
import { CodemodeLearnRunner } from './codemode-learn-pipeline'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import { createLaunchSession } from '../codemode-launch-session'
import type { CodemodeSession } from '../host/codemode-run-host'
import type { CodemodeServerSpec } from '../mcp-pool/codemode-mcp-pool'
import { fakeCrmServerSpec } from '../mcp-pool/testing/fake-crm-command'
import { CodemodeRunStore } from '../runs/codemode-run-store'
import { CodemodeLearnWorkerClient } from './db-worker/codemode-learn-worker-client'
import { CodemodeLearnRecorder, learnNote } from './codemode-learn-recorder'

let bundleRoot: string
let workerPath: string
let learnEntry: string
let crm: CodemodeServerSpec
let other: CodemodeServerSpec

beforeAll(async () => {
  const cacheRoot = resolve('node_modules/.cache')
  mkdirSync(cacheRoot, { recursive: true })
  bundleRoot = mkdtempSync(join(cacheRoot, 'orca-codemode-learn-e2e-'))
  workerPath = join(bundleRoot, 'codemode-worker-entry.js')
  learnEntry = join(bundleRoot, 'codemode-learn-worker-entry.js')
  const common = { bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' } as const
  await build({
    ...common,
    entryPoints: [resolve('src/main/codemode/sandbox/codemode-worker-entry.ts')],
    outfile: workerPath,
    external: ['quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync']
  })
  await build({
    ...common,
    entryPoints: [resolve('src/main/codemode/learn/db-worker/codemode-learn-worker-entry.ts')],
    outfile: learnEntry
  })
  const spec = await fakeCrmServerSpec()
  crm = { name: 'fake-crm', ...spec, source: 'orca' }
  other = { name: 'other', ...spec, source: 'orca' }
}, 60_000)
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

let root: string
let dir: string
let enabled: boolean
let client: CodemodeLearnWorkerClient
let recorder: CodemodeLearnRecorder
let remote: ReturnType<CodemodeLearnWorkerClient['store']>
const sessions: CodemodeSession[] = []

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codemode-learn-e2e-')))
  dir = mkdtempSync(join(tmpdir(), 'orca-learn-e2e-store-'))
  enabled = true
  client = new CodemodeLearnWorkerClient(() =>
    spawnWorkerThread(learnEntry, { name: 'orca-codemode-learn' })
  )
  remote = client.store(join(dir, 'codemode-learn.sqlite'))
  recorder = new CodemodeLearnRecorder({
    enabled: () => enabled,
    store: () => remote,
    log: () => {}
  })
})
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  await client.close()
  await rm(root, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

/** One chat: its own session id, sharing the recorder and so the one store. */
function chat(sessionId: string, specs: CodemodeServerSpec[] = [crm, other]) {
  const runs = new CodemodeRunStore()
  const session = createLaunchSession({
    input: { sessionId, launchId: 'l', root, env: process.env, mode: () => 'full-access' },
    specs,
    wiring: null,
    connectorsOff: () => new Set(),
    trustedServers: () => [],
    onEvent: () => {},
    onRun: (event) => runs.run(sessionId, event),
    learn: { recorder, annotate: (runId, patch) => runs.annotate(sessionId, runId, patch) },
    workerPath
  })
  sessions.push(session)
  return {
    runs,
    run: (code: string) =>
      session.run(code, {
        signal: new AbortController().signal,
        approver: () => Promise.resolve('allow_once')
      })
  }
}

/** The same shape for any server and amount: only the literals and the server key differ. */
const crmScript = (server: string, amount: number) => `
  const user = JSON.parse(await mcp['${server}'].find_user({ email: 'x@y.com' }))
  return JSON.parse(await mcp['${server}'].add_credits({ user_id: user.id, amount: ${amount} })).credits`

describe('Learn end to end', () => {
  it('same task in two sessions nudges the second (literals differ) and Settings lists it', async () => {
    const first = await chat('s1').run(crmScript('fake-crm', 5))
    expect(first.text).not.toContain('Note:')

    const second = chat('s2')
    const result = await second.run(crmScript('fake-crm', 9))
    expect(result.isError).toBe(false)
    expect(result.text.endsWith(learnNote(1))).toBe(true)
    expect(result.text).toContain('you have run this same script in 1 other chat')
    expect(second.runs.runs('s2')[0]).toMatchObject({ state: 'ok', seenInChats: 2 })

    // The RPC the Settings page calls, over the same real store.
    const methods = codemodeLearnMethods({
      desktop: () => true,
      service: async () => ({
        learnEnabled: () => enabled,
        learnStore: () => remote,
        closeLearnStore: async () => {},
        learnRunner: () => new CodemodeLearnRunner()
      }),
      storeExists: async () => true,
      removeStoreFiles: async () => {},
      journal: async () => null,
      // ast-grep-ignore: test-no-wall-clock -- the recorder stamps runs with the real clock in the worker; reads must use the same clock.
      now: Date.now,
      log: () => {}
    })
    const list = eraseRpcMethods(methods).find((m) => m.name === 'codemode.learn.list')
    const view: unknown = await list?.handler(null, { runtime: new OrcaRuntimeService(null) })
    expect(view).toMatchObject({
      scripts: [
        {
          kind: 'script',
          sessions: 2,
          runs: 2,
          tools: ['mcp.fake-crm.add_credits', 'mcp.fake-crm.find_user']
        }
      ]
    })
    // ast-grep-ignore: test-no-wall-clock -- the recorder stamps runs with the real clock in the worker; reads must use the same clock.
    expect(await remote.repeatedScripts(Date.now(), 5)).toMatchObject([{ sessions: 2 }])
  })

  it('different servers do not match', async () => {
    await chat('s1').run(crmScript('fake-crm', 5))
    const result = await chat('s2').run(crmScript('other', 5))
    expect(result.isError).toBe(false)
    expect(result.text).not.toContain('Note:')
    // ast-grep-ignore: test-no-wall-clock -- the recorder stamps runs with the real clock in the worker; reads must use the same clock.
    expect(await remote.repeatedScripts(Date.now(), 5)).toEqual([])
    expect((await remote.stats()).runs).toBe(2)
  })

  it('switch off: no rows, no nudge', async () => {
    enabled = false
    await chat('s1').run(crmScript('fake-crm', 5))
    const result = await chat('s2').run(crmScript('fake-crm', 9))
    expect(result.text).not.toContain('Note:')
    // Off never starts the worker, so the store file was never even created.
    expect(existsSync(join(dir, 'codemode-learn.sqlite'))).toBe(false)

    enabled = true
    expect((await remote.stats()).runs).toBe(0)
  })

  it('clear then run: counts restart', async () => {
    await chat('s1').run(crmScript('fake-crm', 5))
    expect((await remote.stats()).runs).toBe(1)
    await remote.clear()
    expect((await remote.stats()).runs).toBe(0)

    // The earlier chat's run is gone, so the next chat is the first again.
    const afterClear = await chat('s2').run(crmScript('fake-crm', 9))
    expect(afterClear.text).not.toContain('Note:')
    const again = await chat('s3').run(crmScript('fake-crm', 11))
    expect(again.text.endsWith(learnNote(1))).toBe(true)
  })
})
