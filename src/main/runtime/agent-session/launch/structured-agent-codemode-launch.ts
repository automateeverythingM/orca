import type { ReadOnlySessionMode } from '../../../bots/bot-look-around-policy'
import type { BotToolServer } from '../../../../shared/bot-tools'
import { ENV_REFERENCING_AGENTS, SessionMcpTools } from '../../../mcp-servers/session-mcp-tools'
import type { CodemodeLaunchInput, CodemodeService } from '../../../codemode/codemode-service'
import type { CodemodeSessionOptionsAccess } from '../../../codemode/connectors/codemode-connector-session-switch'
import type { GateMode } from '../../../codemode/gate/codemode-gate'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionRecordStore } from '../records/agent-session-record-store'
import type { AgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  agentChatPermissionModes,
  savedChatPermissionMode
} from '../../../../shared/agent-launch/permissions/agent-chat-permission-support'

/** The code-mode token's variable, apart from the bot's and the host's so none replaces another. */
export const CODEMODE_TOKEN_ENV = 'ORCA_CODEMODE_TOKEN'

/**
 * `base` plus code mode's servers (`orca` first, then the chat's connectors) as `agent` takes them:
 * Claude and Pi name the token's variable wherever a server carries `orca`'s token.
 */
export function withCodemodeServers(
  base: SessionMcpTools,
  servers: readonly BotToolServer[],
  agent: string
): SessionMcpTools {
  const orca = servers[0]
  const authorization = orca && 'url' in orca ? orca.headers?.authorization : undefined
  if (!authorization || !ENV_REFERENCING_AGENTS.has(agent)) {
    return SessionMcpTools.withExtraServers(base, servers, {})
  }
  const token = authorization.replace(/^Bearer /, '')
  const referenced = servers.map((server): BotToolServer =>
    'url' in server && server.headers?.authorization === authorization
      ? {
          ...server,
          headers: { ...server.headers, authorization: `Bearer \${${CODEMODE_TOKEN_ENV}}` }
        }
      : server
  )
  return SessionMcpTools.withExtraServers(base, referenced, { [CODEMODE_TOKEN_ENV]: token })
}

/** Code mode for this runtime's launches: the setting, read per launch, and the process's service. */
export type StructuredCodemodeLaunch = {
  enabled: () => boolean
  service: Pick<CodemodeService, 'launchServer' | 'endSession'>
}

/** A chat's code-mode options kept on its session record, so a switch outlives the launch. */
export function codemodeRecordOptions(
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'updateRecord'>
): CodemodeSessionOptionsAccess {
  return {
    read: (sessionId) => store.getRecord(sessionId)?.options,
    writeOption: async (sessionId, key, value) => {
      const record = store.getRecord(sessionId)
      if (!record) {
        throw new Error(`unknown session ${sessionId}`)
      }
      // Why: an option pick merges its one key at apply time, so a concurrent model pick survives.
      const args = { sessionId, fence: record.lease.runtimeFence, key, value, now: Date.now() }
      await store.updateRecord(sessionId, {
        kind: 'pick-option',
        args: { ...args, models: undefined }
      })
    }
  }
}

/** The session's gate mode as its record says now, so a mode change applies to the next call. */
export function codemodeGateMode(
  readRecord: (sessionId: string) => Pick<AgentSessionRecord, 'provider' | 'permissionMode'> | null,
  readOnlySession: (sessionId: string) => ReadOnlySessionMode | null,
  sessionId: string,
  launched: AgentChatPermissionChoice | undefined
): () => GateMode {
  return () => {
    const record = readRecord(sessionId)
    if (readOnlySession(sessionId) || !record) {
      return 'read-only'
    }
    const support = agentChatPermissionModes(record.provider)
    return support ? savedChatPermissionMode(support, record.permissionMode) : (launched ?? 'ask')
  }
}

/** `tools` plus the session's `orca` run_js server and its connectors when code mode is on and serves. */
export async function withCodemodeTools(
  tools: SessionMcpTools,
  codemode: StructuredCodemodeLaunch | undefined,
  input: CodemodeLaunchInput & { agent: string }
): Promise<SessionMcpTools> {
  if (codemode?.enabled() !== true) {
    return tools
  }
  const { agent, ...launch } = input
  const servers = await codemode.service.launchServer(launch)
  return servers ? withCodemodeServers(tools, servers, agent) : tools
}

/** A launch's tools with code mode; marks `starts` when it opened a session that must be closed. */
export async function withSessionCodemode(
  tools: SessionMcpTools,
  sources: {
    store: Pick<AgentSessionRecordStore, 'selectWritableRecord'>
    readOnlySession?: (sessionId: string) => ReadOnlySessionMode | null
    codemode?: StructuredCodemodeLaunch
  },
  input: Omit<CodemodeLaunchInput, 'mode'> & {
    agent: string
    permissionMode: AgentChatPermissionChoice | undefined
    starts: { codemode: boolean }
  }
): Promise<SessionMcpTools> {
  const { starts, permissionMode, ...launch } = input
  const mode = codemodeGateMode(
    (id) => {
      const selected = sources.store.selectWritableRecord(id)
      return selected.kind === 'writable' ? selected.record : null
    },
    (id) => sources.readOnlySession?.(id) ?? null,
    launch.sessionId,
    permissionMode
  )
  const withCodemode = await withCodemodeTools(tools, sources.codemode, { ...launch, mode })
  starts.codemode ||= withCodemode !== tools
  return withCodemode
}

/**
 * A launch's MCP servers: the session's own (a bot's and the host list's), plus code mode's when
 * this launch starts a child and the setting is on.
 */
export async function launchToolServers(
  sources: Parameters<typeof withSessionCodemode>[1] & {
    resolveToolServers?: (record: AgentSessionRecord, root: string) => Promise<SessionMcpTools>
  },
  record: AgentSessionRecord,
  root: string,
  launch: {
    agent: string
    env: () => Promise<Record<string, string>>
    permissionMode: AgentChatPermissionChoice | undefined
    starts: { codemode: boolean; launchId: string } | undefined
  }
): Promise<SessionMcpTools> {
  const own = sources.resolveToolServers
    ? await sources.resolveToolServers(record, root)
    : SessionMcpTools.none
  const { starts } = launch
  // The setting first: a launch without code mode never resolves the agent's environment here.
  if (!starts || sources.codemode?.enabled() !== true) {
    return own
  }
  return withSessionCodemode(own, sources, {
    agent: launch.agent,
    sessionId: record.sessionId,
    root,
    env: await launch.env(),
    permissionMode: launch.permissionMode,
    launchId: starts.launchId,
    starts
  })
}

/** Closes the code-mode session a launch opened when that launch failed before any child started. */
export function closeUnlaunchedCodemode(
  codemode: StructuredCodemodeLaunch | undefined,
  sessionId: string,
  starts: { codemode: boolean; launchId: string }
): void {
  if (starts.codemode) {
    void codemode?.service.endSession(sessionId, starts.launchId)
  }
}

/** A chat's worktree/workspace ids from its live record, for `orca.context()`; empty when unknown. */
export function codemodeRecordContext(store: {
  getRecord(sessionId: string): Pick<AgentSessionRecord, 'location'> | null
}): (sessionId: string) => { worktreeId?: string; workspaceId?: string } {
  return (sessionId) => {
    const location = store.getRecord(sessionId)?.location
    if (!location) {
      return {}
    }
    const { workspaceId } = location
    // Why: a git-worktree workspace's id is its worktree id; a folder has no worktree.
    return location.workspaceKind === 'git-worktree'
      ? { worktreeId: workspaceId, workspaceId }
      : { workspaceId }
  }
}
