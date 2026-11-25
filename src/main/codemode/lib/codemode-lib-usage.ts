import { homedir } from 'node:os'
import { join } from 'node:path'
import { CodemodeLibJsonFile } from './codemode-lib-json-file'

type Usage = { uses: number; lastUsedAt?: number }

function isUsage(value: unknown): value is Usage {
  return (
    typeof value === 'object' && value !== null && 'uses' in value && typeof value.uses === 'number'
  )
}

export class CodemodeLibUsage {
  private readonly store: CodemodeLibJsonFile<Usage>

  constructor(opts: { homeDir?: string } = {}) {
    this.store = new CodemodeLibJsonFile(
      join(opts.homeDir ?? homedir(), '.orca', 'lib-usage.json'),
      'usage',
      isUsage
    )
  }

  recordUse(key: string, name: string, at: number = Date.now()): Promise<void> {
    return this.store.update((table) => {
      const names = table.get(key) ?? new Map<string, Usage>()
      names.set(name, { uses: (names.get(name)?.uses ?? 0) + 1, lastUsedAt: at })
      table.set(key, names)
    })
  }

  async read(key: string, name: string): Promise<Usage> {
    const found = (await this.store.read()).get(key)?.get(name)
    return found ? { uses: found.uses, lastUsedAt: found.lastUsedAt } : { uses: 0 }
  }
}
