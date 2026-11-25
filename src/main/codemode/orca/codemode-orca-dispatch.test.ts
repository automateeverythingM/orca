import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import {
  defineMethod,
  defineStreamingMethod,
  type RpcAnyMethodDeclaration
} from '../../runtime/rpc/core'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { CONNECTOR_SLACK_MIRROR_METHODS } from '../../runtime/rpc/methods/connectors/connector-slack-mirror'
import { CODEMODE_LIMITS } from '../codemode-limits'
import type { GateMode } from '../gate/codemode-gate'
import {
  type ApprovalDecision,
  type ApprovalRequest,
  CodemodeSession
} from '../host/codemode-run-host'
import { createOrcaRpcAccess, type OrcaRpcAccess } from './codemode-orca-dispatch'

// Runs QuickJS in-process: the worker only relays host calls, and this test is about the host side.
vi.mock('../sandbox/codemode-worker-run', async () => {
  const { runScript } = await import('../sandbox/codemode-script-runner')
  return { runScriptInWorker: runScript }
})

const METHODS: RpcAnyMethodDeclaration[] = [
  defineMethod({
    name: 'worktree.list',
    permission: 'workspace',
    params: z.object({ limit: z.number().optional() }),
    handler: (params, ctx) => ({
      params,
      caller: ctx.caller?.kind ?? null,
      agentSessionId: ctx.orchestrationCompatibilityEvidence?.agentSessionId ?? null
    })
  }),
  defineMethod({
    name: 'worktree.current',
    permission: 'workspace',
    params: null,
    handler: (params) => ({ params: params === undefined ? 'none' : params })
  }),
  defineMethod({
    name: 'worktree.rename',
    permission: 'workspace',
    params: z.object({ name: z.string() }),
    handler: (params) => {
      if (params.name === 'taken') {
        throw new Error('name taken')
      }
      return { renamed: params.name }
    }
  }),
  defineMethod({
    name: 'worktree.remove',
    permission: 'workspace',
    params: z.object({ id: z.string() }),
    handler: (params) => ({ removed: params.id })
  }),
  defineStreamingMethod({
    name: 'terminal.subscribe',
    permission: 'workspace',
    params: null,
    handler: async (_params, _ctx, emit) => emit('tick')
  }),
  defineMethod({
    name: 'codemode.status',
    permission: 'workspace',
    params: null,
    handler: () => 'internal'
  }),
  ...CONNECTOR_SLACK_MIRROR_METHODS
]

let root: string
let mode: GateMode
let requests: { method: string; params?: unknown }[]
let asks: ApprovalRequest[]
let answer: ApprovalDecision
const sessions: CodemodeSession[] = []

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codemode-orca-')))
  mode = 'full-access'
  requests = []
  asks = []
  answer = 'allow_once'
})
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  await rm(root, { recursive: true, force: true })
})

function orcaAccess(context?: () => { worktreeId?: string }): OrcaRpcAccess {
  const dispatcher = new RpcDispatcher({ runtime: new OrcaRuntimeService(null), methods: METHODS })
  return createOrcaRpcAccess({
    methods: METHODS,
    dispatch: (request, options) => {
      requests.push(request)
      return dispatcher.dispatch(request, options)
    },
    sessionId: 's1',
    root,
    ...(context ? { context } : {})
  })
}

function session(orca: OrcaRpcAccess | null = orcaAccess()) {
  const created = new CodemodeSession({
    sessionId: 's1',
    root,
    env: process.env,
    mode: () => mode,
    trusted: () => false,
    specs: [],
    limits: CODEMODE_LIMITS,
    onEvent: () => {},
    ...(orca ? { orca } : {})
  })
  sessions.push(created)
  const connection = {}
  const approver = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
    asks.push(request)
    return answer
  }
  return async (code: string): Promise<unknown> => {
    const { text, isError } = await created.run(code, {
      signal: new AbortController().signal,
      approver,
      connection
    })
    const body = text.replace(/\nInner calls:\n[\s\S]*$/, '')
    if (isError || !body.startsWith('=> ')) {
      throw new Error(body)
    }
    const value = body.slice(3)
    return value === 'undefined' ? undefined : JSON.parse(value)
  }
}

const COLLECT = `const out = []
  const attempt = async (fn) => { try { out.push(await fn()) } catch (e) { out.push(e.message) } }`

describe('orca.* in scripts', () => {
  it('dispatches as the local agent CLI with the chat session as evidence', async () => {
    const run = session()
    expect(await run('return await orca.worktree.list({})')).toEqual({
      params: {},
      caller: 'local-cli',
      agentSessionId: 's1'
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('worktree.list')
  })

  it('reaches an owner-only handler as an agent, which refuses it', async () => {
    const run = session()
    const code = `${COLLECT}
      await attempt(() => orca.connector.slackMirror.set({ sessionId: 'x', on: true }))
      return out`
    expect(await run(code)).toEqual(['Only the owner can change what posts to Slack'])
    expect(requests.map((request) => request.method)).toEqual(['connector.slackMirror.set'])
  })

  it('refuses unknown, excluded and streaming names without dispatching', async () => {
    const run = session()
    const code = `${COLLECT}
      await attempt(() => orca.x.y())
      await attempt(() => orca.codemode.status())
      await attempt(() => orca.terminal.subscribe())
      return out`
    expect(await run(code)).toEqual([
      'x.y is not available in code mode',
      'codemode.status is not available in code mode',
      'terminal.subscribe is not available in code mode'
    ])
    expect(requests).toEqual([])
  })

  it('validates params before dispatch; a null schema takes none', async () => {
    const run = session()
    const code = `${COLLECT}
      await attempt(() => orca.worktree.rename({ name: 5 }))
      await attempt(() => orca.worktree.current({ a: 1 }))
      await attempt(() => orca.worktree.current({}))
      await attempt(() => orca.worktree.current())
      await attempt(() => orca.call('worktree.current', null))
      return out`
    const [invalid, extra, ...accepted] = await run(code).then((value) =>
      z.array(z.unknown()).parse(value)
    )
    expect(invalid).toBe('Invalid input: expected string, received number')
    expect(extra).toBe('worktree.current takes no params')
    expect(accepted).toEqual([{ params: 'none' }, { params: 'none' }, { params: 'none' }])
    expect(requests.map((request) => [request.method, request.params])).toEqual([
      ['worktree.current', undefined],
      ['worktree.current', undefined],
      ['worktree.current', undefined]
    ])
  })

  it("throws the dispatcher's error message in the script", async () => {
    const run = session()
    const code = `try { await orca.worktree.rename({ name: 'taken' }) } catch (e) { return e instanceof Error ? e.message : 'not an Error' }`
    expect(await run(code)).toBe('name taken')
  })

  it('ask mode: allow_session covers a write, never a destructive call', async () => {
    mode = 'ask'
    answer = 'allow_session'
    const run = session()
    await run(
      `await orca.worktree.rename({ name: 'a' }); await orca.worktree.rename({ name: 'b' })`
    )
    expect(asks.map((ask) => ask.title)).toEqual(['Orca: worktree.rename'])
    expect(JSON.parse(asks[0]?.detail ?? '')).toEqual({ name: 'a' })
    await run(`await orca.worktree.remove({ id: 'w' }); await orca.worktree.remove({ id: 'w' })`)
    expect(asks.map((ask) => ask.title)).toEqual([
      'Orca: worktree.rename',
      'Orca: worktree.remove',
      'Orca: worktree.remove'
    ])
    // The destructive card explains why "Allow for this session" did not stick.
    const destructive = asks[1]?.detail ?? ''
    expect(destructive.startsWith('This asks every time.\n')).toBe(true)
    expect(JSON.parse(destructive.slice('This asks every time.\n'.length))).toEqual({ id: 'w' })
    expect(asks[0]?.detail.startsWith('This asks')).toBe(false)
    expect(requests).toHaveLength(4)
  })

  it('full-access runs a write without asking and still asks for a destructive call', async () => {
    const run = session()
    expect(await run(`return await orca.worktree.rename({ name: 'a' })`)).toEqual({ renamed: 'a' })
    expect(asks).toEqual([])
    expect(await run(`return await orca.worktree.remove({ id: 'w' })`)).toEqual({ removed: 'w' })
    expect(asks.map((ask) => ask.title)).toEqual(['Orca: worktree.remove'])
  })

  it('read-only runs a read and refuses a write', async () => {
    mode = 'read-only'
    const run = session()
    const code = `${COLLECT}
      await attempt(async () => (await orca.worktree.list({})).caller)
      await attempt(() => orca.worktree.rename({ name: 'a' }))
      return out`
    expect(await run(code)).toEqual(['local-cli', 'not allowed in this chat mode'])
    expect(asks).toEqual([])
    expect(requests.map((request) => request.method)).toEqual(['worktree.list'])
  })

  it('answers areas, describe and context', async () => {
    const run = session(orcaAccess(() => ({ worktreeId: 'wt-1' })))
    const code = `return {
      areas: await orca.areas(),
      described: (await orca.describe('worktree.current'))[0],
      context: await orca.context()
    }`
    expect(await run(code)).toEqual({
      areas: ['connector', 'worktree'],
      described: { method: 'worktree.current', label: 'read', params: null },
      context: { sessionId: 's1', root, worktreeId: 'wt-1' }
    })
  })

  it('fails every orca call when the chat has no Orca access', async () => {
    const run = session(null)
    const code = `${COLLECT}
      await attempt(() => orca.areas())
      await attempt(() => orca.worktree.list({}))
      return out`
    expect(await run(code)).toEqual([
      'Orca actions are not available in this chat',
      'Orca actions are not available in this chat'
    ])
  })
})
