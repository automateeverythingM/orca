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
  /** Function body without the doc header. */
  source: string
}

export const CODEMODE_LIB_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/
export const CODEMODE_LIB_RESERVED: ReadonlySet<string> = new Set([
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
