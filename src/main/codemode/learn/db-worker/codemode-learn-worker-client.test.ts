// The real worker bundle on a real file: the same esbuild step the codemode sandbox worker tests use.
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CodemodeLearnRun } from '../../../../shared/codemode/codemode-learn-types'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import { codemodeShapeHash } from '../codemode-shape'
import { CodemodeLearnWorkerClient } from './codemode-learn-worker-client'

const NOW = 1_800_000_000_000
const SCRIPT = `const a = await mcp.crm.find({ q: 1 }); return mcp.crm.update(a)`

let dir: string
let entryPath: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-codemode-learn-worker-'))
  entryPath = join(dir, 'codemode-learn-worker-entry.js')
  await build({
    entryPoints: [resolve('src/main/codemode/learn/db-worker/codemode-learn-worker-entry.ts')],
    outfile: entryPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
}, 30_000)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function run(runId: string, sessionId: string): CodemodeLearnRun {
  return {
    runId,
    sessionId,
    projectRoot: '/repo',
    startedAt: NOW - 1000,
    ms: 12,
    ok: true,
    code: SCRIPT,
    calls: [
      { seq: 0, tool: 'mcp.crm.find', input: { q: 1 }, ok: true, output: { id: 7 }, ms: 4 },
      { seq: 1, tool: 'mcp.crm.update', input: 7, ok: false, error: 'nope', ms: 2 }
    ]
  }
}

describe('CodemodeLearnWorkerClient', () => {
  it('round-trips record and repeatedScripts through the worker, and close tears it down', async () => {
    const workers: Worker[] = []
    const client = new CodemodeLearnWorkerClient(() => {
      const worker = spawnWorkerThread(entryPath, { name: 'orca-codemode-learn' })
      workers.push(worker)
      return worker
    })
    const learn = client.store(join(dir, 'codemode-learn.sqlite'))
    // Lazy: nothing starts until the first call.
    expect(workers).toHaveLength(0)

    const first = await learn.record(run('r1', 'a'), NOW)
    expect(first).toEqual({ shape: codemodeShapeHash(SCRIPT), otherSessions: 0, dismissed: false })
    expect(await learn.record(run('r2', 'b'), NOW)).toMatchObject({ otherSessions: 1 })
    expect(await learn.repeatedScripts(NOW, 5)).toEqual([
      {
        kind: 'script',
        shape: first.shape,
        sessions: 2,
        runs: 2,
        lastSeen: NOW - 1000,
        sampleCode: SCRIPT,
        tools: ['mcp.crm.find', 'mcp.crm.update'],
        projectRoots: ['/repo']
      }
    ])
    expect(await learn.runsForShape(first.shape, 1)).toEqual([run('r2', 'b')])
    expect(workers).toHaveLength(1)

    await client.close()
    expect(workers[0].threadId).toBe(-1)
    await expect(learn.stats()).rejects.toThrow()
  })

  it('a store error comes back as a rejected call', async () => {
    const client = new CodemodeLearnWorkerClient(() =>
      spawnWorkerThread(entryPath, { name: 'orca-codemode-learn' })
    )
    // A folder is not a database file: SQLite refuses to open it.
    const learn = client.store(dir)
    await expect(learn.stats()).rejects.toThrow()
    await client.close()
  })
})
