import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLibRecords,
  type CodemodeLibRecords
} from '../../../../codemode/lib/codemode-lib-access'
import { CodemodeLibStore, libTrustKey } from '../../../../codemode/lib/codemode-lib-store'
import { libSourceHash } from '../../../../codemode/lib/codemode-lib-trust'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { codemodeLibMethods, requireKnownProject, type CodemodeLibMethodDeps } from './codemode-lib'

const fn = (name: string, extra = ''): string =>
  `async function ${name}({ a }) { return a${extra} }\n`

let root: string
let home: string
let records: CodemodeLibRecords
let store: CodemodeLibStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lib-rpc-root-'))
  home = await mkdtemp(join(tmpdir(), 'lib-rpc-home-'))
  records = createLibRecords(home)
  store = new CodemodeLibStore({ projectRoot: root, homeDir: home })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

const save = (name: string, scope: 'project' | 'global', extra = '') =>
  store.save({ name, scope, source: fn(name, extra), description: 'does it', savedBy: 'agent' })

function methodsFor(deps: Partial<CodemodeLibMethodDeps> = {}) {
  const methods = codemodeLibMethods({
    desktop: () => true,
    records: async () => records,
    projectAccess: async (_ctx, projectRoot) => {
      if (projectRoot !== root) {
        throw new Error('unknown project')
      }
    },
    ...deps
  })
  const ctx: RpcContext = { runtime: new OrcaRuntimeService(null) }
  const call = async (name: string, params: unknown): Promise<unknown> => {
    const method = eraseRpcMethods(methods).find((m) => m.name === name)
    if (!method) {
      throw new Error(`no method ${name}`)
    }
    // The dispatcher parses params before a handler runs; do the same here.
    return await method.handler(method.params?.parse(params), ctx)
  }
  return { call }
}

describe('codemode.lib.* RPC methods', () => {
  it('lists project and global with usage and trust', async () => {
    const project = await save('shared', 'project')
    await save('shared', 'global')
    const onlyGlobal = await save('tidy', 'global')
    await writeFile(join(root, '.orca', 'lib', 'broken.js'), 'not a function')
    const projectKey = await libTrustKey('project', root)
    await records.trust.record(projectKey, 'shared', project.source)
    await records.trust.record('~', 'tidy', `${onlyGlobal.source}// edited`)
    await records.usage.recordUse(projectKey, 'shared', 1_000)
    await records.usage.recordUse(projectKey, 'shared', 2_000)

    const { call } = methodsFor()
    const listed = await call('codemode.lib.list', { projectRoot: root })
    expect(listed).toEqual({
      functions: [
        {
          name: 'shared',
          description: 'does it',
          params: [],
          savedBy: 'agent',
          scope: 'project',
          uses: 2,
          lastUsedAt: 2_000,
          trusted: true,
          shadowed: false,
          sha256: libSourceHash(project.source)
        },
        expect.objectContaining({ name: 'shared', scope: 'global', uses: 0, shadowed: true }),
        expect.objectContaining({ name: 'tidy', scope: 'global', trusted: false, shadowed: false })
      ],
      problems: [expect.stringContaining('broken.js')]
    })
    // Without a project only global functions show, and none is shadowed.
    const globalOnly = await call('codemode.lib.list', {})
    expect(globalOnly).toMatchObject({
      functions: [
        { name: 'shared', scope: 'global', shadowed: false },
        { name: 'tidy', scope: 'global' }
      ],
      problems: []
    })
  })

  it('refuses unknown project root', async () => {
    await save('secret', 'project')
    let looked = false
    const { call } = methodsFor({
      records: async () => {
        looked = true
        return records
      }
    })
    for (const projectRoot of [join(root, '..', 'elsewhere'), `${root}/../${root}`, '/']) {
      await expect(call('codemode.lib.list', { projectRoot })).rejects.toThrow('unknown project')
      await expect(
        call('codemode.lib.read', { name: 'secret', scope: 'project', projectRoot })
      ).rejects.toThrow('unknown project')
    }
    expect(looked).toBe(false)
  })

  it('checks a project root against the managed worktrees', async () => {
    const list = async () => ({ worktrees: [{ path: '/repo/a' }, { path: '/repo/b' }] })
    await expect(requireKnownProject(list, '/repo/b')).resolves.toBeUndefined()
    await expect(requireKnownProject(list, '/repo/a/../b')).rejects.toThrow('unknown project')
    await expect(requireKnownProject(list, '/repo')).rejects.toThrow('unknown project')
  })

  it('refuses a worktree that lives on another host', async () => {
    const list = async () => ({
      worktrees: [
        { path: '/repo/local', hostId: 'local' },
        { path: '/repo/legacy' },
        { path: '/repo/remote', hostId: 'ssh:box' },
        { path: '/repo/paired', hostId: 'runtime:env-1' }
      ]
    })
    await expect(requireKnownProject(list, '/repo/local')).resolves.toBeUndefined()
    await expect(requireKnownProject(list, '/repo/legacy')).resolves.toBeUndefined()
    await expect(requireKnownProject(list, '/repo/remote')).rejects.toThrow('unknown project')
    await expect(requireKnownProject(list, '/repo/paired')).rejects.toThrow('unknown project')
  })

  it('reads the current source and a past version', async () => {
    await save('f', 'project', ' + 1')
    const current = await save('f', 'project', ' + 2')
    const { call } = methodsFor()
    const history = await call('codemode.lib.history', {
      name: 'f',
      scope: 'project',
      projectRoot: root
    })
    expect(history).toEqual({
      versions: [{ version: expect.any(String), savedAt: expect.any(Number) }]
    })
    const [{ version }] = await store.history('f', 'project')
    expect(history).toEqual({ versions: [{ version, savedAt: expect.any(Number) }] })
    expect(
      await call('codemode.lib.read', { name: 'f', scope: 'project', projectRoot: root })
    ).toEqual({ source: current.source, sha256: libSourceHash(current.source) })
    const old = await call('codemode.lib.read', {
      name: 'f',
      scope: 'project',
      version,
      projectRoot: root
    })
    expect(old).toEqual({ source: expect.stringContaining('a + 1'), sha256: expect.any(String) })
  })

  it('read rejects a bad version', async () => {
    await save('f', 'project')
    const { call } = methodsFor()
    for (const version of ['../../f', 'x', '1/2']) {
      await expect(
        call('codemode.lib.read', { name: 'f', scope: 'project', version, projectRoot: root })
      ).rejects.toThrow('invalid version')
    }
    await expect(call('codemode.lib.read', { name: 'missing', scope: 'global' })).rejects.toThrow(
      'no function missing in global scope'
    )
  })

  it('delete keeps history and forgets trust', async () => {
    const saved = await save('f', 'project')
    const key = await libTrustKey('project', root)
    await records.trust.record(key, 'f', saved.source)
    const { call } = methodsFor()
    expect(
      await call('codemode.lib.delete', { name: 'f', scope: 'project', projectRoot: root })
    ).toEqual({})
    await expect(stat(join(root, '.orca', 'lib', 'f.js'))).rejects.toThrow()
    const history = await store.history('f', 'project')
    expect(history).toHaveLength(1)
    expect(await store.readVersion('f', 'project', history[0].version)).toBe(saved.source)
    expect(await records.trust.state(key, 'f', saved.source)).toBe('unknown')
  })

  it('move keeps a trusted function trusted under the new key and forgets the old', async () => {
    const saved = await save('f', 'project')
    const projectKey = await libTrustKey('project', root)
    await records.trust.record(projectKey, 'f', saved.source)
    const { call } = methodsFor()
    const moved = await call('codemode.lib.move', { name: 'f', from: 'project', projectRoot: root })
    expect(moved).toMatchObject({ name: 'f', scope: 'global', trusted: true, shadowed: false })
    const text = await readFile(join(home, '.orca', 'lib', 'f.js'), 'utf8')
    expect(await records.trust.state('~', 'f', text)).toBe('trusted')
    expect(await records.trust.state(projectKey, 'f', saved.source)).toBe('unknown')
  })

  it('moving an untrusted function leaves it untrusted at the new scope', async () => {
    const saved = await save('f', 'project')
    const projectKey = await libTrustKey('project', root)
    // Allowed once, then edited on disk: changed, so not trusted.
    await records.trust.record(projectKey, 'f', `${saved.source}// before`)
    const { call } = methodsFor()
    const moved = await call('codemode.lib.move', { name: 'f', from: 'project', projectRoot: root })
    expect(moved).toMatchObject({ name: 'f', scope: 'global', trusted: false })
    const text = await readFile(join(home, '.orca', 'lib', 'f.js'), 'utf8')
    expect(await records.trust.state('~', 'f', text)).toBe('unknown')
    expect(await records.trust.state(projectKey, 'f', `${saved.source}// before`)).toBe('unknown')
  })

  it('move refuses an existing target', async () => {
    await save('f', 'project')
    await save('f', 'global')
    const { call } = methodsFor()
    await expect(
      call('codemode.lib.move', { name: 'f', from: 'project', projectRoot: root })
    ).rejects.toThrow('f already exists in global scope')
    await expect(call('codemode.lib.move', { name: 'f', from: 'global' })).rejects.toThrow(
      'no project root for project scope'
    )
  })

  it('trust records the file the person viewed as allowed', async () => {
    const saved = await save('big', 'project')
    const key = await libTrustKey('project', root)
    const { call } = methodsFor()
    const target = { name: 'big', scope: 'project', projectRoot: root }
    const viewed = await call('codemode.lib.read', target)
    expect(viewed).toEqual({ source: saved.source, sha256: libSourceHash(saved.source) })
    expect(await records.trust.state(key, 'big', saved.source)).toBe('unknown')
    expect(
      await call('codemode.lib.trust', { ...target, sha256: libSourceHash(saved.source) })
    ).toEqual({})
    expect(await records.trust.state(key, 'big', saved.source)).toBe('trusted')
    await expect(
      call('codemode.lib.trust', { ...target, name: 'gone', sha256: libSourceHash('x') })
    ).rejects.toThrow('no function gone in project scope')
  })

  it('trust refuses a stale hash and records nothing', async () => {
    const before = await save('big', 'project', ' + 1')
    const after = await save('big', 'project', ' + 2')
    const key = await libTrustKey('project', root)
    const { call } = methodsFor()
    await expect(
      call('codemode.lib.trust', {
        name: 'big',
        scope: 'project',
        projectRoot: root,
        sha256: libSourceHash(before.source)
      })
    ).rejects.toThrow('function changed since you viewed it; open it again')
    expect(await records.trust.state(key, 'big', after.source)).toBe('unknown')
    expect(await records.trust.state(key, 'big', before.source)).toBe('unknown')
  })

  it('works only in the desktop app', async () => {
    const { call } = methodsFor({ desktop: () => false })
    await expect(call('codemode.lib.list', {})).rejects.toThrow(
      'code mode is only available in the desktop app'
    )
  })

  it('refuses unsafe names before any file access', async () => {
    const { call } = methodsFor()
    for (const name of ['../x', 'a/b', '']) {
      await expect(call('codemode.lib.read', { name, scope: 'global' })).rejects.toThrow()
    }
  })
})
