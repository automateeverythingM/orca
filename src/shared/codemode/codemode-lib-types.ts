export type CodemodeLibScope = 'project' | 'global'
export type CodemodeLibOrigin = 'user' | 'agent' | 'learn'
export type CodemodeLibParam = { name: string; type?: string; description?: string }
export type CodemodeLibMeta = {
  name: string
  description: string
  params: CodemodeLibParam[]
  savedBy: CodemodeLibOrigin
}
export type CodemodeLibFunction = CodemodeLibMeta & {
  scope: CodemodeLibScope
  file: string
  /** The whole file text: doc header and body. */
  source: string
}

export const CODEMODE_LIB_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/
// Why: the sandbox wraps each file in `function (lib)`, and keywords can't name an async function.
export const CODEMODE_LIB_RESERVED: ReadonlySet<string> = new Set([
  'lib',
  'await',
  'yield',
  'let',
  'list',
  'describe',
  'save',
  'then',
  'toString',
  'toJSON',
  'valueOf',
  'constructor'
])
export const CODEMODE_LIB_MAX_BYTES = 256 * 1024

/** A saved function as Settings › Functions shows it; no file path, the source comes from `read`. */
export type CodemodeLibEntryView = CodemodeLibMeta & {
  scope: CodemodeLibScope
  uses: number
  lastUsedAt?: number
  /** The file's current bytes match the hash the person allowed. */
  trusted: boolean
  /** A global function a project function of the same name hides. */
  shadowed: boolean
  /** SHA-256 hex of the listed bytes; `trust` must send the hash of what the person viewed. */
  sha256: string
}

export type CodemodeLibListView = { functions: CodemodeLibEntryView[]; problems: string[] }

export type CodemodeLibVersion = { version: string; savedAt: number }
