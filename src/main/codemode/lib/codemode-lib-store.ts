import { copyFile, mkdir, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CODEMODE_LIB_MAX_BYTES,
  CODEMODE_LIB_NAME,
  CODEMODE_LIB_RESERVED,
  type CodemodeLibFunction,
  type CodemodeLibMeta,
  type CodemodeLibOrigin,
  type CodemodeLibScope
} from '../../../shared/codemode/codemode-lib-types'
import { definesFunction, parseLibHeader, renderLibFile } from './codemode-lib-header'
import {
  VERSION_RE,
  isNotFound,
  listHistory,
  versionStamp,
  writeFileAtomic
} from './codemode-lib-files'

export type CodemodeLibSaveInput = {
  name: string
  source: string
  scope: CodemodeLibScope
  description?: string
  savedBy: CodemodeLibOrigin
}

function assertName(name: string): void {
  if (!CODEMODE_LIB_NAME.test(name) || CODEMODE_LIB_RESERVED.has(name)) {
    throw new Error(`invalid function name: ${JSON.stringify(name)}`)
  }
}

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

export class CodemodeLibStore {
  private readonly projectRoot: string | null
  private readonly homeDir: string

  constructor(opts: { projectRoot: string | null; homeDir?: string }) {
    this.projectRoot = opts.projectRoot
    this.homeDir = opts.homeDir ?? homedir()
  }

  dir(scope: CodemodeLibScope): string | null {
    if (scope === 'global') {
      return join(this.homeDir, '.orca', 'lib')
    }
    return this.projectRoot ? join(this.projectRoot, '.orca', 'lib') : null
  }

  private requireDir(scope: CodemodeLibScope): string {
    const dir = this.dir(scope)
    if (!dir) {
      throw new Error('no project root for project scope')
    }
    return dir
  }

  private async parseFile(
    dir: string,
    scope: CodemodeLibScope,
    fileName: string
  ): Promise<CodemodeLibFunction> {
    const file = join(dir, fileName)
    const expected = fileName.slice(0, -'.js'.length)
    if ((await stat(file)).size > CODEMODE_LIB_MAX_BYTES) {
      throw new Error('file is over the size limit')
    }
    const { meta, body } = parseLibHeader(await readFile(file, 'utf8'))
    if (!meta.name) {
      throw new Error('missing @name header')
    }
    if (meta.name !== expected) {
      throw new Error(`@name ${meta.name} does not match the file name`)
    }
    if (!CODEMODE_LIB_NAME.test(expected) || CODEMODE_LIB_RESERVED.has(expected)) {
      throw new Error('invalid function name')
    }
    if (!definesFunction(body, expected)) {
      throw new Error(`source does not define function ${expected}`)
    }
    return {
      name: expected,
      description: meta.description ?? '',
      params: meta.params ?? [],
      savedBy: meta.savedBy ?? 'user',
      scope,
      file,
      source: body
    }
  }

  private async listScope(scope: CodemodeLibScope): Promise<{
    functions: CodemodeLibFunction[]
    problems: string[]
  }> {
    const dir = this.dir(scope)
    const result: { functions: CodemodeLibFunction[]; problems: string[] } = {
      functions: [],
      problems: []
    }
    if (!dir) {
      return result
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (isNotFound(err)) {
        return result
      }
      throw err
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) {
        continue
      }
      try {
        result.functions.push(await this.parseFile(dir, scope, entry.name))
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        result.problems.push(`${join(dir, entry.name)}: ${reason}`)
      }
    }
    return result
  }

  async list(): Promise<{ functions: CodemodeLibFunction[]; problems: string[] }> {
    const project = await this.listScope('project')
    const global = await this.listScope('global')
    const shadowed = new Set(project.functions.map((f) => f.name))
    const functions = [
      ...project.functions,
      ...global.functions.filter((f) => !shadowed.has(f.name))
    ]
    functions.sort((a, b) => a.name.localeCompare(b.name))
    return { functions, problems: [...project.problems, ...global.problems] }
  }

  async get(name: string): Promise<CodemodeLibFunction | null> {
    return (await this.read(name, 'project')) ?? this.read(name, 'global')
  }

  async read(name: string, scope: CodemodeLibScope): Promise<CodemodeLibFunction | null> {
    assertName(name)
    const dir = this.dir(scope)
    if (!dir) {
      return null
    }
    try {
      return await this.parseFile(dir, scope, `${name}.js`)
    } catch (err) {
      if (isNotFound(err)) {
        return null
      }
      throw err
    }
  }

  async prepare(
    input: CodemodeLibSaveInput
  ): Promise<{ text: string; meta: CodemodeLibMeta; exists: boolean }> {
    assertName(input.name)
    const dir = this.requireDir(input.scope)
    const { meta: header } = parseLibHeader(input.source)
    const description = (input.description ?? header.description ?? '').trim()
    if (!description) {
      throw new Error('lib.save needs a description')
    }
    if (!definesFunction(input.source, input.name)) {
      throw new Error(`source must define function ${input.name}`)
    }
    const meta: CodemodeLibMeta = {
      name: input.name,
      description,
      params: header.params ?? [],
      savedBy: input.savedBy
    }
    const text = renderLibFile(meta, input.source)
    if (Buffer.byteLength(text, 'utf8') > CODEMODE_LIB_MAX_BYTES) {
      throw new Error('function is over the 256 KiB size limit')
    }
    const exists = await stat(join(dir, `${input.name}.js`)).then(
      () => true,
      (err: unknown) => {
        if (isNotFound(err)) {
          return false
        }
        throw err
      }
    )
    return { text, meta, exists }
  }

  private async toHistory(dir: string, name: string): Promise<void> {
    const historyDir = join(dir, '.history')
    await mkdir(historyDir, { recursive: true })
    await copyFile(join(dir, `${name}.js`), join(historyDir, `${name}.${versionStamp()}.js`))
  }

  async save(input: CodemodeLibSaveInput): Promise<CodemodeLibFunction> {
    const { text, meta, exists } = await this.prepare(input)
    const dir = this.requireDir(input.scope)
    if (exists) {
      await this.toHistory(dir, input.name)
    }
    const file = join(dir, `${input.name}.js`)
    await writeFileAtomic(file, text)
    return { ...meta, scope: input.scope, file, source: parseLibHeader(text).body }
  }

  async remove(name: string, scope: CodemodeLibScope): Promise<void> {
    assertName(name)
    const dir = this.requireDir(scope)
    try {
      await this.toHistory(dir, name)
      await unlink(join(dir, `${name}.js`))
    } catch (err) {
      if (isNotFound(err)) {
        throw new Error(`no function ${name} in ${scope} scope`)
      }
      throw err
    }
  }

  async move(name: string, from: CodemodeLibScope): Promise<CodemodeLibFunction> {
    const to: CodemodeLibScope = from === 'project' ? 'global' : 'project'
    const fn = await this.read(name, from)
    if (!fn) {
      throw new Error(`no function ${name} in ${from} scope`)
    }
    if (await this.read(name, to)) {
      throw new Error(`${name} already exists in ${to} scope`)
    }
    const moved = await this.save({
      name,
      source: fn.source,
      scope: to,
      description: fn.description,
      savedBy: fn.savedBy
    })
    await this.remove(name, from)
    return moved
  }

  async history(
    name: string,
    scope: CodemodeLibScope
  ): Promise<{ version: string; savedAt: number }[]> {
    assertName(name)
    const dir = this.dir(scope)
    if (!dir) {
      return []
    }
    return listHistory(dir, name)
  }

  async readVersion(name: string, scope: CodemodeLibScope, version: string): Promise<string> {
    assertName(name)
    if (!VERSION_RE.test(version)) {
      throw new Error('invalid version')
    }
    return readFile(join(this.requireDir(scope), '.history', `${name}.${version}.js`), 'utf8')
  }
}
