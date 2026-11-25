import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodemodeLibTrust, libSourceHash } from './codemode-lib-trust'

let home: string
let trust: CodemodeLibTrust
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lib-trust-'))
  trust = new CodemodeLibTrust({ homeDir: home })
})
afterEach(() => rm(home, { recursive: true, force: true }))
const file = (): string => join(home, '.orca', 'lib-trust.json')

describe('CodemodeLibTrust', () => {
  it('unknown before record, trusted after', async () => {
    expect(await trust.state('~', 'f', 'src')).toBe('unknown')
    await trust.record('~', 'f', 'src')
    expect(await trust.state('~', 'f', 'src')).toBe('trusted')
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      version: 1,
      trust: { '~': { f: libSourceHash('src') } }
    })
  })

  it('changed when the source differs from the recorded hash', async () => {
    await trust.record('~', 'f', 'src')
    expect(await trust.state('~', 'f', 'src2')).toBe('changed')
  })

  it('keys are separate per project', async () => {
    await trust.record('/a', 'f', 'src')
    expect(await trust.state('/b', 'f', 'src')).toBe('unknown')
  })

  it('forget removes trust', async () => {
    await trust.record('~', 'f', 'src')
    await trust.forget('~', 'f')
    expect(await trust.state('~', 'f', 'src')).toBe('unknown')
  })

  it('concurrent records both land', async () => {
    await Promise.all([trust.record('~', 'a', 'x'), trust.record('~', 'b', 'y')])
    expect(await trust.state('~', 'a', 'x')).toBe('trusted')
    expect(await trust.state('~', 'b', 'y')).toBe('trusted')
  })

  it('malformed trust file reads empty and is kept as .bad on next write', async () => {
    await mkdir(join(home, '.orca'), { recursive: true })
    await writeFile(file(), '{not json')
    expect(await trust.state('~', 'f', 'src')).toBe('unknown')
    expect(await readFile(file(), 'utf8')).toBe('{not json')
    await trust.record('~', 'f', 'src')
    expect(await readFile(`${file()}.bad`, 'utf8')).toBe('{not json')
    expect(await trust.state('~', 'f', 'src')).toBe('trusted')
  })

  it('an unreadable trust path makes record reject and leaves the path alone', async () => {
    await mkdir(file(), { recursive: true })
    await expect(trust.record('~', 'f', 'src')).rejects.toThrow()
    expect((await stat(file())).isDirectory()).toBe(true)
  })

  it('a __proto__ key does not touch prototypes', async () => {
    await trust.record('__proto__', '__proto__', 'src')
    expect(await trust.state('__proto__', '__proto__', 'src')).toBe('trusted')
    expect(Object.keys({})).toEqual([])
    expect(await trust.state('other', 'f', 'src')).toBe('unknown')
  })
})
