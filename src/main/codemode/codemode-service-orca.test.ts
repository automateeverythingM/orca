import { build } from 'esbuild'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { OrcaRpcDispatch } from './orca/codemode-orca-dispatch'
import type { OrcaMethodSource } from './orca/codemode-orca-method-policy'
import { CodemodeService, type CodemodeServiceOptions } from './codemode-service'

const METHODS: OrcaMethodSource[] = [
  { name: 'worktree.list', permission: 'workspace', params: z.object({}) },
  { name: 'worktree.current', permission: 'workspace', params: null }
]

let bundleRoot: string
let workerPath: string
let root: string
let service: CodemodeService | null = null
let sent: Parameters<OrcaRpcDispatch>[]
const clients: Client[] = []

const dispatch: OrcaRpcDispatch = async (request, options) => {
  sent.push([request, options])
  return {
    id: request.id,
    ok: true,
    result: { worktrees: [{ id: 'wt-1' }] },
    _meta: { runtimeId: 'test' }
  }
}

beforeAll(async () => {
  const cacheRoot = resolve('node_modules/.cache')
  await mkdir(cacheRoot, { recursive: true })
  bundleRoot = await mkdtemp(join(cacheRoot, 'orca-codemode-service-orca-'))
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
  root = await realpath(await mkdtemp(join(tmpdir(), 'codemode-service-orca-')))
  sent = []
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  await service?.stop()
  service = null
  await rm(root, { recursive: true, force: true })
})

/** Launches chat `sessionId` on the current service: its `orca` server. */
async function launch(sessionId = 's1'): Promise<{ url: string; authorization: string }> {
  const [server] = (await service?.launchServer({
    sessionId,
    launchId: `launch-${sessionId}`,
    root,
    env: process.env,
    mode: () => 'full-access'
  })) ?? [null]
  if (!server || !('url' in server) || !server.headers?.authorization) {
    throw new Error('expected an http server with a bearer token')
  }
  return { url: server.url, authorization: server.headers.authorization }
}

/** An agent connected to a chat's `orca` server. */
async function connect(server: { url: string; authorization: string }): Promise<Client> {
  const client = new Client({ name: 'agent', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { authorization: server.authorization } }
    })
  )
  clients.push(client)
  return client
}

/** A service with `opts`, one launched chat `s1`, and an agent connected to it. */
async function agentFor(opts: Partial<CodemodeServiceOptions>): Promise<Client> {
  service = new CodemodeService({ workerPath, log: () => {}, libHomeDir: root, ...opts })
  return connect(await launch())
}

async function runJs(client: Client, code: string): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name: 'run_js', arguments: { code } })
  const content = Array.isArray(result.content) ? result.content : []
  const whole = content.map((item) => (item.type === 'text' ? item.text : '')).join('\n')
  const [text = ''] = whole.split('\nInner calls:\n')
  return { text, isError: result.isError === true }
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length

describe('CodemodeService with Orca runtime access', () => {
  it("calls the runtime as the chat and returns the method's result", async () => {
    const client = await agentFor({ orcaRpc: { methods: METHODS, dispatch } })

    const result = await runJs(client, 'return await orca.worktree.list({})')

    expect(result).toEqual({ text: '=> {"worktrees":[{"id":"wt-1"}]}', isError: false })
    expect(sent).toHaveLength(1)
    const [[request, options]] = sent
    expect(request).toMatchObject({
      method: 'worktree.list',
      params: {},
      orchestrationCompatibilityEvidence: { agentSessionId: 's1' }
    })
    expect(options.caller).toEqual({ kind: 'local-cli' })
  })

  it("gives orca.context() the chat's ids from the live session record", async () => {
    let location: { worktreeId?: string; workspaceId?: string } = { workspaceId: 'ws-1' }
    const client = await agentFor({
      orcaRpc: { methods: METHODS, dispatch },
      sessionContext: (sessionId) => (sessionId === 's1' ? location : undefined)
    })

    const first = await runJs(client, 'return await orca.context()')
    location = { worktreeId: 'wt-2', workspaceId: 'wt-2' }
    const second = await runJs(client, 'return await orca.context()')

    expect(JSON.parse(first.text.replace(/^=> /, ''))).toEqual({
      sessionId: 's1',
      root,
      workspaceId: 'ws-1'
    })
    expect(JSON.parse(second.text.replace(/^=> /, ''))).toEqual({
      sessionId: 's1',
      root,
      worktreeId: 'wt-2',
      workspaceId: 'wt-2'
    })
  })

  it('gives later launches runtime access set after the service was created', async () => {
    const client = await agentFor({})
    service?.setOrcaRpc({ methods: METHODS, dispatch })
    const later = await connect(await launch('s2'))

    expect((await runJs(client, 'return await orca.worktree.current()')).isError).toBe(true)
    expect(await runJs(later, 'return await orca.worktree.current()')).toEqual({
      text: '=> {"worktrees":[{"id":"wt-1"}]}',
      isError: false
    })
  })

  it('tells the script Orca actions are unavailable without runtime access', async () => {
    const client = await agentFor({})

    const result = await runJs(client, 'return await orca.worktree.list({})')

    expect(result.isError).toBe(true)
    expect(result.text).toContain('Orca actions are not available in this chat')
    expect(sent).toEqual([])
    const { tools } = await client.listTools()
    const description = tools.find((tool) => tool.name === 'run_js')?.description ?? ''
    expect(description).toContain('3 or more tool calls')
    expect(description).not.toContain('orca.')
  })

  it('describes orca.* in the run_js tool within the word budget', async () => {
    const client = await agentFor({ orcaRpc: { methods: METHODS, dispatch } })

    const { tools } = await client.listTools()
    const description = tools.find((tool) => tool.name === 'run_js')?.description ?? ''

    expect(description).toContain('orca.areas()')
    expect(description).toContain('orca.context()')
    expect(words(description)).toBeLessThanOrEqual(150)
  })
})
