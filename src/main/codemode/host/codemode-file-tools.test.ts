import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundledRipgrepCommand } from '../../ripgrep/bundled-ripgrep-path'
import {
  editFileTool,
  findTool,
  grepTool,
  readFileTool,
  writeFileTool
} from './codemode-file-tools'

const hasRg = spawnSync(bundledRipgrepCommand(), ['--version']).status === 0
const NO_RG = 'ripgrep unavailable: no bundled binary and no rg on PATH'

describe('codemode file tools', () => {
  let base: string
  let root: string
  let ctx: { root: string }

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'codemode-files-')))
    root = join(base, 'root')
    await mkdir(root)
    await mkdir(join(base, 'outside'))
    await writeFile(join(base, 'outside', 'secret.txt'), 'secret')
    await symlink(join(base, 'outside'), join(root, 'link'), 'dir')
    ctx = { root }
  })
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('writes creating parent dirs, then reads with offset and limit', async () => {
    expect(await writeFileTool({ path: 'a/b/c.txt', content: 'l1\nl2\nl3\nl4' }, ctx)).toEqual({
      ok: true,
      value: 'wrote a/b/c.txt'
    })
    expect(await readFile(join(root, 'a/b/c.txt'), 'utf8')).toBe('l1\nl2\nl3\nl4')
    expect(await readFileTool({ path: 'a/b/c.txt' }, ctx)).toEqual({
      ok: true,
      value: 'l1\nl2\nl3\nl4'
    })
    expect(await readFileTool({ path: 'a/b/c.txt', offset: 2, limit: 2 }, ctx)).toEqual({
      ok: true,
      value: 'l2\nl3'
    })
  })

  it('reports a missing file as an error reply', async () => {
    const reply = await readFileTool({ path: 'nope.txt' }, ctx)
    expect(reply.ok).toBe(false)
  })

  it('refuses outside paths and symlink escapes without touching them', async () => {
    const refusal = { ok: false, error: 'path is outside the workspace: ../x' }
    expect(await readFileTool({ path: '../x' }, ctx)).toEqual(refusal)
    expect(await writeFileTool({ path: '../x', content: 'no' }, ctx)).toEqual(refusal)
    expect(await editFileTool({ path: '../x', old_string: 'a', new_string: 'b' }, ctx)).toEqual(
      refusal
    )
    const viaLink = await readFileTool({ path: 'link/secret.txt' }, ctx)
    expect(viaLink).toEqual({ ok: false, error: 'path is outside the workspace: link/secret.txt' })
    await writeFileTool({ path: 'link/new.txt', content: 'x' }, ctx)
    await expect(readFile(join(base, 'outside', 'new.txt'))).rejects.toThrow()
    expect((await grepTool({ pattern: 'x', path: '..' }, ctx)).ok).toBe(false)
    expect((await findTool({ pattern: '*', path: '..' }, ctx)).ok).toBe(false)
  })

  describe('edit', () => {
    beforeEach(async () => {
      await writeFile(join(root, 'e.txt'), 'one two one\nthree')
    })

    it('fails with 0 matches', async () => {
      expect(
        await editFileTool({ path: 'e.txt', old_string: 'zzz', new_string: 'y' }, ctx)
      ).toEqual({ ok: false, error: 'old_string not found' })
    })

    it('replaces exactly one match', async () => {
      const reply = await editFileTool({ path: 'e.txt', old_string: 'three', new_string: '3' }, ctx)
      expect(reply.ok).toBe(true)
      expect(await readFile(join(root, 'e.txt'), 'utf8')).toBe('one two one\n3')
    })

    it('fails with more than one match', async () => {
      expect(
        await editFileTool({ path: 'e.txt', old_string: 'one', new_string: '1' }, ctx)
      ).toEqual({ ok: false, error: 'old_string matches 2 times; include more context' })
      expect(await readFile(join(root, 'e.txt'), 'utf8')).toBe('one two one\nthree')
    })

    it('treats replacement text literally', async () => {
      await editFileTool({ path: 'e.txt', old_string: 'three', new_string: '$&$1' }, ctx)
      expect(await readFile(join(root, 'e.txt'), 'utf8')).toBe('one two one\n$&$1')
    })
  })

  describe.skipIf(!hasRg)(`grep and find (${hasRg ? 'rg' : NO_RG})`, () => {
    beforeEach(async () => {
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src', 'a.ts'), 'const needle = 1\nother\n')
      await writeFile(join(root, 'src', 'b.md'), 'needle in docs\n')
      await writeFile(join(root, 'top.ts'), 'nothing\n')
    })

    it('greps matching lines with file and line number', async () => {
      const reply = await grepTool({ pattern: 'needle', glob: '*.ts' }, ctx)
      expect(reply).toEqual({ ok: true, value: 'src/a.ts:1:const needle = 1' })
    })

    it('returns empty text for no match and does not follow symlinks out', async () => {
      expect(await grepTool({ pattern: 'secret' }, ctx)).toEqual({ ok: true, value: '' })
    })

    it('reports an invalid regex as an error', async () => {
      expect((await grepTool({ pattern: '(' }, ctx)).ok).toBe(false)
    })

    it('finds files relative to the root', async () => {
      const reply = await findTool({ pattern: '*.ts' }, ctx)
      expect(reply).toEqual({ ok: true, value: 'src/a.ts\ntop.ts' })
      expect(await findTool({ pattern: '*.ts', path: 'src' }, ctx)).toEqual({
        ok: true,
        value: 'src/a.ts'
      })
    })
  })
})
