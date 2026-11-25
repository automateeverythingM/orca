import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeSecureJsonFile } from '../../../shared/secure-storage/secure-file'

type Table<V> = Record<string, Record<string, V>>

// Why: trust and usage share one shape ({version, <field>: {key: {name: value}}}),
// one write queue, and one rule: a bad file reads empty but only a write replaces it.
export class CodemodeLibJsonFile<V> {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly field: string,
    private readonly valid: (value: unknown) => value is V
  ) {}

  async read(): Promise<{ table: Table<V>; malformed: boolean }> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined
      return { table: {}, malformed: code !== 'ENOENT' }
    }
    try {
      const parsed: unknown = JSON.parse(text)
      const raw = isRecord(parsed) ? parsed[this.field] : undefined
      if (!isRecord(raw)) {
        return { table: {}, malformed: true }
      }
      const table: Table<V> = {}
      for (const [key, names] of Object.entries(raw)) {
        if (!isRecord(names)) {
          continue
        }
        const clean: Record<string, V> = {}
        for (const [name, value] of Object.entries(names)) {
          if (this.valid(value)) {
            clean[name] = value
          }
        }
        table[key] = clean
      }
      return { table, malformed: false }
    } catch {
      return { table: {}, malformed: true }
    }
  }

  update(mutate: (table: Table<V>) => void): Promise<void> {
    const run = async (): Promise<void> => {
      const { table, malformed } = await this.read()
      if (malformed) {
        await copyFile(this.file, `${this.file}.bad`).catch(() => undefined)
      }
      mutate(table)
      await mkdir(dirname(this.file), { recursive: true })
      writeSecureJsonFile(this.file, { version: 1, [this.field]: table })
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
