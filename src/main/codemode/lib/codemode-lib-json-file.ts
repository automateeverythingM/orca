import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type LibTable<V> = Map<string, Map<string, V>>

let tmpCounter = 0

// Why: trust and usage share one shape ({version, <field>: {key: {name: value}}}),
// one write queue, and one rule: a bad file reads empty but only a write replaces it.
// Maps keep a `__proto__` key from ever touching a prototype.
export class CodemodeLibJsonFile<V> {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly field: string,
    private readonly valid: (value: unknown) => value is V
  ) {}

  /** Waits for pending writes, then reads. Unreadable and malformed files read empty. */
  async read(): Promise<LibTable<V>> {
    await this.queue
    return (await this.load()).table
  }

  private async load(): Promise<{ table: LibTable<V>; malformed: boolean }> {
    const table: LibTable<V> = new Map()
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined
      if (code === 'ENOENT') {
        return { table, malformed: false }
      }
      throw error
    }
    try {
      const parsed: unknown = JSON.parse(text)
      const raw = isRecord(parsed) ? parsed[this.field] : undefined
      if (!isRecord(raw)) {
        return { table, malformed: true }
      }
      for (const [key, names] of Object.entries(raw)) {
        if (!isRecord(names)) {
          continue
        }
        const clean = new Map<string, V>()
        for (const [name, value] of Object.entries(names)) {
          if (this.valid(value)) {
            clean.set(name, value)
          }
        }
        table.set(key, clean)
      }
      return { table, malformed: false }
    } catch {
      return { table: new Map(), malformed: true }
    }
  }

  update(mutate: (table: LibTable<V>) => void): Promise<void> {
    const run = async (): Promise<void> => {
      // Why: an unreadable file (EACCES, EISDIR) throws here so we never overwrite it.
      const { table, malformed } = await this.load()
      if (malformed) {
        await copyFile(this.file, `${this.file}.bad`).catch(() => undefined)
      }
      mutate(table)
      await this.write(table)
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async write(table: LibTable<V>): Promise<void> {
    const out = new Map<string, Record<string, V>>()
    for (const [key, names] of table) {
      out.set(key, Object.fromEntries(names))
    }
    const body = { version: 1, [this.field]: Object.fromEntries(out) }
    const dir = dirname(this.file)
    await mkdir(dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.${tmpCounter++}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(body, null, 2), { mode: 0o600 })
      await rename(tmp, this.file)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
