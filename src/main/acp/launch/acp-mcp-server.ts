import type { InitializeResponse, McpServer } from '../generated/acp-protocol.generated'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'

/** An MCP server as a bot or an agent's config file names it. */
export type AcpMcpServerSource =
  | {
      name: string
      url: string
      transport?: 'http' | 'sse'
      headers?: Readonly<Record<string, string>>
    }
  | {
      name: string
      command: string
      args: readonly string[]
      env?: Readonly<Record<string, string>>
    }

const pairs = (record: Readonly<Record<string, string>> | undefined) =>
  Object.entries(record ?? {}).map(([name, value]) => ({ name, value }))

export function acpMcpServer(server: AcpMcpServerSource): McpServer {
  return 'url' in server
    ? {
        type: server.transport ?? 'http',
        name: server.name,
        url: server.url,
        headers: pairs(server.headers)
      }
    : { name: server.name, command: server.command, args: [...server.args], env: pairs(server.env) }
}

/** The launch's servers for this agent; the ones Orca serves need it to say it takes MCP over HTTP. */
export function acpSessionMcpServers(
  launch: { mcpServers?: McpServer[]; orcaMcpServerNames?: readonly string[] },
  initialized: Pick<InitializeResponse, 'agentCapabilities'>
): McpServer[] {
  const servers = launch.mcpServers ?? []
  return initialized.agentCapabilities?.mcpCapabilities?.http === true
    ? servers
    : servers.filter((server) => !launch.orcaMcpServerNames?.includes(server.name))
}

/** The chat's note that code mode's server didn't reach this agent; none when it did. */
export function acpCodemodeUnavailableRow(
  launch: { orcaMcpServerNames?: readonly string[] },
  served: readonly McpServer[],
  providerSessionId: string
): ProviderTimelineEvent[] {
  const unserved = (launch.orcaMcpServerNames ?? []).filter(
    (name) => !served.some((server) => server.name === name)
  )
  if (unserved.length === 0) {
    return []
  }
  return [
    {
      type: 'item.update',
      item: `codemode-unavailable:${providerSessionId}`,
      body: {
        kind: 'status',
        tone: 'warning',
        text: 'Code mode is unavailable for this agent: it cannot take MCP servers over HTTP.'
      },
      join: { thread: providerSessionId }
    }
  ]
}

/** Writes the note on the chat's lane when code mode didn't reach this agent. */
export function applyAcpCodemodeNote(
  lane: { apply(events: readonly ProviderTimelineEvent[]): void },
  launch: { orcaMcpServerNames?: readonly string[] },
  served: readonly McpServer[],
  providerSessionId: string
): void {
  const note = acpCodemodeUnavailableRow(launch, served, providerSessionId)
  if (note.length > 0) {
    lane.apply(note)
  }
}
