import type {
  CodemodeLibMeta,
  CodemodeLibOrigin,
  CodemodeLibParam
} from '../../../shared/codemode/codemode-lib-types'

const BLOCK = /^\s*\/\*\*([\s\S]*?)\*\/[ \t]*\r?\n?/
const ORIGINS: readonly string[] = ['user', 'agent', 'learn']

function isOrigin(value: string): value is CodemodeLibOrigin {
  return ORIGINS.includes(value)
}

function parseParam(rest: string): CodemodeLibParam | null {
  const m = /^(?:\{([^}]*)\}\s*)?(\S+)(?:\s+(.*))?$/.exec(rest.trim())
  if (!m) {
    return null
  }
  const param: CodemodeLibParam = { name: m[2] }
  if (m[1]) {
    param.type = m[1].trim()
  }
  if (m[3]) {
    param.description = m[3].trim()
  }
  return param
}

export function parseLibHeader(source: string): { meta: Partial<CodemodeLibMeta>; body: string } {
  const block = BLOCK.exec(source)
  // Only a block that names the function is the lib header; any other doc block is body.
  if (!block || !/^\s*\*?\s*@name\s+\S/m.test(block[1])) {
    return { meta: {}, body: source }
  }
  const meta: Partial<CodemodeLibMeta> = {}
  const params: CodemodeLibParam[] = []
  for (const raw of block[1].split('\n')) {
    const m = /^\s*\*?\s*@([\w-]+)\s*(.*?)\s*$/.exec(raw)
    if (!m) {
      continue
    }
    const [, tag, rest] = m
    if (tag === 'name' && rest) {
      meta.name = rest
    } else if (tag === 'description') {
      meta.description = rest
    } else if (tag === 'saved-by' && isOrigin(rest)) {
      meta.savedBy = rest
    } else if (tag === 'param') {
      const param = parseParam(rest)
      if (param) {
        params.push(param)
      }
    }
  }
  if (params.length > 0) {
    meta.params = params
  }
  return { meta, body: source.slice(block[0].length) }
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\*\//g, '* /')
}

export function renderLibFile(meta: CodemodeLibMeta, source: string): string {
  const lines = ['/**', ` * @name ${meta.name}`, ` * @description ${oneLine(meta.description)}`]
  for (const p of meta.params) {
    const type = p.type ? ` {${oneLine(p.type)}}` : ''
    const desc = p.description ? ` ${oneLine(p.description)}` : ''
    lines.push(` * @param${type} ${p.name}${desc}`)
  }
  lines.push(` * @saved-by ${meta.savedBy}`, ' */')
  const body = parseLibHeader(source).body.replace(/^\s*\n/, '')
  return `${lines.join('\n')}\n${body.endsWith('\n') ? body : `${body}\n`}`
}

export function libSignature(meta: Pick<CodemodeLibMeta, 'name' | 'params'>): string {
  return `${meta.name}(${meta.params.length ? `{${meta.params.map((p) => p.name).join(', ')}}` : ''})`
}

export function definesFunction(source: string, name: string): boolean {
  const escaped = name.replace(/[$]/g, '\\$&')
  // \b fails before a leading `$`, so anchor on a non-identifier char instead.
  return new RegExp(`(?:^|[^A-Za-z0-9_$])(async\\s+)?function\\s+${escaped}\\s*\\(`).test(source)
}
