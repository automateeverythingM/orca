import {
  constants,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  CODEMODE_LIB_MAX_BYTES,
  type CodemodeLibScope
} from '../../../shared/codemode/codemode-lib-types'

/** A history version: the save's UTC time, `-1`, `-2` … for more saves in the same millisecond. */
export const VERSION_RE = /^\d{8}T\d{9}Z(?:-[1-9]\d{0,5})?$/

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code
}

export function isNotFound(err: unknown): boolean {
  return hasCode(err, 'ENOENT')
}

/** Temp file in the same dir, then rename, so readers never see a half-written file. */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

/** A function file's text; never follows a symlink or reads a file over the size limit. */
export async function readLibFileText(file: string): Promise<string> {
  const info = await lstat(file)
  if (info.isSymbolicLink()) {
    throw new Error('symlinked function files are not allowed')
  }
  // Why: a cloned repo's huge file is never read; the bytes are checked too, as it may grow.
  if (info.size > CODEMODE_LIB_MAX_BYTES) {
    throw new Error('file is over the size limit')
  }
  const bytes = await readFile(file)
  if (bytes.byteLength > CODEMODE_LIB_MAX_BYTES) {
    throw new Error('file is over the size limit')
  }
  return bytes.toString('utf8')
}

export function versionStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:.]/g, '')
}

export function versionToMs(version: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(version)
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : 0
}

/** Same-millisecond saves sort by their suffix, so `-10` is newer than `-9`. */
function versionSeq(version: string): number {
  const dash = version.indexOf('-')
  return dash === -1 ? 0 : Number(version.slice(dash + 1))
}

/**
 * Copies `<dir>/<name>.js` into `.history` under a new version; never overwrites an entry, so
 * saves within one millisecond each keep theirs.
 */
export async function copyToHistory(dir: string, name: string, date = new Date()): Promise<void> {
  const historyDir = join(dir, '.history')
  await mkdir(historyDir, { recursive: true })
  const stamp = versionStamp(date)
  for (let seq = 0; ; seq++) {
    const version = seq === 0 ? stamp : `${stamp}-${seq}`
    if (!VERSION_RE.test(version)) {
      throw new Error('too many saves in one millisecond')
    }
    const target = join(historyDir, `${name}.${version}.js`)
    try {
      await copyFile(join(dir, `${name}.js`), target, constants.COPYFILE_EXCL)
      return
    } catch (err) {
      if (!hasCode(err, 'EEXIST')) {
        throw err
      }
    }
  }
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
    const version = f.startsWith(`${name}.`) && f.endsWith('.js') && f.slice(name.length + 1, -3)
    if (version && VERSION_RE.test(version)) {
      out.push({ version, savedAt: versionToMs(version) })
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt || versionSeq(b.version) - versionSeq(a.version))
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

/** Whether anything, a dangling symlink included, sits at `path`. */
export async function lexists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (err) {
    if (isNotFound(err)) {
      return false
    }
    throw err
  }
}

/**
 * Refuses a lib dir reached through a symlink: `.orca/lib` or its `.history`, and in a project
 * `<root>/.orca` too. A cloned repo could point any of them outside, and every read, copy and
 * write below would follow it. A symlinked `~/.orca` is the person's own dotfiles, so global
 * allows it. Missing is fine.
 */
export async function refuseSymlinkedLibDirs(
  libDir: string,
  scope: CodemodeLibScope
): Promise<void> {
  const problem = await symlinkedLibDirProblem(libDir, scope)
  if (problem) {
    throw new Error(problem)
  }
}

/** The refusal `refuseSymlinkedLibDirs` would throw, or null; other read errors still throw. */
export async function symlinkedLibDirProblem(
  libDir: string,
  scope: CodemodeLibScope
): Promise<string | null> {
  const dirs = [libDir, join(libDir, '.history')]
  for (const dir of scope === 'project' ? [dirname(libDir), ...dirs] : dirs) {
    if (await isSymlink(dir)) {
      return `symlinked lib directories are not allowed: ${dir}`
    }
  }
  return null
}

/** The trust and usage key: `~` for global, the project root's real path for project. */
export async function libTrustKey(
  scope: CodemodeLibScope,
  projectRoot: string | null
): Promise<string> {
  if (scope === 'global') {
    return '~'
  }
  if (!projectRoot) {
    throw new Error('no project root for project scope')
  }
  return realpath(projectRoot)
}
