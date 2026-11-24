import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { renderMcpContent } from './codemode-mcp-content'
import { CodemodeMcpPool, type CodemodeServerSpec } from './codemode-mcp-pool'
import { fakeCrmServerSpec } from './testing/fake-crm-command'

let spec: CodemodeServerSpec
beforeAll(async () => {
  spec = { name: 'fake-crm', ...(await fakeCrmServerSpec()), source: 'orca' }
}, 30_000)

const pools: CodemodeMcpPool[] = []
function makePool(approve: (s: CodemodeServerSpec) => Promise<boolean> = async () => true) {
  const pool = new CodemodeMcpPool([spec], {
    cwd: process.cwd(),
    env: process.env,
    approveStart: approve
  })
  pools.push(pool)
  return pool
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()))
})
function expectGone(pids: number[]): void {
  if (process.platform === 'win32') {
    return
  }
  for (const pid of pids) {
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  }
}
const signal = () => new AbortController().signal

describe('CodemodeMcpPool', () => {
  it('lists servers without spawning anything', () => {
    const pool = makePool()
    expect(pool.names()).toEqual(['fake-crm'])
    expect(pool.list()).toEqual([{ server: 'fake-crm', tools: null }])
    expect(pool.startedCount()).toBe(0)
  })

  it('starts a server on describe and caches its tools', async () => {
    let asked = 0
    const pool = makePool(async () => {
      asked++
      return true
    })
    const tools = await pool.describe('fake-crm')
    expect(tools.map((t) => t.name)).toContain('add_credits')
    expect(pool.list()[0].tools).toContain('add_credits')
    await pool.describe('fake-crm')
    expect(pool.startedCount()).toBe(1)
    expect(asked).toBe(1)
  })

  it('round-trips calls against server state', async () => {
    const pool = makePool()
    await pool.call('fake-crm', 'add_credits', { user_id: 'u1', amount: 5 }, signal())
    await pool.call('fake-crm', 'add_credits', { user_id: 'u1', amount: 2 }, signal())
    const state = JSON.parse((await pool.call('fake-crm', 'get_state', {}, signal())).text)
    expect(state[0].credits).toBe(7)
  })

  it('rejects an unapproved start and an unknown server', async () => {
    const pool = makePool(async () => false)
    await expect(pool.call('fake-crm', 'get_state', {}, signal())).rejects.toThrow(
      'start of server fake-crm was not approved'
    )
    expect(pool.startedCount()).toBe(0)
    await expect(pool.describe('nope')).rejects.toThrow('unknown MCP server nope; known: fake-crm')
  })

  it('turns isError results into rejections', async () => {
    const pool = makePool()
    await expect(
      pool.call('fake-crm', 'find_user', { email: 'none@y.com' }, signal())
    ).rejects.toThrow('no user none@y.com')
  })

  it('restarts a crashed server at most once per turn', async () => {
    const pool = makePool()
    await expect(pool.call('fake-crm', 'crash', {}, signal())).rejects.toThrow(/boom/)
    await expect(pool.call('fake-crm', 'crash', {}, signal())).rejects.toThrow(/boom/)
    expect(pool.startedCount()).toBe(2)
    await expect(pool.call('fake-crm', 'get_state', {}, signal())).rejects.toThrow(
      /server fake-crm failed:/
    )
    expect(pool.startedCount()).toBe(2)
    pool.newTurn()
    expect((await pool.call('fake-crm', 'get_state', {}, signal())).text).toContain('u1')
    expect(pool.startedCount()).toBe(3)
  }, 30_000)

  it('cancels a request through the abort signal', async () => {
    const pool = makePool()
    await pool.describe('fake-crm')
    const controller = new AbortController()
    controller.abort()
    await expect(pool.call('fake-crm', 'get_state', {}, controller.signal)).rejects.toThrow()
  })

  it('shares one approval and one start between concurrent first calls', async () => {
    let asked = 0
    const pool = makePool(async () => {
      asked++
      return true
    })
    await Promise.all([
      pool.call('fake-crm', 'get_state', {}, signal()),
      pool.call('fake-crm', 'get_state', {}, signal())
    ])
    expect(asked).toBe(1)
    expect(pool.startedCount()).toBe(1)
    const pids = pool.pids()
    await pool.close()
    expectGone(pids)
  })

  it('close() during an in-flight start leaves no child, and later calls reject', async () => {
    const pool = makePool()
    const inFlight = pool.call('fake-crm', 'get_state', {}, signal()).catch(() => null)
    await pool.close()
    await inFlight
    expectGone(pool.pids())
    await expect(pool.call('fake-crm', 'get_state', {}, signal())).rejects.toThrow(
      'MCP pool is closed'
    )
    await expect(pool.describe('fake-crm')).rejects.toThrow('MCP pool is closed')
    expect(pool.startedCount()).toBeLessThanOrEqual(1)
  })

  it('close() leaves no child processes', async () => {
    const pool = makePool()
    await pool.describe('fake-crm')
    const pids = pool.pids()
    expect(pids).toHaveLength(1)
    await pool.close()
    if (process.platform !== 'win32') {
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      }
    }
  })
})

describe('renderMcpContent', () => {
  it('joins text and replaces binary content with placeholders', () => {
    const out = renderMcpContent([
      { type: 'text', text: 'a' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'audio', mimeType: 'audio/wav', data: 'AAAAAAAA' },
      { type: 'resource', resource: { uri: 'file:///x', mimeType: 'text/plain', text: 'body' } }
    ])
    expect(out).toBe('a\n[image image/png 3 bytes]\n[audio audio/wav 6 bytes]\nbody')
  })
})
