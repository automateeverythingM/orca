import { build } from 'esbuild'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GateMode } from './gate/codemode-gate'
import { fakeCrmServerSpec } from './mcp-pool/testing/fake-crm-command'
import { CodemodeService } from './codemode-service'

type Decision = 'allow_once' | 'deny'

let bundleRoot: string
let workerPath: string
let root: string
let crm: { command: string; args: string[] }
let service: CodemodeService
const clients: Client[] = []

const FOUR_STEPS = `
const crm = mcp['fake-crm']
const user = JSON.parse(await crm.find_user({ email: 'x@y.com' }))
await crm.update_user({ user_id: user.id, name: 'Bob' })
await crm.add_to_group({ user_id: user.id, group: 'Team A' })
await crm.add_credits({ user_id: user.id, amount: 10 })
return 'done'
`
const GET_STATE = `return JSON.parse(await mcp['fake-crm'].get_state())`

beforeAll(async () => {
  const cacheRoot = resolve('node_modules/.cache')
  await mkdir(cacheRoot, { recursive: true })
  bundleRoot = await mkdtemp(join(cacheRoot, 'orca-codemode-e2e-'))
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
  crm = await fakeCrmServerSpec()
}, 30_000)
afterAll(() => rm(bundleRoot, { recursive: true, force: true }))

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codemode-e2e-')))
  await mkdir(join(root, '.orca'))
  await writeFile(
    join(root, '.orca', 'mcp.json'),
    JSON.stringify({ mcpServers: { 'fake-crm': crm } })
  )
  service = new CodemodeService({ workerPath, log: () => {} })
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  await service.stop()
  await rm(root, { recursive: true, force: true })
})

/** Connects an agent that declares form elicitation and answers each approval by its message. */
async function agent(mode: GateMode, policy: (message: string) => Decision): Promise<Client> {
  const server = await service.launchServer({
    sessionId: 's1',
    root,
    env: process.env,
    mode: () => mode
  })
  if (!server || !('url' in server) || !server.headers?.authorization) {
    throw new Error('expected an http server with a bearer token')
  }
  const client = new Client(
    { name: 'agent', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } } }
  )
  client.setRequestHandler(ElicitRequestSchema, async (request): Promise<ElicitResult> => ({
    action: 'accept',
    content: { decision: policy(request.params.message) }
  }))
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { authorization: server.headers.authorization } }
    })
  )
  clients.push(client)
  return client
}

async function runJs(client: Client, code: string): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name: 'run_js', arguments: { code } })
  const content = Array.isArray(result.content) ? result.content : []
  const text = content.map((item) => (item.type === 'text' ? item.text : '')).join('\n')
  return { text, isError: result.isError === true }
}

async function crmState(client: Client): Promise<unknown> {
  const { text, isError } = await runJs(client, GET_STATE)
  expect(isError).toBe(false)
  return JSON.parse(text.replace(/^=> /, ''))
}

function payloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

describe('code mode end to end', () => {
  it('runs the four-step CRM task in one run_js call in full access', async () => {
    const asked: string[] = []
    const client = await agent('full-access', (message) => {
      asked.push(message)
      return 'allow_once'
    })

    expect(await runJs(client, FOUR_STEPS)).toEqual({ text: '=> "done"', isError: false })
    expect(await crmState(client)).toEqual([
      { id: 'u1', email: 'x@y.com', name: 'Bob', groups: ['Team A'], credits: 10 }
    ])
    expect(asked).toEqual([])
  })

  it('stops at the call the person denies in ask mode', async () => {
    const asked: string[] = []
    const client = await agent('ask', (message) => {
      asked.push(message)
      return message.startsWith('Call fake-crm.add_credits') ? 'deny' : 'allow_once'
    })

    const result = await runJs(client, FOUR_STEPS)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('mcp.fake-crm.add_credits: denied by user')
    expect(asked.map((message) => message.split('\n')[0]).sort()).toEqual([
      'Call fake-crm.add_credits',
      'Call fake-crm.add_to_group',
      'Call fake-crm.find_user',
      'Call fake-crm.update_user',
      'Start MCP server fake-crm'
    ])
    expect(await crmState(client)).toEqual([
      { id: 'u1', email: 'x@y.com', name: 'Bob', groups: ['Team A'], credits: 0 }
    ])
  })

  it('lists only run_js, which is smaller than five fake-crm tool lists', async () => {
    const client = await agent('full-access', () => 'allow_once')
    const codeMode = await client.listTools()
    expect(codeMode.tools.map((tool) => tool.name)).toEqual(['run_js'])
    expect(JSON.stringify(codeMode)).not.toContain('find_user')

    const direct = new Client({ name: 'agent', version: '1.0.0' })
    await direct.connect(new StdioClientTransport({ command: crm.command, args: crm.args }))
    clients.push(direct)
    const fakeCrm = await direct.listTools()

    const codeModeBytes = payloadBytes(codeMode)
    const fiveServersBytes = payloadBytes(fakeCrm) * 5
    console.log(
      `[codemode tokens] tools/list bytes: code mode ${codeModeBytes}, fake-crm ${payloadBytes(fakeCrm)} x 5 = ${fiveServersBytes}`
    )
    expect(codeModeBytes).toBeLessThan(fiveServersBytes)
  })
})
