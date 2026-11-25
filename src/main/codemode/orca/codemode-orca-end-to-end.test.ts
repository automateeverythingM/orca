import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { CodemodeService } from '../codemode-service'
import type { GateMode } from '../gate/codemode-gate'
import { codemodeOrcaRuntimeRpc } from './codemode-orca-runtime-wiring'

// A native chat's session id is an Orca session id: a plain UUID.
const SESSION_ID = randomUUID()

let bundleRoot: string
let workerPath: string
let root: string
let service: CodemodeService | null = null
let dispatched: string[]
let asked: string[]
const clients: Client[] = []

beforeAll(async () => {
  const cacheRoot = resolve('node_modules/.cache')
  await mkdir(cacheRoot, { recursive: true })
  bundleRoot = await mkdtemp(join(cacheRoot, 'orca-codemode-orca-e2e-'))
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

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codemode-orca-e2e-')))
  dispatched = []
  asked = []
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  await service?.stop()
  service = null
  await rm(root, { recursive: true, force: true })
})

/** An agent on a chat whose `orca.*` is the production rpc over a real runtime; it denies every approval. */
async function agent(mode: GateMode): Promise<Client> {
  const rpc = codemodeOrcaRuntimeRpc(new OrcaRuntimeService(null))
  service = new CodemodeService({
    workerPath,
    log: () => {},
    orcaRpc: {
      methods: rpc.methods,
      dispatch: (request, options) => {
        dispatched.push(request.method)
        return rpc.dispatch(request, options)
      }
    }
  })
  const [server] = (await service.launchServer({
    sessionId: SESSION_ID,
    launchId: 'launch-1',
    root,
    env: process.env,
    mode: () => mode
  })) ?? [null]
  if (!server || !('url' in server) || !server.headers?.authorization) {
    throw new Error('expected an http server with a bearer token')
  }
  const client = new Client(
    { name: 'agent', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } } }
  )
  client.setRequestHandler(ElicitRequestSchema, async (request): Promise<ElicitResult> => {
    asked.push(request.params.message)
    return { action: 'accept', content: { decision: 'deny' } }
  })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { authorization: server.headers.authorization } }
    })
  )
  clients.push(client)
  return client
}

/** The script's returned value (throws on a failed run) and the inner calls the result lists. */
async function run(client: Client, code: string): Promise<{ value: unknown; calls: string[] }> {
  const result = await client.callTool({ name: 'run_js', arguments: { code } })
  const content = Array.isArray(result.content) ? result.content : []
  const whole = content.map((item) => (item.type === 'text' ? item.text : '')).join('\n')
  const [text = '', calls] = whole.split('\nInner calls:\n')
  if (result.isError === true || !text.startsWith('=> ')) {
    throw new Error(text)
  }
  return { value: JSON.parse(text.slice(3)), calls: calls ? calls.split('\n') : [] }
}

const COLLECT = `const out = []
  const attempt = async (fn) => { try { out.push(await fn()) } catch (e) { out.push(e.message) } }`

describe('orca.* end to end over the real registry and dispatcher', () => {
  it('lists areas, describes a method and reads data from the runtime', async () => {
    const client = await agent('full-access')
    const { value, calls } = await run(
      client,
      `const [create] = await orca.describe('worktree.create')
      return { areas: await orca.areas(), create, listed: await orca.worktree.list({}) }`
    )
    const { areas, create, listed } = z
      .object({
        areas: z.array(z.string()),
        create: z.object({ method: z.string(), label: z.string(), params: z.unknown() }),
        listed: z.record(z.string(), z.unknown())
      })
      .parse(value)

    expect(areas).toContain('worktree')
    for (const hidden of ['codemode', 'accounts', 'settings']) {
      expect(areas).not.toContain(hidden)
    }
    expect(create).toMatchObject({
      method: 'worktree.create',
      // Its params can start an agent in the new worktree.
      label: 'destructive',
      params: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }
    })
    // A runtime with no repos lists none: the real handler answered through the real dispatcher.
    expect(listed).toMatchObject({ worktrees: [], totalCount: 0 })
    expect(dispatched).toEqual(['worktree.list'])
    expect(calls.some((line) => line.startsWith('orca.worktree.list ✓'))).toBe(true)
  })

  it("refuses code mode's own methods and odd names without dispatching", async () => {
    const client = await agent('full-access')
    const odd = ['__proto__', 'constructor', 'Worktree.List', 'worktree.list.', '.list']
    const { value } = await run(
      client,
      `${COLLECT}
      await attempt(() => orca.codemode.connectors.list())
      await attempt(() => orca.describe('codemode'))
      await attempt(() => orca.describe('codemode.connectors.setToken'))
      for (const name of ${JSON.stringify(odd)}) await attempt(() => orca.call(name, {}))
      return out`
    )

    expect(value).toEqual([
      'codemode.connectors.list is not available in code mode',
      'unknown Orca area or method: codemode',
      'unknown Orca area or method: codemode.connectors.setToken',
      ...odd.map((name) => `${name} is not available in code mode`)
    ])
    expect(dispatched).toEqual([])
    expect(asked).toEqual([])
  })

  it('asks before a destructive call in full access; a denial reaches the script', async () => {
    const client = await agent('full-access')
    const { value } = await run(
      client,
      `${COLLECT}
      await attempt(() => orca.worktree.rm({ worktree: 'id:nope' }))
      return out`
    )

    expect(value).toEqual(['orca.worktree.rm: denied by user'])
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('Orca: worktree.rm')
    expect(dispatched).toEqual([])
  })

  it('refuses a destructive call in read-only without asking', async () => {
    const client = await agent('read-only')
    const { value } = await run(
      client,
      `${COLLECT}
      await attempt(() => orca.worktree.rm({ worktree: 'id:nope' }))
      return out`
    )

    expect(value).toEqual(['not allowed in this chat mode'])
    expect(asked).toEqual([])
    expect(dispatched).toEqual([])
  })

  it('names the chat as the orchestration caller, and the runtime refuses what it cannot verify', async () => {
    const client = await agent('full-access')
    const { value } = await run(
      client,
      `${COLLECT}
      await attempt(() => orca.orchestration.runList({}))
      return out`
    )

    // No agent-session host runs here, so the chat's session cannot be verified: refused, never
    // attributed to another caller.
    expect(value).toEqual([expect.stringContaining('cannot be verified')])
    expect(value).toEqual([expect.stringContaining('No effects were applied')])
    expect(dispatched).toEqual(['orchestration.runList'])
  })
})
