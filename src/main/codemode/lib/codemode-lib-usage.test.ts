import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodemodeLibUsage } from './codemode-lib-usage'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lib-usage-'))
})
afterEach(() => rm(home, { recursive: true, force: true }))

describe('CodemodeLibUsage', () => {
  it('counts uses and keeps the last time', async () => {
    const usage = new CodemodeLibUsage({ homeDir: home })
    expect(await usage.read('~', 'f')).toEqual({ uses: 0 })
    await usage.recordUse('~', 'f', 100)
    await usage.recordUse('~', 'f', 200)
    expect(await usage.read('~', 'f')).toEqual({ uses: 2, lastUsedAt: 200 })
    expect(await usage.read('~', 'g')).toEqual({ uses: 0 })
  })

  it('concurrent recordUse calls are both counted', async () => {
    const usage = new CodemodeLibUsage({ homeDir: home })
    await Promise.all([usage.recordUse('~', 'f', 1), usage.recordUse('~', 'f', 2)])
    expect((await usage.read('~', 'f')).uses).toBe(2)
  })

  it('malformed usage file reads empty and is kept as .bad on next write', async () => {
    const file = join(home, '.orca', 'lib-usage.json')
    await mkdir(join(home, '.orca'), { recursive: true })
    await writeFile(file, '{nope')
    const usage = new CodemodeLibUsage({ homeDir: home })
    expect(await usage.read('~', 'f')).toEqual({ uses: 0 })
    await usage.recordUse('~', 'f', 5)
    expect(await readFile(`${file}.bad`, 'utf8')).toBe('{nope')
    expect((await usage.read('~', 'f')).uses).toBe(1)
  })

  it('an unreadable usage path makes recordUse reject and leaves it alone', async () => {
    const file = join(home, '.orca', 'lib-usage.json')
    await mkdir(file, { recursive: true })
    const usage = new CodemodeLibUsage({ homeDir: home })
    await expect(usage.recordUse('~', 'f')).rejects.toThrow()
    expect((await stat(file)).isDirectory()).toBe(true)
  })
})
