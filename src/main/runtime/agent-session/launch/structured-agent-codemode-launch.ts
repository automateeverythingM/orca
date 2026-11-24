import type { ReadOnlySessionMode } from '../../../bots/bot-look-around-policy'
import { type BotLaunchTools, withCodemodeServers } from '../../../bots/bot-launch-tools'
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
  tools: BotLaunchTools,
  codemode: StructuredCodemodeLaunch | undefined,
  input: CodemodeLaunchInput & { agent: string }
): Promise<BotLaunchTools> {
  if (codemode?.enabled() !== true) {
    return tools
  }
  const { agent, ...launch } = input
  const servers = await codemode.service.launchServer(launch)
  return servers ? withCodemodeServers(tools, servers, agent) : tools
}

/** A launch's tools with code mode; marks `starts` when it opened a session that must be closed. */
export async function withSessionCodemode(
  tools: BotLaunchTools,
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
): Promise<BotLaunchTools> {
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
