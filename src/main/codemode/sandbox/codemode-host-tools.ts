export type HostCall = { tool: string; input: unknown }
export type HostReply = { ok: true; value: unknown } | { ok: false; error: string }
export type ScriptHost = (call: HostCall) => Promise<HostReply>

/** The host tools a script may call through `__host`; the prelude wraps each one. */
export const HOST_TOOLS: ReadonlySet<string> = new Set([
  'mcp.list',
  'mcp.describe',
  'mcp.call',
  'orca.areas',
  'orca.describe',
  'orca.call',
  'orca.context',
  'read',
  'write',
  'edit',
  'grep',
  'find',
  'bash',
  'lib.list',
  'lib.describe',
  'lib.load',
  'lib.save'
])
