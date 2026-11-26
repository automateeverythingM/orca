import { build } from 'esbuild'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  CodemodeLearnCall,
  CodemodeLearnDraft,
  CodemodeLearnRun
} from '../../../../shared/codemode/codemode-learn-types'
import { draftToLibFile } from '../writer/codemode-learn-writer-reply'
import { replayProposal } from './codemode-learn-replay'

let bundleRoot: string
let workerPath: string

beforeAll(async () => {
  // The QuickJS variant locates its WASM beside itself, so the bundle stays external and resolves from the repo.
  const cacheRoot = resolve('node_modules/.cache')
  await mkdir(cacheRoot, { recursive: true })
  bundleRoot = await mkdtemp(join(cacheRoot, 'orca-codemode-replay-'))
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
}, 30_000)
afterAll(() => rm(bundleRoot, { recursive: true, force: true }))

const recorded = (
  seq: number,
  tool: string,
  input: unknown,
  output: unknown,
  extra: Partial<CodemodeLearnCall> = {}
): CodemodeLearnCall => ({ seq, tool, input, ok: true, output, ms: 1, ...extra })

const run = (calls: CodemodeLearnCall[]): CodemodeLearnRun => ({
  runId: 'r1',
  sessionId: 's1',
  projectRoot: '/p',
  startedAt: 0,
  ms: 5,
  ok: true,
  code: 'return 1',
  calls
})

const CRM_RUN = run([
  recorded(1, 'mcp.crm.search', { email: 'a@b.c' }, { id: 7 }),
  recorded(2, 'mcp.crm.plan', { id: 7 }, { name: 'pro' })
])

const PLAN_BODY = [
  'const c = await mcp.crm.search({ email })',
  'const p = await mcp.crm.plan({ id: c.id })',
  "print('plan', p.name)",
  'return { plan: p.name }'
].join('\n')

function replay(
  body: string,
  opts: { runs?: CodemodeLearnRun[]; expect?: string[]; sampleArgs?: unknown } = {}
) {
  const draft: CodemodeLearnDraft = {
    name: 'planForEmail',
    description: 'Look up a customer by email and return their plan.',
    params: [{ name: 'email', type: 'string' }],
    body,
    sampleArgs: { email: 'a@b.c' },
    expect: ['pro'],
    callsSaved: 1,
    scope: 'global',
    why: 'repeated'
  }
  return replayProposal(
    {
      source: draftToLibFile(draft).source,
      name: draft.name,
      sampleArgs: opts.sampleArgs ?? draft.sampleArgs,
      expect: opts.expect ?? draft.expect,
      runs: opts.runs ?? [CRM_RUN]
    },
    { workerPath }
  )
}

describe('replayProposal', () => {
  it('replays recorded mcp calls and passes', async () => {
    const result = await replay(PLAN_BODY)
    expect(result).toMatchObject({ status: 'passed' })
    expect(result.reason).toBeUndefined()
    expect(result.log).toContain('✓ mcp.crm.search')
    expect(result.log).toContain('✓ mcp.crm.plan')
    expect(result.log).toContain('plan pro')
    expect(result.log).toContain('{"plan":"pro"}')
  })

  it('unrecorded call fails without calling out', async () => {
    // No real MCP server exists here; even a caught failure still fails the test.
    const body = [
      'const c = await mcp.crm.search({ email })',
      'try { await mcp.billing.refund({ id: c.id }) } catch {}',
      "return { plan: 'pro' }"
    ].join('\n')
    const result = await replay(body)
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'unrecorded call: mcp.billing.refund'
    })
    expect(result.log).toContain('✗ unrecorded call: mcp.billing.refund')
  })

  it('cut recordings never match', async () => {
    const runs = [
      run([
        recorded(1, 'mcp.crm.search', { email: 'a@b.c' }, { id: 7 }),
        recorded(2, 'mcp.crm.plan', { id: 7 }, '{"name":"pr', { outputTruncated: true })
      ])
    ]
    const result = await replay(PLAN_BODY, { runs })
    expect(result).toMatchObject({ status: 'failed', reason: 'unrecorded call: mcp.crm.plan' })
  })

  it('expect strings must appear', async () => {
    const result = await replay(PLAN_BODY, { expect: ['pro', 'enterprise'] })
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('enterprise')
  })

  it('throwing function fails with its message', async () => {
    const result = await replay("throw new Error('no customer found')")
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('no customer found')
    expect(result.log).toContain('no customer found')
  })

  it('bash/read replay from recordings', async () => {
    const runs = [
      run([
        recorded(1, 'read', { path: 'notes.md' }, 'plan: pro'),
        recorded(2, 'bash', { cmd: 'git log -1' }, { exit_code: 0, output: 'abc123' }),
        { seq: 3, tool: 'grep', input: { pattern: 'TODO' }, ok: false, error: 'no rg', ms: 1 }
      ])
    ]
    const body = [
      "const notes = await read('notes.md')",
      "const log = await bash('git log -1')",
      'let grepError = null',
      "try { await grep('TODO') } catch (e) { grepError = e.message }",
      'return { notes, commit: log.output, grepError }'
    ].join('\n')
    const result = await replay(body, { runs, expect: ['plan: pro', 'abc123', 'no rg'] })
    expect(result).toMatchObject({ status: 'passed' })
    expect(result.log).toContain('✓ read')
    expect(result.log).toContain('✓ bash')
  })

  it('lib calls are not replayed', async () => {
    const result = await replay('return await lib.otherThing({ email })')
    expect(result).toMatchObject({ status: 'failed', reason: 'lib calls are not replayed' })
  })
})

describe('replayProposal source structure', () => {
  const STRUCTURE = 'source must define only the function planForEmail'

  it('a body that closes the function and adds top-level code fails', async () => {
    const result = await replay('return 1\n}\nglobalThis.x = 1\nasync function y(){')
    expect(result).toMatchObject({ status: 'failed', reason: STRUCTURE })
    expect(result.log).toContain('defined other globals')
  })

  it('a body that calls mcp at top level fails', async () => {
    // Only planForEmail is defined, and the call has a recording, so only the load check catches it.
    const body = [
      PLAN_BODY,
      '}',
      "mcp.crm.search({ email: 'a@b.c' }).catch(() => {})",
      'if (true) {'
    ].join('\n')
    const result = await replay(body)
    expect(result).toMatchObject({ status: 'failed', reason: STRUCTURE })
    expect(result.log).toContain('loading the source called mcp.crm.search')
  })

  it('a body with a top-level return fails', async () => {
    const result = await replay('return 1\n}\nreturn async () => 2\nasync function y(){')
    expect(result).toMatchObject({ status: 'failed', reason: STRUCTURE })
    expect(result.log).toContain('loading the source failed')
  })

  it('a function named like a sandbox global must still define itself', async () => {
    const source = '// no function here\n'
    const result = await replayProposal(
      { source, name: 'read', sampleArgs: {}, expect: ['x'], runs: [CRM_RUN] },
      { workerPath }
    )
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'source must define only the function read'
    })
  })
})
