import { mkdtemp, rm } from 'node:fs/promises'
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
})
