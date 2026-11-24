import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CODEMODE_LIMITS } from '../codemode-limits'
import { runScriptInWorker } from './codemode-worker-run'

let bundleRoot: string
let entryPath: string
let crashPath: string

beforeAll(async () => {
  // quickjs-emscripten locates its WASM beside itself, so the bundle stays external and resolves from the repo.
  const cacheRoot = resolve('node_modules/.cache')
  mkdirSync(cacheRoot, { recursive: true })
  bundleRoot = mkdtempSync(join(cacheRoot, 'orca-codemode-worker-'))
  entryPath = join(bundleRoot, 'codemode-worker-entry.js')
  await build({
    entryPoints: [resolve('src/main/codemode/sandbox/codemode-worker-entry.ts')],
    outfile: entryPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['quickjs-emscripten'],
    logLevel: 'silent'
  })
  crashPath = join(bundleRoot, 'crash-entry.js')
  writeFileSync(
    crashPath,
    `const { parentPort } = require('node:worker_threads')
parentPort.postMessage({ type: 'call', id: 1, call: { tool: 'read', input: {} } })
parentPort.on('message', () => process.exit(7))`
  )
}, 30_000)
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

describe('runScriptInWorker', () => {
  it('round-trips host calls through the worker', async () => {
    const calls: unknown[] = []
    const result = await runScriptInWorker(
      `const text = await read({ path: 'a.txt' }); return text + '!'`,
      async (call) => {
        calls.push(call)
        return { ok: true, value: 'hello' }
      },
      CODEMODE_LIMITS,
      new AbortController().signal,
      entryPath
    )
    expect(result).toMatchObject({ ok: true, value: 'hello!' })
    expect(calls).toEqual([{ tool: 'read', input: { path: 'a.txt' } }])
  })

  it('reports a crashed worker without taking the caller down', async () => {
    const result = await runScriptInWorker(
      'return 1',
      async () => ({ ok: true, value: null }),
      CODEMODE_LIMITS,
      new AbortController().signal,
      crashPath
    )
    expect(result).toEqual({ ok: false, printed: [], error: 'sandbox crashed (exit 7)' })
  })

  it('terminates a runaway loop on abort', async () => {
    const controller = new AbortController()
    let settled = false
    const pending = runScriptInWorker(
      'while (true) {}',
      async () => ({ ok: true, value: null }),
      CODEMODE_LIMITS,
      controller.signal,
      entryPath
    ).finally(() => {
      settled = true
    })
    setTimeout(() => controller.abort(), 300)
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2_000 })
    expect(await pending).toEqual({ ok: false, printed: [], error: 'Interrupted by user' })
  })

  it('ignores a host reply that arrives after abort', async () => {
    const controller = new AbortController()
    let release: (() => void) | undefined
    const result = runScriptInWorker(
      `return await read({})`,
      () =>
        new Promise((resolveReply) => {
          release = () => resolveReply({ ok: true, value: 1 })
          controller.abort()
        }),
      CODEMODE_LIMITS,
      controller.signal,
      entryPath
    )
    await expect(result).resolves.toMatchObject({ ok: false, error: 'Interrupted by user' })
    release?.()
  })
})
