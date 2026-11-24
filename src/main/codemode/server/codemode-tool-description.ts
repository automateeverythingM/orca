const PRELUDE_NAMES = new Set(['list', 'describe', 'call'])

/** The `run_js` description shown to the agent; at most ~150 words. */
export function buildToolDescription(input: { servers: string[] }): string {
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
  if (shadowed.length > 0) {
    lines.push(`Call ${shadowed.join(', ')} through mcp.call(server, tool, args).`)
  }
  return lines.join('\n')
}
