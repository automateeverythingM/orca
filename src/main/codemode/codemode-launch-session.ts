import { CODEMODE_LIMITS } from './codemode-limits'
import type {
  CodemodeConnectorWiring,
  CodemodeLaunchInput,
  CodemodeOrcaRpc,
  CodemodeSessionContext
} from './codemode-service-types'
import {
  codemodeServerTrust,
  connectorAccess
} from './connectors/codemode-connector-session-switch'
import {
  CodemodeSession,
  type CodemodeSessionOptions,
  type InnerCallEvent
} from './host/codemode-run-host'
import type { CodemodeLibAccess } from './lib/codemode-lib-host-plan'
import { CodemodeLibStore } from './lib/codemode-lib-store'
import type { CodemodeLibTrust } from './lib/codemode-lib-trust'
import type { CodemodeLibUsage } from './lib/codemode-lib-usage'
import type { CodemodeServerSpec } from './mcp-pool/codemode-mcp-config'
import { createOrcaRpcAccess } from './orca/codemode-orca-dispatch'

/** The trust and usage records every chat shares; one instance each, so their writes queue together. */
export type CodemodeLibRecords = {
  trust: CodemodeLibTrust
  usage: CodemodeLibUsage
  /** Home for global functions; default the user's home. */
  homeDir?: string
}

/** A chat's saved functions: project scope at its root, global in the records' home. */
export function libAccessFor(root: string, records: CodemodeLibRecords): CodemodeLibAccess {
  return {
    store: new CodemodeLibStore({ projectRoot: root, homeDir: records.homeDir }),
    trust: records.trust,
    usage: records.usage,
    projectRoot: root
  }
}

export type CodemodeLaunchSessionDeps = {
  input: CodemodeLaunchInput
  specs: CodemodeServerSpec[]
  /** The opened connector list and sign-ins; null: the chat gets no connectors. */
  wiring: CodemodeConnectorWiring | null
  connectorsOff: () => ReadonlySet<string>
  trustedServers: () => readonly string[]
  /** Absent: every `orca.*` call in this chat fails. */
  orcaRpc?: CodemodeOrcaRpc
  sessionContext?: CodemodeSessionContext
  /** Absent: every `lib.*` call in this chat fails. */
  lib?: CodemodeLibAccess
  onEvent: (event: InnerCallEvent) => void
  onRun: NonNullable<CodemodeSessionOptions['onRun']>
  workerPath?: string
}

/** One launch's code-mode session: its connectors, trust, and Orca access bound to the chat. */
export function createLaunchSession(deps: CodemodeLaunchSessionDeps): CodemodeSession {
  const { input, wiring } = deps
  const { sessionId, root } = input
  const connectors = wiring
    ? connectorAccess({ store: wiring.store, pool: wiring.pool, off: deps.connectorsOff })
    : undefined
  const { orcaRpc, sessionContext } = deps
  const orca = orcaRpc
    ? createOrcaRpcAccess({
        ...orcaRpc,
        sessionId,
        root,
        // Read per call: the record is the live one, not a launch-time copy.
        context: () => sessionContext?.(sessionId) ?? {}
      })
    : undefined
  return new CodemodeSession({
    sessionId,
    root,
    env: input.env,
    mode: input.mode,
    trusted: codemodeServerTrust({
      connectors,
      connectorTrusted: (name) => wiring?.store.byName(name)?.trusted === true,
      trustedServers: deps.trustedServers
    }),
    specs: deps.specs,
    ...(connectors ? { connectors } : {}),
    ...(orca ? { orca } : {}),
    ...(deps.lib ? { lib: deps.lib } : {}),
    limits: CODEMODE_LIMITS,
    onEvent: deps.onEvent,
    onRun: deps.onRun,
    ...(deps.workerPath ? { workerPath: deps.workerPath } : {})
  })
}
