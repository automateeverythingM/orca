import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveInRoot } from './codemode-paths'

describe('resolveInRoot', () => {
  let base: string
  let root: string
  let outside: string

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'codemode-paths-')))
    root = join(base, 'root')
    outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
  })
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('treats parent traversal as outside', async () => {
    expect((await resolveInRoot(root, '../x')).inside).toBe(false)
    expect((await resolveInRoot(root, '../../etc/passwd')).inside).toBe(false)
  })

  it('treats an absolute path elsewhere as outside', async () => {
    expect((await resolveInRoot(root, outside)).inside).toBe(false)
  })

  it('treats a sibling sharing the root name prefix as outside', async () => {
    await mkdir(`${root}-evil`)
    expect((await resolveInRoot(root, `${root}-evil/a`)).inside).toBe(false)
  })

  it('treats a symlink inside the root that points outside as outside', async () => {
    await symlink(outside, join(root, 'link'), 'dir')
    expect((await resolveInRoot(root, 'link')).inside).toBe(false)
    expect((await resolveInRoot(root, 'link/new.txt')).inside).toBe(false)
  })

  it('accepts a nested path that does not exist yet', async () => {
    const result = await resolveInRoot(root, 'a/b/new.txt')
    expect(result).toEqual({ path: join(root, 'a/b/new.txt'), inside: true })
  })

  it('accepts the root itself and absolute paths under it', async () => {
    expect((await resolveInRoot(root, '.')).inside).toBe(true)
    expect((await resolveInRoot(root, join(root, 'x'))).inside).toBe(true)
  })
})
