import type { CodemodeLimits } from '../codemode-limits'
import type { CodemodeMcpPool, CodemodeServerSpec } from '../mcp-pool/codemode-mcp-pool'
import { trimOutput } from '../sandbox/codemode-output-trim'
import type { HostCall, HostReply } from '../sandbox/codemode-script-runner'
import type { GateCheck } from './codemode-approvals'
import { runBash } from './codemode-bash'
import {
  editFileTool,
  findTool,
  grepTool,
  readFileTool,
  writeFileTool
} from './codemode-file-tools'
import { resolveInRoot } from './codemode-paths'

export type HostCallContext = {
  root: string
  env: NodeJS.ProcessEnv
  limits: CodemodeLimits
  pool: CodemodeMcpPool
  trusted: (server: string) => boolean
  signal: AbortSignal
}

/** A validated inner call: what the gate judges, and how to run it once allowed. */
export type PlannedHostCall = GateCheck & { execute: () => Promise<HostReply> }

type Fields = Record<string, unknown>

const DETAIL_BYTES = 2_000
const NO_PROMPT = { title: '', detail: '' }

function fieldsOf(tool: string, input: unknown): Fields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${tool}: expected an object argument`)
  }
  return input as Fields
}

function text(tool: string, fields: Fields, key: string): string {
  const value = fields[key]
  if (typeof value !== 'string') {
    throw new Error(`${tool}: ${key} must be a string`)
  }
  return value
}

function optionalText(tool: string, fields: Fields, key: string): string | undefined {
  return fields[key] === undefined ? undefined : text(tool, fields, key)
}

function optionalNumber(tool: string, fields: Fields, key: string): number | undefined {
  const value = fields[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${tool}: ${key} must be a number`)
  }
  return value
}

function clip(value: string): string {
  return trimOutput(value, DETAIL_BYTES)
}

function knownServer(pool: CodemodeMcpPool, server: string): string {
  const names = pool.names()
  if (!names.includes(server)) {
    throw new Error(`unknown MCP server ${server}; known: ${names.join(', ') || 'none'}`)
  }
  return server
}

/** Name and input shown for an inner call in the run view. */
export function hostCallLabel(call: HostCall): { tool: string; input: unknown } {
  if (call.tool === 'mcp.call' && typeof call.input === 'object' && call.input !== null) {
    const { server, tool, args } = call.input as Fields
    return { tool: `mcp.${String(server)}.${String(tool)}`, input: args }
  }
  return { tool: call.tool, input: call.input }
}

export function serverStartCheck(spec: CodemodeServerSpec): GateCheck {
  return {
    gate: { kind: 'mcp-start', server: spec.name },
    allowKey: `mcp-start:${spec.name}`,
    prompt: {
      title: `Start MCP server ${spec.name}`,
      detail: clip(`${[spec.command, ...spec.args].join(' ')}\nfrom ${spec.source} config`)
    }
  }
}

async function planFileChange(
  tool: 'write' | 'edit',
  fields: Fields,
  ctx: HostCallContext
): Promise<PlannedHostCall> {
  const path = text(tool, fields, 'path')
  const detail =
    tool === 'write'
      ? clip(text(tool, fields, 'content'))
      : clip(`- ${text(tool, fields, 'old_string')}\n+ ${text(tool, fields, 'new_string')}`)
  const inside = await resolveInRoot(ctx.root, path).then(
    (resolved) => resolved.inside,
    () => false
  )
  const verb = tool === 'write' ? 'Write' : 'Edit'
  // Why: the tool re-resolves the path, so a link swapped in after this check is still refused.
  const fileCtx = { root: ctx.root, allowOutside: !inside }
  const execute = (): Promise<HostReply> =>
    tool === 'write'
      ? writeFileTool({ path, content: fields.content as string }, fileCtx)
      : editFileTool(
          {
            path,
            old_string: fields.old_string as string,
            new_string: fields.new_string as string
          },
          fileCtx
        )
  return inside
    ? {
        gate: { kind: 'write' },
        allowKey: 'write',
        prompt: { title: `${verb} ${path}`, detail },
        execute
      }
    : {
        gate: { kind: 'path-outside' },
        allowKey: 'path-outside',
        prompt: { title: `${verb} ${path} outside the workspace`, detail },
        execute
      }
}

function planMcpCall(fields: Fields, ctx: HostCallContext): PlannedHostCall {
  const server = knownServer(ctx.pool, text('mcp.call', fields, 'server'))
  const tool = text('mcp.call', fields, 'tool')
  const args = fieldsOf('mcp.call', fields.args ?? {})
  return {
    gate: { kind: 'mcp', server, trusted: ctx.trusted(server) },
    allowKey: `mcp:${server}/${tool}`,
    prompt: { title: `Call ${server}.${tool}`, detail: clip(JSON.stringify(args, null, 2)) },
    execute: async () => ({
      ok: true,
      value: await ctx.pool.call(server, tool, args, ctx.signal)
    })
  }
}

function readOnly(execute: () => Promise<HostReply>): PlannedHostCall {
  return { gate: { kind: 'read' }, allowKey: 'read', prompt: NO_PROMPT, execute }
}

/** Validates one host call from the sandbox and maps it to its gate check and executor. */
export async function planHostCall(call: HostCall, ctx: HostCallContext): Promise<PlannedHostCall> {
  const fields = fieldsOf(call.tool, call.input)
  const fileCtx = { root: ctx.root }
  switch (call.tool) {
    case 'read': {
      const input = {
        path: text('read', fields, 'path'),
        offset: optionalNumber('read', fields, 'offset'),
        limit: optionalNumber('read', fields, 'limit')
      }
      return readOnly(() => readFileTool(input, fileCtx))
    }
    case 'grep': {
      const input = {
        pattern: text('grep', fields, 'pattern'),
        path: optionalText('grep', fields, 'path'),
        glob: optionalText('grep', fields, 'glob')
      }
      return readOnly(() => grepTool(input, fileCtx))
    }
    case 'find': {
      const input = {
        pattern: text('find', fields, 'pattern'),
        path: optionalText('find', fields, 'path')
      }
      return readOnly(() => findTool(input, fileCtx))
    }
    case 'mcp.list':
      return readOnly(async () => ({ ok: true, value: ctx.pool.list() }))
    case 'mcp.describe': {
      // Why: gated as a read; an unstarted server still goes through the pool's start approval.
      const server = knownServer(ctx.pool, text('mcp.describe', fields, 'server'))
      return readOnly(async () => ({ ok: true, value: await ctx.pool.describe(server) }))
    }
    case 'mcp.call':
      return planMcpCall(fields, ctx)
    case 'write':
    case 'edit':
      return planFileChange(call.tool, fields, ctx)
    case 'bash': {
      const cmd = text('bash', fields, 'cmd')
      const timeoutMs = optionalNumber('bash', fields, 'timeout')
      return {
        gate: { kind: 'bash' },
        allowKey: 'bash',
        prompt: { title: 'Run a shell command', detail: clip(cmd) },
        execute: async () => ({
          ok: true,
          value: await runBash(cmd, {
            cwd: ctx.root,
            env: ctx.env,
            timeoutMs,
            signal: ctx.signal,
            limits: ctx.limits
          })
        })
      }
    }
    default:
      throw new Error(`unknown host tool ${call.tool}`)
  }
}
