import { lstat, mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const VERSION_RE = /^\d{8}T\d{9}Z$/

export function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}

/** Temp file in the same dir, then rename, so readers never see a half-written file. */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

export function versionStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:.]/g, '')
}

export function versionToMs(version: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(version)
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : 0
}

/** History entries for `name` in `<dir>/.history`, newest first. */
export async function listHistory(
  dir: string,
  name: string
): Promise<{ version: string; savedAt: number }[]> {
  let files: string[]
  try {
    files = await readdir(join(dir, '.history'))
  } catch (err) {
    if (isNotFound(err)) {
      return []
    }
    throw err
  }
  const out: { version: string; savedAt: number }[] = []
  for (const f of files) {
    const m = f.startsWith(`${name}.`) && /^(\d{8}T\d{9}Z)\.js$/.exec(f.slice(name.length + 1))
    if (m) {
      out.push({ version: m[1], savedAt: versionToMs(m[1]) })
    }
  }
  return out.sort((a, b) => b.version.localeCompare(a.version))
}

export async function isSymlink(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isSymbolicLink()
  } catch (err) {
    if (isNotFound(err)) {
      return false
    }
    throw err
  }
}
