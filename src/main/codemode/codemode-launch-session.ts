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
import type { CodemodeServerSpec } from './mcp-pool/codemode-mcp-config'
import { createOrcaRpcAccess } from './orca/codemode-orca-dispatch'

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
    limits: CODEMODE_LIMITS,
    onEvent: deps.onEvent,
    onRun: deps.onRun,
    ...(deps.workerPath ? { workerPath: deps.workerPath } : {})
  })
}
