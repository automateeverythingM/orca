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
      const prev = Object.hasOwn(table[key] ?? {}, name) ? table[key][name] : { uses: 0 }
      table[key] = { ...table[key], [name]: { uses: prev.uses + 1, lastUsedAt: at } }
    })
  }

  async read(key: string, name: string): Promise<Usage> {
    const { table } = await this.store.read()
    const found = Object.hasOwn(table[key] ?? {}, name) ? table[key][name] : undefined
    return found ? { uses: found.uses, lastUsedAt: found.lastUsedAt } : { uses: 0 }
  }
}
