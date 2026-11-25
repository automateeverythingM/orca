import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodemodeLibStore } from './codemode-lib-store'

const SECRET = 'PRIVATE-KEY-BYTES-0451'
const fn = (name: string): string => `async function ${name}({ a }) { return a }\n`

let root: string
let home: string
let outside: string
let store: CodemodeLibStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lib-ln-root-'))
  home = await mkdtemp(join(tmpdir(), 'lib-ln-home-'))
  outside = await mkdtemp(join(tmpdir(), 'lib-ln-outside-'))
  await writeFile(join(outside, 'id_rsa'), SECRET)
  store = new CodemodeLibStore({ projectRoot: root, homeDir: home })
})
afterEach(async () => {
  for (const dir of [root, home, outside]) {
    await rm(dir, { recursive: true, force: true })
  }
})

const save = (name: string, scope: 'project' | 'global') =>
  store.save({ name, scope, source: fn(name), description: 'd', savedBy: 'user' })

/** Every regular file under both `.orca` dirs, read without following any symlink. */
async function libFileTexts(): Promise<string[]> {
  const texts: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile()) {
        texts.push(await readFile(path, 'utf8'))
      }
    }
  }
  await walk(join(root, '.orca'))
  await walk(join(home, '.orca'))
  return texts
}

async function expectNoSecretCopied(): Promise<void> {
  expect((await libFileTexts()).filter((text) => text.includes(SECRET))).toEqual([])
}

describe('CodemodeLibStore and symlinks', () => {
  it('delete refuses a symlinked function file and copies nothing', async () => {
    await mkdir(join(root, '.orca', 'lib'), { recursive: true })
    await symlink(join(outside, 'id_rsa'), join(root, '.orca', 'lib', 'deploy.js'))
    await expect(store.remove('deploy', 'project')).rejects.toThrow(
      'symlinked function files are not allowed'
    )
    expect((await lstat(join(root, '.orca', 'lib', 'deploy.js'))).isSymbolicLink()).toBe(true)
    await expectNoSecretCopied()
  })

  it('move to project refuses a symlinked target and copies nothing', async () => {
    await save('deploy', 'global')
    await mkdir(join(root, '.orca', 'lib'), { recursive: true })
    await symlink(join(outside, 'id_rsa'), join(root, '.orca', 'lib', 'deploy.js'))
    await expect(store.move('deploy', 'global')).rejects.toThrow(
      'deploy already exists in project scope'
    )
    expect(await readFile(join(home, '.orca', 'lib', 'deploy.js'), 'utf8')).toContain('deploy')
    await expectNoSecretCopied()
  })

  it('save refuses to write over a symlinked function file', async () => {
    await mkdir(join(root, '.orca', 'lib'), { recursive: true })
    await symlink(join(outside, 'id_rsa'), join(root, '.orca', 'lib', 'deploy.js'))
    await expect(save('deploy', 'project')).rejects.toThrow(
      'symlinked function files are not allowed'
    )
    expect(await readFile(join(outside, 'id_rsa'), 'utf8')).toBe(SECRET)
    await expectNoSecretCopied()
  })

  it('refuses a symlinked .history', async () => {
    await save('deploy', 'project')
    await symlink(outside, join(root, '.orca', 'lib', '.history'))
    await expect(save('deploy', 'project')).rejects.toThrow('symlinked lib directories')
    await expect(store.remove('deploy', 'project')).rejects.toThrow('symlinked lib directories')
    await expect(store.history('deploy', 'project')).rejects.toThrow('symlinked lib directories')
    await expect(store.readVersion('deploy', 'project', '20260101T000000000Z')).rejects.toThrow(
      'symlinked lib directories'
    )
    expect(await readdir(outside)).toEqual(['id_rsa'])
  })

  it('refuses a symlinked .orca/lib, and list reports it without failing', async () => {
    await save('tidy', 'global')
    await mkdir(join(outside, 'lib'))
    await writeFile(join(outside, 'lib', 'evil.js'), `/** @name evil */\n${fn('evil')}`)
    await mkdir(join(root, '.orca'))
    await symlink(join(outside, 'lib'), join(root, '.orca', 'lib'))
    await expect(store.read('evil', 'project')).rejects.toThrow('symlinked lib directories')
    await expect(store.remove('evil', 'project')).rejects.toThrow('symlinked lib directories')
    await expect(store.move('tidy', 'global')).rejects.toThrow('symlinked lib directories')
    const listed = await store.list()
    expect(listed.functions.map((f) => f.name)).toEqual(['tidy'])
    expect(listed.problems).toEqual([expect.stringContaining('symlinked lib directories')])
    expect(await readdir(join(outside, 'lib'))).toEqual(['evil.js'])
  })

  it('allows a symlinked .orca in the home dir (the person’s own dotfiles)', async () => {
    const dotfiles = await mkdtemp(join(tmpdir(), 'lib-ln-dotfiles-'))
    try {
      await symlink(dotfiles, join(home, '.orca'))
      await save('tidy', 'global')
      await save('tidy', 'global')
      expect((await store.read('tidy', 'global'))?.name).toBe('tidy')
      expect(await store.history('tidy', 'global')).toHaveLength(1)
      expect((await store.list()).problems).toEqual([])
      expect(await readdir(join(dotfiles, 'lib'))).toEqual(['.history', 'tidy.js'])
    } finally {
      await rm(dotfiles, { recursive: true, force: true })
    }
  })

  it('still refuses a symlinked lib or .history under a symlinked home .orca', async () => {
    const dotfiles = await mkdtemp(join(tmpdir(), 'lib-ln-dotfiles-'))
    try {
      await symlink(dotfiles, join(home, '.orca'))
      await symlink(outside, join(dotfiles, 'lib'))
      await expect(save('tidy', 'global')).rejects.toThrow('symlinked lib directories')
      await rm(join(dotfiles, 'lib'))
      await mkdir(join(dotfiles, 'lib'))
      await symlink(outside, join(dotfiles, 'lib', '.history'))
      await expect(store.history('tidy', 'global')).rejects.toThrow('symlinked lib directories')
      expect(await readdir(outside)).toEqual(['id_rsa'])
    } finally {
      await rm(dotfiles, { recursive: true, force: true })
    }
  })

  it('refuses a symlinked .orca in the project root, and list reports it', async () => {
    await mkdir(join(outside, 'lib'))
    await writeFile(join(outside, 'lib', 'evil.js'), `/** @name evil */\n${fn('evil')}`)
    await symlink(outside, join(root, '.orca'))
    await expect(store.read('evil', 'project')).rejects.toThrow('symlinked lib directories')
    await expect(save('tidy', 'project')).rejects.toThrow('symlinked lib directories')
    expect((await store.list()).problems).toEqual([
      expect.stringContaining('symlinked lib directories')
    ])
    expect(await readdir(join(outside, 'lib'))).toEqual(['evil.js'])
  })
})
