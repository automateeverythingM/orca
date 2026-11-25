import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CodemodeLibJsonFile } from './codemode-lib-json-file'

export type CodemodeLibTrustState = 'trusted' | 'unknown' | 'changed'

export function libSourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

export class CodemodeLibTrust {
  private readonly store: CodemodeLibJsonFile<string>

  constructor(opts: { homeDir?: string } = {}) {
    this.store = new CodemodeLibJsonFile(
      join(opts.homeDir ?? homedir(), '.orca', 'lib-trust.json'),
      'trust',
      (value): value is string => typeof value === 'string'
    )
  }

  async state(key: string, name: string, source: string): Promise<CodemodeLibTrustState> {
    const { table } = await this.store.read()
    const recorded = Object.hasOwn(table[key] ?? {}, name) ? table[key][name] : undefined
    if (recorded === undefined) {
      return 'unknown'
    }
    return recorded === libSourceHash(source) ? 'trusted' : 'changed'
  }

  record(key: string, name: string, source: string): Promise<void> {
    const sha = libSourceHash(source)
    return this.store.update((table) => {
      table[key] = { ...table[key], [name]: sha }
    })
  }

  forget(key: string, name: string): Promise<void> {
    return this.store.update((table) => {
      if (table[key]) {
        delete table[key][name]
      }
    })
  }
}
