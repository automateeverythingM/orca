import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CodemodeLibJsonFile } from './codemode-lib-json-file'

export type CodemodeLibTrustState = 'trusted' | 'unknown' | 'changed'

/**
 * SHA-256 hex of the UTF-8 text that is evaluated: the file decoded as UTF-8, then re-encoded.
 * Not the raw file bytes; invalid UTF-8 decodes to U+FFFD, which is what runs.
 */
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
    const recorded = (await this.store.read()).get(key)?.get(name)
    if (recorded === undefined) {
      return 'unknown'
    }
    return recorded === libSourceHash(source) ? 'trusted' : 'changed'
  }

  record(key: string, name: string, source: string): Promise<void> {
    const sha = libSourceHash(source)
    return this.store.update((table) => {
      const names = table.get(key) ?? new Map<string, string>()
      names.set(name, sha)
      table.set(key, names)
    })
  }

  forget(key: string, name: string): Promise<void> {
    return this.store.update((table) => {
      table.get(key)?.delete(name)
    })
  }
}
