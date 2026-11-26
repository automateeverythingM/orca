// The Learn writer's reply: only ever parsed as one JSON object and checked field by field, so
// nothing the writer says (or was told by recorded data) can do more than fill these fields.
import { z } from 'zod'
import type { CodemodeLearnDraft } from '../../../../shared/codemode/codemode-learn-types'
import {
  CODEMODE_LIB_MAX_BYTES,
  CODEMODE_LIB_NAME,
  CODEMODE_LIB_RESERVED,
  type CodemodeLibMeta,
  type CodemodeLibParam
} from '../../../../shared/codemode/codemode-lib-types'
import { renderLibFile } from '../../lib/codemode-lib-header'

export type WriterReplyResult =
  | { ok: true; draft: CodemodeLearnDraft }
  | { ok: false; reason: string }

const PARAM_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/

// Words strict-mode JavaScript will not bind as a function or parameter name.
const JS_RESERVED: ReadonlySet<string> = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends ' +
    'false finally for function if import in instanceof new null return super switch this throw ' +
    'true try typeof var void while with yield let static implements interface package private ' +
    'protected public await arguments eval'
  ).split(' ')
)
// The sandbox's own names: a parameter called `mcp` would hide the tools the body calls.
const SANDBOX_GLOBALS: ReadonlySet<string> = new Set(
  'mcp orca lib read write edit grep find bash print'.split(' ')
)
const MAX_CANDIDATES = 20

const paramSchema = z.object({
  name: z.string().regex(PARAM_NAME),
  type: z.string().max(200).nullish(),
  description: z.string().max(500).nullish()
})

const replySchema = z.object({
  worth: z.literal(true),
  name: z.string().min(1),
  description: z.string().trim().min(1).max(500),
  params: z.array(paramSchema).max(20),
  body: z
    .string()
    .min(1)
    .max(CODEMODE_LIB_MAX_BYTES / 2),
  sample_args: z.record(z.string(), z.unknown()),
  expect: z.array(z.string().min(1).max(500)).min(1).max(3),
  calls_saved: z.number().finite().nonnegative(),
  scope: z.enum(['project', 'global']),
  why: z.string().max(2000).default('')
})

/** End index (exclusive) of the balanced `{…}` starting at `start`, strings and escapes respected. */
function objectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') {
        i++
      } else if (ch === '"') {
        inString = false
      }
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        return i + 1
      }
    }
  }
  return -1
}

function firstObjectIn(text: string): Record<string, unknown> | null {
  let from = text.indexOf('{')
  for (let tries = 0; from !== -1 && tries < MAX_CANDIDATES; tries++) {
    const end = objectEnd(text, from)
    if (end === -1) {
      // An unclosed brace in prose (`{email as a param`): the reply may start at a later one.
      from = text.indexOf('{', from + 1)
      continue
    }
    try {
      const value: unknown = JSON.parse(text.slice(from, end))
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value))
      }
    } catch {
      // Prose such as `{not json}` before the reply; try the next brace.
    }
    from = text.indexOf('{', from + 1)
  }
  return null
}

/** The first top-level JSON object: a ```json fence's content first, else the whole reply. */
function firstObject(raw: string): Record<string, unknown> | null {
  const fenced = /^(`{3,})json[^\n]*\n([\s\S]*?)^\1[ \t]*$/m.exec(raw)
  return (fenced && firstObjectIn(fenced[2])) ?? firstObjectIn(raw)
}

function issuePaths(error: z.ZodError): string {
  const paths = error.issues.map((issue) => issue.path.join('.') || '(reply)')
  return [...new Set(paths)].join(', ')
}

function cleanParam(param: z.infer<typeof paramSchema>): CodemodeLibParam {
  const out: CodemodeLibParam = { name: param.name }
  // The lib header writes the type as `{type}`; a brace inside would end it early.
  const type = param.type?.trim()
  if (type && !/[{}]/.test(type)) {
    out.type = type
  }
  const description = param.description?.trim()
  if (description) {
    out.description = description
  }
  return out
}

export function parseWriterReply(raw: string): WriterReplyResult {
  const value = firstObject(raw)
  if (!value) {
    return { ok: false, reason: 'The writer did not reply with a JSON object.' }
  }
  if (value.worth === false) {
    const why = typeof value.why === 'string' && value.why.trim() ? value.why.trim() : 'no reason'
    return { ok: false, reason: `Not worth saving: ${why.slice(0, 500)}` }
  }
  const parsed = replySchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      reason: `The writer's reply is missing fields or has bad ones: ${issuePaths(parsed.error)}`
    }
  }
  const reply = parsed.data
  if (!CODEMODE_LIB_NAME.test(reply.name)) {
    return {
      ok: false,
      reason: `The writer chose an invalid function name: ${reply.name.slice(0, 80)}`
    }
  }
  if (CODEMODE_LIB_RESERVED.has(reply.name) || JS_RESERVED.has(reply.name)) {
    return { ok: false, reason: `The writer chose a reserved function name: ${reply.name}` }
  }
  const params = reply.params.map(cleanParam)
  const badParam = params.find(
    (p) =>
      JS_RESERVED.has(p.name) || CODEMODE_LIB_RESERVED.has(p.name) || SANDBOX_GLOBALS.has(p.name)
  )
  if (badParam) {
    return {
      ok: false,
      reason: `The writer chose a reserved parameter name: ${badParam.name} (a JavaScript keyword or a name code mode already uses)`
    }
  }
  if (new Set(params.map((p) => p.name)).size !== params.length) {
    return { ok: false, reason: 'The writer named a parameter twice.' }
  }
  return {
    ok: true,
    draft: {
      name: reply.name,
      description: reply.description,
      params,
      body: reply.body,
      sampleArgs: reply.sample_args,
      expect: reply.expect,
      callsSaved: Math.round(reply.calls_saved),
      scope: reply.scope,
      why: reply.why.trim()
    }
  }
}

/** The draft as a Part D lib file: header (`@saved-by learn`) plus `async function name({…})`. */
export function draftToLibFile(draft: CodemodeLearnDraft): {
  source: string
  meta: CodemodeLibMeta
} {
  const meta: CodemodeLibMeta = {
    name: draft.name,
    description: draft.description,
    params: draft.params,
    savedBy: 'learn'
  }
  const args = draft.params.length > 0 ? `{ ${draft.params.map((p) => p.name).join(', ')} }` : ''
  const body = draft.body.replace(/^\n+/, '').replace(/\s+$/, '')
  return {
    source: renderLibFile(meta, `async function ${draft.name}(${args}) {\n${body}\n}\n`),
    meta
  }
}
