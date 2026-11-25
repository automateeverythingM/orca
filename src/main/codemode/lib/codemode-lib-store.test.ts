import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodemodeLibStore, libTrustKey } from './codemode-lib-store'

// Pass-through, so a test can see which files the store reads.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const fn = (name: string, extra = ''): string =>
  `async function ${name}({ a }) { return a${extra} }\n`
const described = (name: string): string =>
  `/**\n * @name ${name}\n * @description d\n * @saved-by user\n */\n${fn(name)}`

let root: string
let home: string
let store: CodemodeLibStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lib-root-'))
  home = await mkdtemp(join(tmpdir(), 'lib-home-'))
  store = new CodemodeLibStore({ projectRoot: root, homeDir: home })
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

const base = { scope: 'project' as const, description: 'does a thing', savedBy: 'agent' as const }

describe('CodemodeLibStore', () => {
  it('save writes the file with a rebuilt header and returns it', async () => {
    const saved = await store.save({ ...base, name: 'foo', source: fn('foo') })
    const text = await readFile(join(root, '.orca', 'lib', 'foo.js'), 'utf8')
    expect(text.startsWith('/**')).toBe(true)
    expect(text).toContain('@saved-by agent')
    expect(saved).toMatchObject({ name: 'foo', scope: 'project', savedBy: 'agent' })
    expect(saved.source).toBe(text)
    expect((await store.get('foo'))?.source).toBe(text)
    expect((await store.get('foo'))?.description).toBe('does a thing')
  })

  it('save copies the old version to .history', async () => {
    await store.save({ ...base, name: 'foo', source: fn('foo', ' + 1') })
    await store.save({ ...base, name: 'foo', source: fn('foo', ' + 2') })
    const hist = await store.history('foo', 'project')
    expect(hist).toHaveLength(1)
    expect(await store.readVersion('foo', 'project', hist[0].version)).toContain('a + 1')
  })

  it('save requires a description', async () => {
    await expect(
      store.save({ name: 'foo', source: fn('foo'), scope: 'project', savedBy: 'user' })
    ).rejects.toThrow('lib.save needs a description')
  })

  it('save requires the source to define the function', async () => {
    await expect(store.save({ ...base, name: 'foo', source: fn('bar') })).rejects.toThrow(
      'source must define function foo'
    )
  })

  it('rejects unsafe names', async () => {
    for (const name of ['../x', 'a/b', 'save', '1abc', 'lib', 'await', 'yield', 'let']) {
      await expect(store.save({ ...base, name, source: fn(name) })).rejects.toThrow()
      await expect(store.read(name, 'project')).rejects.toThrow()
    }
    expect(await readdir(root)).toEqual([])
    expect(await readdir(home)).toEqual([])
  })

  it('project shadows global', async () => {
    await store.save({ ...base, scope: 'global', name: 'foo', source: fn('foo') })
    await store.save({ ...base, name: 'foo', source: fn('foo') })
    const { functions } = await store.list()
    expect(functions).toHaveLength(1)
    expect(functions[0].scope).toBe('project')
    expect((await store.get('foo'))?.scope).toBe('project')
  })

  it('skips malformed files with a problem', async () => {
    const dir = join(root, '.orca', 'lib')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'ok.js'), described('ok'))
    await writeFile(join(dir, 'wrong.js'), described('other'))
    await writeFile(join(dir, 'big.js'), `${described('big')}//${'x'.repeat(256 * 1024)}\n`)
    await writeFile(join(dir, 'bare.js'), fn('bare'))
    const { functions, problems } = await store.list()
    expect(functions.map((f) => f.name)).toEqual(['ok'])
    expect(problems).toHaveLength(3)
    for (const f of ['wrong.js', 'big.js', 'bare.js']) {
      expect(problems.some((p) => p.includes(f))).toBe(true)
    }
  })

  it('never reads an oversized file', async () => {
    const dir = join(root, '.orca', 'lib')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'big.js'), `${described('big')}//${'x'.repeat(256 * 1024)}\n`)
    vi.mocked(readFile).mockClear()
    const { problems } = await store.list()
    await expect(store.read('big', 'project')).rejects.toThrow('over the size limit')
    expect(problems).toEqual([expect.stringContaining('big.js: file is over the size limit')])
    const paths = vi.mocked(readFile).mock.calls.map(([file]) => String(file))
    expect(paths.filter((file) => file.endsWith('big.js'))).toEqual([])
  })

  it('remove keeps the last version in history', async () => {
    await store.save({ ...base, name: 'foo', source: fn('foo') })
    await store.remove('foo', 'project')
    expect(await store.get('foo')).toBeNull()
    expect(await store.history('foo', 'project')).toHaveLength(1)
  })

  it('move fails when the target scope has the name', async () => {
    await store.save({ ...base, name: 'foo', source: fn('foo') })
    await store.save({ ...base, scope: 'global', name: 'foo', source: fn('foo') })
    await expect(store.move('foo', 'project')).rejects.toThrow('already exists')
    await store.remove('foo', 'global')
    const { from, to } = await store.move('foo', 'project')
    expect(from.scope).toBe('project')
    expect(to.scope).toBe('global')
    expect(await store.read('foo', 'project')).toBeNull()
  })

  it('history is newest first and readVersion rejects bad versions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await store.save({ ...base, name: 'foo', source: fn('foo', ' + 1') })
    await store.save({ ...base, name: 'foo', source: fn('foo', ' + 2') })
    vi.setSystemTime(Date.now() + 5000)
    await store.save({ ...base, name: 'foo', source: fn('foo', ' + 3') })
    const hist = await store.history('foo', 'project')
    expect(hist).toHaveLength(2)
    expect(hist[0].savedAt).toBeGreaterThan(hist[1].savedAt)
    await expect(store.readVersion('foo', 'project', '../../x')).rejects.toThrow('invalid version')
  })

  it('two saves in the same millisecond keep both versions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    for (const n of [1, 2, 3, 4]) {
      await store.save({ ...base, name: 'foo', source: fn('foo', ` + ${n}`) })
    }
    const hist = await store.history('foo', 'project')
    expect(hist.map((h) => h.version.slice(19))).toEqual(['-2', '-1', ''])
    expect(new Set(hist.map((h) => h.savedAt)).size).toBe(1)
    const texts = await Promise.all(hist.map((h) => store.readVersion('foo', 'project', h.version)))
    expect(texts.map((t) => /a \+ (\d)/.exec(t)?.[1])).toEqual(['3', '2', '1'])
    await expect(store.readVersion('foo', 'project', `${hist[2].version}-x`)).rejects.toThrow(
      'invalid version'
    )
  })

  it('move keeps params, description and saved-by', async () => {
    const src = `/**\n * @name foo\n * @description d\n * @param {string} a The a\n * @param b\n * @saved-by learn\n */\n${fn('foo')}`
    await store.save({ ...base, name: 'foo', source: src, savedBy: 'learn' })
    const before = await store.read('foo', 'project')
    const { from, to: moved } = await store.move('foo', 'project')
    expect(from.source).toBe(before?.source)
    expect(moved.params).toEqual([
      { name: 'a', type: 'string', description: 'The a' },
      { name: 'b' }
    ])
    expect(moved).toMatchObject({ description: 'does a thing', savedBy: 'learn', scope: 'global' })
    expect(moved.source).toBe(before?.source)
  })

  it('refuses symlinked function files', async () => {
    const dir = join(root, '.orca', 'lib')
    await mkdir(dir, { recursive: true })
    await writeFile(join(root, 'real.js'), described('lnk'))
    await symlink(join(root, 'real.js'), join(dir, 'lnk.js'))
    expect(await store.get('lnk')).toBeNull()
    expect(await store.read('lnk', 'project')).toBeNull()
    const { functions, problems } = await store.list()
    expect(functions).toEqual([])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('lnk.js')
  })

  it('libTrustKey is ~ for global and the realpath for project', async () => {
    expect(await libTrustKey('global', root)).toBe('~')
    expect(await libTrustKey('project', root)).toMatch(/lib-root-/)
  })
})
