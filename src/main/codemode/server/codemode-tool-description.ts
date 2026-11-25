const PRELUDE_NAMES = new Set(['list', 'describe', 'call'])
const MAX_LIB_SIGNATURES = 60

export type CodemodeToolDescriptionInput = {
  servers: string[]
  /** The chat can call Orca's own actions as `orca.*`; absent access, the line is left out. */
  orca: boolean
  /** Saved function signatures (`name({a, b})`); absent, the chat has no `lib.*` and the line is left out. */
  lib?: string[]
}

/** The `run_js` description shown to the agent; at most ~150 words. */
export function buildToolDescription(input: CodemodeToolDescriptionInput): string {
  const servers = input.servers.length > 0 ? input.servers.join(', ') : 'none configured'
  const shadowed = input.servers.filter((name) => PRELUDE_NAMES.has(name))
  const lines = [
    'Run JavaScript that calls tools. Use this for 3 or more tool calls instead of calling tools one by one.',
    'Write the body of an async function: always `await` tool calls, never `.then`, and `return` the result.',
    'Available: mcp.<server>.<tool>(args), mcp.list(), mcp.describe(server), read({path}), write({path,content}),',
    'edit({path,old_string,new_string}), grep({pattern,path?,glob?}), find({pattern,path?}),',
    'bash(cmd, {timeout?}) -> {exit_code, output} (timeout in seconds), print(...values).',
    'MCP tool results are an object when the tool returns structured content, otherwise text (JSON.parse it if it is JSON).',
    `MCP servers: ${servers}.`,
    "Call mcp.describe(server) before using a server's tools for the first time."
  ]
  if (input.orca) {
    lines.push(
      "orca.areas(), orca.describe(area or method), orca.<area>.<method>(params) for Orca's own actions; orca.context() for this chat's ids."
    )
  }
  if (input.lib) {
    lines.push(
      'lib.<name>(args), lib.list(), lib.describe(name), lib.save({name, source, scope?, description?}) for saved functions;' +
        ' `source` must declare `async function <name>({...})` taking one object argument.'
    )
  }
  if (input.lib && input.lib.length > 0) {
    const more = input.lib.length - MAX_LIB_SIGNATURES
    const shown = input.lib.slice(0, MAX_LIB_SIGNATURES).join(', ')
    lines.push(`Saved functions: ${shown}${more > 0 ? ` (+${more} more: lib.list())` : ''}.`)
  }
  if (shadowed.length > 0) {
    lines.push(`Call ${shadowed.join(', ')} through mcp.call(server, tool, args).`)
  }
  return lines.join('\n')
}
