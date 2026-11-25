import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLibRecords, libAccessFor, openChatLib } from './codemode-lib-access'

let root: string
let home: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lib-access-root-'))
  home = await mkdtemp(join(tmpdir(), 'lib-access-home-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

describe('libAccessFor', () => {
  it('a chat rooted in a project gets project scope', async () => {
    const lib = await libAccessFor(root, createLibRecords(home))
    expect(lib.projectRoot).toBe(root)
    expect(lib.store.dir('project')).toBe(join(root, '.orca', 'lib'))
  })

  it('a chat rooted at the home dir has no project scope', async () => {
    const records = createLibRecords(home)
    expect((await libAccessFor(home, records)).projectRoot).toBe(null)
    const link = join(root, 'home-link')
    await symlink(home, link)
    const viaLink = await libAccessFor(link, records)
    expect(viaLink.projectRoot).toBe(null)
    expect(viaLink.store.dir('project')).toBe(null)
  })
})

describe('openChatLib', () => {
  it('reads the signatures once, and a read failure logs and gives none', async () => {
    const dir = join(root, '.orca', 'lib')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'ping.js'), '/** @name ping */\nasync function ping() {}\n')
    const logged: string[] = []
    const log = (message: string): void => void logged.push(message)
    expect((await openChatLib(root, createLibRecords(home), log)).signatures).toEqual(['ping()'])
    await rm(dir, { recursive: true })
    await writeFile(join(root, '.orca', 'lib'), 'not a dir')
    expect((await openChatLib(root, createLibRecords(home), log)).signatures).toEqual([])
    expect(logged).toEqual(['saved functions could not be read'])
  })
})
