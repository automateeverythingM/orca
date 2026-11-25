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
import { type CodemodeLearnRecorder, learnSessionHooks } from './learn/codemode-learn-recorder'
import type { CodemodeLibAccess } from './lib/codemode-lib-host-plan'
import type { CodemodeServerSpec } from './mcp-pool/codemode-mcp-config'
import { createOrcaRpcAccess } from './orca/codemode-orca-dispatch'
import type { CodemodeRunStore } from './runs/codemode-run-store'

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
  /** Learn's recorder and where a nudged run is marked; absent, runs are not recorded. */
  learn?: {
    recorder: CodemodeLearnRecorder
    annotate: (runId: string, patch: Parameters<CodemodeRunStore['annotate']>[2]) => void
  }
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
  const learn = deps.learn
    ? learnSessionHooks(deps.learn.recorder, {
        sessionId,
        projectRoot: root,
        annotate: deps.learn.annotate
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
    onRun: (event) => {
      // Before the run's first inner call, which Learn would otherwise drop.
      if (event.state === 'running') {
        learn?.begin(event.runId, event.code)
      }
      deps.onRun(event)
    },
    ...(learn ? { onCall: learn.onCall, onFinish: learn.onFinish } : {}),
    ...(deps.workerPath ? { workerPath: deps.workerPath } : {})
  })
}
