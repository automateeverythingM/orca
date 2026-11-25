import { build } from 'esbuild'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CodemodeService } from '../codemode-service'
import type { GateMode } from '../gate/codemode-gate'
import { fakeCrmServerSpec } from '../mcp-pool/testing/fake-crm-command'

type Card = { title: string; personOnly: boolean }
type Decision = 'allow_once' | 'deny'

let bundleRoot: string
let workerPath: string
let root: string
let crm: { command: string; args: string[] }
const services: CodemodeService[] = []
const clients: Client[] = []

beforeAll(async () => {
  const cacheRoot = resolve('node_modules/.cache')
  await mkdir(cacheRoot, { recursive: true })
  bundleRoot = await mkdtemp(join(cacheRoot, 'orca-codemode-lib-e2e-'))
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
  crm = await fakeCrmServerSpec()
}, 30_000)
afterAll(() => rm(bundleRoot, { recursive: true, force: true }))

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codemode-lib-e2e-')))
  await mkdir(join(root, '.orca'))
  await writeFile(
    join(root, '.orca', 'mcp.json'),
    JSON.stringify({ mcpServers: { 'fake-crm': crm } })
  )
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  await Promise.all(services.splice(0).map((service) => service.stop()))
  await rm(root, { recursive: true, force: true })
})

/** A chat in a new service (a new Orca session) over the same root and home; records its cards. */
async function agent(
  mode: GateMode,
  cards: Card[],
  policy: (title: string) => Decision = () => 'allow_once'
): Promise<Client> {
  // The home must differ from the root, or the root has no project scope.
  const service = new CodemodeService({ workerPath, log: () => {}, libHomeDir: join(root, 'home') })
  services.push(service)
  const [server] = (await service.launchServer({
    sessionId: `s${services.length}`,
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
    const title = request.params.message.split('\n')[0]
    cards.push({ title, personOnly: request.params._meta?.['orca/personOnly'] === true })
    return { action: 'accept', content: { decision: policy(title) } }
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

async function writeFn(name: string, body: string, params = ''): Promise<void> {
  const dir = join(root, '.orca', 'lib')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${name}.js`),
    `/**\n * @name ${name}\n * @description Test function.\n${params} */\nasync function ${name}(args) {\n${body}\n}\n`
  )
}

const SOURCE = `/**
 * @name addCreditsByEmail
 * @description Find a user by email and add credits.
 * @param {string} email
 * @param {number} amount
 */
async function addCreditsByEmail({ email, amount }) {
  const crm = mcp['fake-crm']
  const user = JSON.parse(await crm.find_user({ email }))
  await crm.add_credits({ user_id: user.id, amount })
  return user.id
}
`

describe('lib.* end to end in the real worker', () => {
  it('saved in one session, called in the next', async () => {
    const first: Card[] = []
    const one = await agent('full-access', first)
    const saved = await runJs(
      one,
      `return await lib.save({ name: 'addCreditsByEmail', description: 'Find a user by email and add credits.', source: ${JSON.stringify(SOURCE)} })`
    )
    expect(saved.isError).toBe(false)
    expect(first.filter((card) => card.personOnly)).toHaveLength(1)
    expect(first[0].title).toContain('addCreditsByEmail')

    const second: Card[] = []
    const two = await agent('full-access', second)
    const result = await runJs(
      two,
      `return await lib.addCreditsByEmail({ email: 'x@y.com', amount: 10 })`
    )
    expect(result).toEqual({ text: '=> "u1"', isError: false })
    expect(second).toEqual([])
    expect(await credits(two)).toBe(10)
  })

  it('cloned function shows the trust card once', async () => {
    await writeFn('cloned', 'return 7')
    const cards: Card[] = []
    const client = await agent('full-access', cards)
    expect(await runJs(client, 'return await lib.cloned({})')).toEqual({
      text: '=> 7',
      isError: false
    })
    expect(cards).toHaveLength(1)
    expect(cards[0].personOnly).toBe(true)
    expect(cards[0].title).toContain('cloned')
    expect((await runJs(client, 'return await lib.cloned({})')).text).toBe('=> 7')
    expect(cards).toHaveLength(1)
  })

  it('the gate applies inside functions', async () => {
    await writeFn(
      'grant',
      `  const crm = mcp['fake-crm']\n  await crm.add_credits({ user_id: 'u1', amount: 5 })\n  return 'granted'`
    )
    const cards: Card[] = []
    const client = await agent('ask', cards, (title) =>
      title.startsWith('Call fake-crm.add_credits') ? 'deny' : 'allow_once'
    )
    const denied = await runJs(client, 'return await lib.grant({})')
    expect(denied.isError).toBe(true)
    expect(denied.text).toContain('mcp.fake-crm.add_credits: denied by user')
    expect(cards.map((card) => card.title)).toContain('Call fake-crm.add_credits')
    expect(await credits(client)).toBe(0)
  })

  it('recursion and nesting fail cleanly in the real worker', async () => {
    await writeFn('loop', 'return await lib.loop({})')
    const deep = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    for (const n of deep) {
      await writeFn(`d${n}`, n === 9 ? 'return 1' : `return await lib.d${n + 1}({})`)
    }
    const client = await agent('full-access', [])
    const recursion = await runJs(client, 'return await lib.loop({})')
    expect(recursion.isError).toBe(true)
    expect(recursion.text).toContain('lib recursion')
    const nesting = await runJs(client, 'return await lib.d1({})')
    expect(nesting.isError).toBe(true)
    expect(nesting.text).toContain('lib nesting limit 8 reached')
  })
})
