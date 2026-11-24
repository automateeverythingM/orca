import { resolve } from 'node:path'
import type { CodemodeLimits } from '../codemode-limits'
import { isConnectorIdentity } from '../mcp-pool/codemode-mcp-connector-access'
import type { CodemodeMcpPool, CodemodeServerSpec } from '../mcp-pool/codemode-mcp-pool'
import type { OrcaRpcAccess } from '../orca/codemode-orca-dispatch'
import { planOrcaHostCall } from '../orca/codemode-orca-host-plan'
import type { HostCall, HostReply } from '../sandbox/codemode-script-runner'
import { type GateCheck, READ_CHECK } from './codemode-approvals'
import {
  clipDetail as clip,
  type Fields,
  fieldsOf,
  isFields,
  optionalNumber,
  optionalText,
  text
} from './codemode-host-call-fields'
import { runBash } from './codemode-bash'
import {
  editFileTool,
  findTool,
  type FileToolContext,
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
  /** Absent: the chat has no Orca access and every `orca.*` call fails. */
  orca?: OrcaRpcAccess
}

/** A validated inner call: what the gate judges, and how to run it once allowed. */
export type PlannedHostCall = GateCheck & { execute: () => Promise<HostReply> }

function knownServer(pool: CodemodeMcpPool, server: string): string {
  const names = pool.names()
  if (!names.includes(server)) {
    throw new Error(`unknown MCP server ${server}; known: ${names.join(', ') || 'none'}`)
  }
  return server
}

/** Name and input shown for an inner call in the run view. */
export function hostCallLabel(call: HostCall): { tool: string; input: unknown } {
  if (call.tool === 'mcp.call' && isFields(call.input)) {
    const { server, tool, args } = call.input
    return { tool: `mcp.${String(server)}.${String(tool)}`, input: args }
  }
  if (call.tool === 'orca.call' && isFields(call.input)) {
    return { tool: `orca.${String(call.input.method)}`, input: call.input.params }
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

/**
 * Plans a file tool call: an inside path gets `inside`; an outside path gets a path-outside
 * check keyed by its real path, and only that check lets the tool reach outside.
 */
async function planPathCall(
  ctx: HostCallContext,
  path: string | undefined,
  inside: GateCheck,
  outside: { verb: string; detail: string },
  run: (fileCtx: FileToolContext) => Promise<HostReply>
): Promise<PlannedHostCall> {
  const target =
    path === undefined
      ? { path: ctx.root, inside: true }
      : await resolveInRoot(ctx.root, path).catch(() => ({
          path: resolve(ctx.root, path),
          inside: false
        }))
  // Why: the tool re-resolves the path, so a link swapped in after this check is still refused.
  if (target.inside) {
    return { ...inside, execute: () => run({ root: ctx.root }) }
  }
  return {
    gate: { kind: 'path-outside' },
    allowKey: `path-outside:${target.path}`,
    prompt: {
      title: `${outside.verb} ${target.path} (outside the workspace)`,
      detail: outside.detail
    },
    execute: () => run({ root: ctx.root, allowOutside: true })
  }
}

function planFileChange(
  tool: 'write' | 'edit',
  fields: Fields,
  ctx: HostCallContext
): Promise<PlannedHostCall> {
  const path = text(tool, fields, 'path')
  if (tool === 'write') {
    const input = { path, content: text(tool, fields, 'content') }
    const detail = clip(input.content)
    return planPathCall(
      ctx,
      path,
      { gate: { kind: 'write' }, allowKey: 'write', prompt: { title: `Write ${path}`, detail } },
      { verb: 'Write', detail },
      (fileCtx) => writeFileTool(input, fileCtx)
    )
  }
  const input = {
    path,
    old_string: text(tool, fields, 'old_string'),
    new_string: text(tool, fields, 'new_string')
  }
  const detail = clip(`- ${input.old_string}\n+ ${input.new_string}`)
  return planPathCall(
    ctx,
    path,
    { gate: { kind: 'write' }, allowKey: 'write', prompt: { title: `Edit ${path}`, detail } },
    { verb: 'Edit', detail },
    (fileCtx) => editFileTool(input, fileCtx)
  )
}

function planMcpCall(fields: Fields, ctx: HostCallContext): PlannedHostCall {
  const server = text('mcp.call', fields, 'server')
  // Why: resolved once; approvals cover this server only, and the call fails if the name moves.
  const identity = ctx.pool.identity(server)
  const tool = text('mcp.call', fields, 'tool')
  const args = fieldsOf('mcp.call', fields.args ?? {})
  const kind = isConnectorIdentity(identity) ? 'connector ' : ''
  return {
    gate: { kind: 'mcp', server, trusted: ctx.trusted(server) },
    allowKey: `mcp:${identity}/${tool}`,
    prompt: {
      title: `Call ${kind}${server}.${tool}`,
      detail: clip(JSON.stringify(args, null, 2))
    },
    execute: async () => {
      const result = await ctx.pool.call(server, tool, args, ctx.signal, identity)
      return { ok: true, value: result.structured === undefined ? result.text : result.structured }
    }
  }
}

function readOnly(execute: () => Promise<HostReply>): PlannedHostCall {
  return { ...READ_CHECK, execute }
}

/** Validates one host call from the sandbox and maps it to its gate check and executor. */
export async function planHostCall(call: HostCall, ctx: HostCallContext): Promise<PlannedHostCall> {
  const fields = fieldsOf(call.tool, call.input)
  switch (call.tool) {
    case 'read': {
      const input = {
        path: text('read', fields, 'path'),
        offset: optionalNumber('read', fields, 'offset'),
        limit: optionalNumber('read', fields, 'limit')
      }
      return planPathCall(
        ctx,
        input.path,
        READ_CHECK,
        { verb: 'Read', detail: input.path },
        (fileCtx) => readFileTool(input, fileCtx)
      )
    }
    case 'grep': {
      const input = {
        pattern: text('grep', fields, 'pattern'),
        path: optionalText('grep', fields, 'path'),
        glob: optionalText('grep', fields, 'glob')
      }
      const outside = { verb: 'Search', detail: clip(input.pattern) }
      return planPathCall(ctx, input.path, READ_CHECK, outside, (fileCtx) =>
        grepTool(input, fileCtx)
      )
    }
    case 'find': {
      const input = {
        pattern: text('find', fields, 'pattern'),
        path: optionalText('find', fields, 'path')
      }
      const outside = { verb: 'List files in', detail: clip(input.pattern) }
      return planPathCall(ctx, input.path, READ_CHECK, outside, (fileCtx) =>
        findTool(input, fileCtx)
      )
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
      // Why: scripts give `timeout` in seconds; runBash clamps the ms value to bashMaxMs.
      const timeoutSeconds = optionalNumber('bash', fields, 'timeout')
      const timeoutMs =
        timeoutSeconds === undefined
          ? undefined
          : Math.min(timeoutSeconds * 1000, ctx.limits.bashMaxMs)
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
    case 'orca.areas':
    case 'orca.describe':
    case 'orca.context':
    case 'orca.call':
      return planOrcaHostCall(call.tool, fields, ctx.orca, ctx.signal)
    default:
      throw new Error(`unknown host tool ${call.tool}`)
  }
}
