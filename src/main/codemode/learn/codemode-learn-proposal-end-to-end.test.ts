// Learn proposals end to end: real QuickJS worker, real Learn worker thread on a temp store, and
// real fake-crm MCP servers. The writer is a fake (the real one must never run in tests); replay,
// save and the later lib call are the real code.
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodemodeLearnProposal,
  CodemodeLearnProposalsView
} from '../../../shared/codemode/codemode-learn-types'
import { eraseRpcMethods, type RpcContext } from '../../runtime/rpc/core'
import { codemodeLearnProposalMethods } from '../../runtime/rpc/methods/codemode/codemode-learn-proposals'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import { CodemodeService } from '../codemode-service'
import { fakeCrmServerSpec } from '../mcp-pool/testing/fake-crm-command'
import { CodemodeLearnWorkerClient } from './db-worker/codemode-learn-worker-client'
import type { LearnWriterGenerate } from './writer/codemode-learn-writer'

let bundleRoot: string
let workerPath: string
let learnEntry: string
let crm: { command: string; args: string[] }

beforeAll(async () => {
  const cacheRoot = resolve('node_modules/.cache')
  mkdirSync(cacheRoot, { recursive: true })
  bundleRoot = mkdtempSync(join(cacheRoot, 'orca-codemode-learn-proposal-e2e-'))
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
  crm = await fakeCrmServerSpec()
}, 60_000)
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

let root: string
let storeDir: string
let learnClient: CodemodeLearnWorkerClient
let remote: ReturnType<CodemodeLearnWorkerClient['store']>
let rpcService: CodemodeService
let generate: LearnWriterGenerate
const services: CodemodeService[] = []
const clients: Client[] = []
const cards: string[] = []

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codemode-learn-proposal-e2e-')))
  storeDir = mkdtempSync(join(tmpdir(), 'orca-learn-proposal-e2e-store-'))
  await mkdir(join(root, '.orca'))
  await writeFile(
    join(root, '.orca', 'mcp.json'),
    JSON.stringify({ mcpServers: { 'fake-crm': crm } })
  )
  learnClient = new CodemodeLearnWorkerClient(() =>
    spawnWorkerThread(learnEntry, { name: 'orca-codemode-learn' })
  )
  remote = learnClient.store(join(storeDir, 'codemode-learn.sqlite'))
  cards.length = 0
  rpcService = newService()
  // A writer that is never reached unless a test sets it.
  generate = async () => ({ ok: false, error: 'no writer set' })
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  await Promise.all(services.splice(0).map((service) => service.stop()))
  await learnClient.close()
  await rm(root, { recursive: true, force: true })
  rmSync(storeDir, { recursive: true, force: true })
})

/** A service over the shared Learn store and the same project and home: one Orca session each. */
function newService(): CodemodeService {
  const service = new CodemodeService({
    workerPath,
    log: () => {},
    // The home must differ from the root, or the root has no project scope.
    libHomeDir: join(root, 'home'),
    learnEnabled: () => true,
    learnStore: remote
  })
  services.push(service)
  return service
}

/** A chat in a new service; it reports every approval card it is shown. */
async function chat(): Promise<Client> {
  const service = newService()
  const [server] = (await service.launchServer({
    sessionId: `s${services.length}`,
    launchId: 'launch-1',
    root,
    env: process.env,
    mode: () => 'full-access'
  })) ?? [null]
  if (!server || !('url' in server) || !server.headers?.authorization) {
    throw new Error('expected an http server with a bearer token')
  }
  const client = new Client(
    { name: 'agent', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } } }
  )
  client.setRequestHandler(ElicitRequestSchema, async (request): Promise<ElicitResult> => {
    cards.push(request.params.message.split('\n')[0])
    return { action: 'accept', content: { decision: 'allow_once' } }
  })
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
  const whole = content.map((item) => (item.type === 'text' ? item.text : '')).join('\n')
  return { text: whole.split('\nInner calls:\n')[0], isError: result.isError === true }
}

async function credits(client: Client): Promise<number> {
  const { text } = await runJs(
    client,
    `return JSON.parse(await mcp['fake-crm'].get_state())[0].credits`
  )
  return Number(text.replace(/^=> /, ''))
}

/** The same shape each time: only the amount differs. */
const crmScript = (amount: number) => `
  const user = JSON.parse(await mcp['fake-crm'].find_user({ email: 'x@y.com' }))
  return JSON.parse(await mcp['fake-crm'].add_credits({ user_id: user.id, amount: ${amount} })).credits`

const draft = (body: string): string =>
  JSON.stringify({
    worth: true,
    name: 'addCreditsByEmail',
    description: 'Find a user by email and add credits.',
    params: [
      { name: 'email', type: 'string' },
      { name: 'amount', type: 'number' }
    ],
    body,
    sample_args: { email: 'x@y.com', amount: 5 },
    expect: ['5'],
    calls_saved: 1,
    scope: 'project',
    why: 'used in two chats'
  })

const GOOD_BODY = `const crm = mcp['fake-crm']
const user = JSON.parse(await crm.find_user({ email }))
return JSON.parse(await crm.add_credits({ user_id: user.id, amount })).credits`

function methods() {
  const proposals = codemodeLearnProposalMethods({
    desktop: () => true,
    service: async () => rpcService,
    chains: async () => [],
    generate: () => generate,
    projectAccess: async () => {},
    // ast-grep-ignore: test-no-wall-clock -- the store worker stamps runs with the real clock; the run reads with the same one.
    now: Date.now,
    log: vi.fn(),
    workerPath
  })
  const ctx: RpcContext = { runtime: new OrcaRuntimeService(null) }
  return async (name: string, params?: unknown): Promise<unknown> => {
    const method = eraseRpcMethods(proposals).find((m) => m.name === name)
    if (!method) {
      throw new Error(`no method ${name}`)
    }
    return await method.handler(method.params?.parse(params) ?? params, ctx)
  }
}

const isView = (value: unknown): value is CodemodeLearnProposalsView =>
  typeof value === 'object' && value !== null && 'proposals' in value

async function finishedProposal(call: ReturnType<typeof methods>): Promise<CodemodeLearnProposal> {
  await expect
    .poll(
      async () => {
        const view = await call('codemode.learn.proposals')
        return isView(view) && !view.running && view.proposals.length > 0
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  const view = await call('codemode.learn.proposals')
  if (!isView(view)) {
    throw new Error('not a proposals view')
  }
  return view.proposals[0]
}

describe('Learn proposals end to end', () => {
  it('two sessions → propose → replay passes → save → a new session calls lib.<name>', async () => {
    generate = async () => ({ ok: true, text: draft(GOOD_BODY) })
    await runJs(await chat(), crmScript(5))
    await runJs(await chat(), crmScript(9))

    const call = methods()
    await expect(call('codemode.learn.propose', {})).resolves.toEqual({ started: true })
    const proposal = await finishedProposal(call)
    expect(proposal).toMatchObject({ state: 'ready', testStatus: 'passed', projectRoot: root })

    await expect(
      call('codemode.learn.saveProposal', { id: proposal.id, scope: 'project' })
    ).resolves.toEqual({ name: 'addCreditsByEmail', scope: 'project' })
    const file = readFileSync(join(root, '.orca', 'lib', 'addCreditsByEmail.js'), 'utf8')
    expect(file).toContain('@saved-by learn')
    expect(file).toContain('async function addCreditsByEmail({ email, amount })')

    // A new session: the saved function is trusted, so it runs with no approval card.
    const fresh = await chat()
    cards.length = 0
    const result = await runJs(
      fresh,
      `return await lib.addCreditsByEmail({ email: 'x@y.com', amount: 7 })`
    )
    expect(result).toEqual({ text: '=> 7', isError: false })
    expect(await credits(fresh)).toBe(7)
    expect(cards.filter((title) => title.includes('addCreditsByEmail'))).toEqual([])
  })

  it('a draft calling an unrecorded tool fails replay and calls nothing real', async () => {
    generate = async () => ({
      ok: true,
      text: draft(`const crm = mcp['fake-crm']
await crm.add_credits({ user_id: 'u1', amount: 100 })
return 5`)
    })
    await runJs(await chat(), crmScript(5))
    const second = await chat()
    await runJs(second, crmScript(9))
    expect(await credits(second)).toBe(9)

    const call = methods()
    await call('codemode.learn.propose', {})
    const proposal = await finishedProposal(call)
    expect(proposal).toMatchObject({ state: 'ready', testStatus: 'failed' })
    expect(proposal.testReason).toContain('unrecorded call')
    // Replay answers only from recordings, so the live server never saw the extra grant.
    expect(await credits(second)).toBe(9)
    await expect(
      call('codemode.learn.saveProposal', { id: 'nope', scope: 'project' })
    ).rejects.toThrow('unknown proposal')
  })
})
