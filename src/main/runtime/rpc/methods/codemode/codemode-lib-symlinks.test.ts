import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLibRecords } from '../../../../codemode/lib/codemode-lib-access'
import { CodemodeLibStore } from '../../../../codemode/lib/codemode-lib-store'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { codemodeLibMethods } from './codemode-lib'

const SECRET = 'PRIVATE-KEY-BYTES-0451'

let root: string
let home: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lib-rpc-ln-root-'))
  home = await mkdtemp(join(tmpdir(), 'lib-rpc-ln-home-'))
  outside = await mkdtemp(join(tmpdir(), 'lib-rpc-ln-outside-'))
  await writeFile(join(outside, 'id_rsa'), SECRET)
})
afterEach(async () => {
  for (const dir of [root, home, outside]) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function call(name: string, params: unknown): Promise<unknown> {
  const records = createLibRecords(home)
  const methods = codemodeLibMethods({
    desktop: () => true,
    records: async () => records,
    projectAccess: async () => {}
  })
  const method = eraseRpcMethods(methods).find((m) => m.name === name)
  if (!method) {
    throw new Error(`no method ${name}`)
  }
  const ctx: RpcContext = { runtime: new OrcaRuntimeService(null) }
  return await method.handler(method.params?.parse(params), ctx)
}

/** Every regular file under both `.orca` dirs, read without following any symlink. */
async function libFileTexts(): Promise<string[]> {
  const texts: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
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

async function linkProjectFile(name: string): Promise<void> {
  await mkdir(join(root, '.orca', 'lib'), { recursive: true })
  await symlink(join(outside, 'id_rsa'), join(root, '.orca', 'lib', `${name}.js`))
}

describe('codemode.lib.* and symlinks', () => {
  it('delete refuses a symlinked function file', async () => {
    await linkProjectFile('deploy')
    await expect(
      call('codemode.lib.delete', { name: 'deploy', scope: 'project', projectRoot: root })
    ).rejects.toThrow('symlinked function files are not allowed')
    expect((await libFileTexts()).some((text) => text.includes(SECRET))).toBe(false)
  })

  it('move to project refuses a symlinked target', async () => {
    await new CodemodeLibStore({ projectRoot: null, homeDir: home }).save({
      name: 'deploy',
      scope: 'global',
      source: 'async function deploy() {}\n',
      description: 'd',
      savedBy: 'user'
    })
    await linkProjectFile('deploy')
    await expect(
      call('codemode.lib.move', { name: 'deploy', from: 'global', projectRoot: root })
    ).rejects.toThrow('deploy already exists in project scope')
    expect((await libFileTexts()).some((text) => text.includes(SECRET))).toBe(false)
  })

  it('refuses a symlinked .orca/lib and a symlinked .history', async () => {
    await mkdir(join(root, '.orca'))
    await symlink(outside, join(root, '.orca', 'lib'))
    const target = { name: 'id_rsa', scope: 'project', projectRoot: root }
    await expect(call('codemode.lib.read', target)).rejects.toThrow('symlinked lib directories')
    await expect(call('codemode.lib.history', target)).rejects.toThrow('symlinked lib directories')
    await expect(call('codemode.lib.list', { projectRoot: root })).resolves.toMatchObject({
      functions: [],
      problems: [expect.stringContaining('symlinked lib directories')]
    })
    await rm(join(root, '.orca', 'lib'))
    await mkdir(join(root, '.orca', 'lib'))
    await symlink(outside, join(root, '.orca', 'lib', '.history'))
    await expect(
      call('codemode.lib.read', { ...target, version: '20260101T000000000Z' })
    ).rejects.toThrow('symlinked lib directories')
    expect(await readdir(outside)).toEqual(['id_rsa'])
  })
})
