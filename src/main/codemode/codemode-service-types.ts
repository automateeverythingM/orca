import type { CodemodeConnector } from '../../shared/codemode/codemode-connector-types'
import type { BotToolRelay } from '../bots/tool-relay/bot-tool-relay'
import type { ConnectorStatus, CodemodeConnectorAuth } from './connectors/codemode-connector-auth'
import type { CodemodeConnectorPool } from './connectors/codemode-connector-pool'
import type { CodemodeSessionOptionsAccess } from './connectors/codemode-connector-session-switch'
import type { CodemodeConnectorStore } from './connectors/codemode-connector-store'
import type { GateMode } from './gate/codemode-gate'
import type { CodemodeSession, InnerCallEvent } from './host/codemode-run-host'
import type { OrcaRpcAccessDeps } from './orca/codemode-orca-dispatch'
import type { CodemodeRunStore } from './runs/codemode-run-store'
import type { CodemodeHttpServer } from './server/codemode-http-server'

/** Orca's runtime methods and dispatcher; each launched chat gets its own access over them. */
export type CodemodeOrcaRpc = Pick<OrcaRpcAccessDeps, 'methods' | 'dispatch'>

/** A chat's worktree and workspace ids as its live session record says now. */
export type CodemodeSessionContext = (
  sessionId: string
) => { worktreeId?: string; workspaceId?: string } | undefined

export type CodemodeLaunchInput = {
  sessionId: string
  /** The startup attempt this launch is for: only its own teardown may end it. */
  launchId: string
  /** The session's launch directory. */
  root: string
  /** The session's launch environment. */
  env: NodeJS.ProcessEnv
  /** Read on every inner call, so a mode change applies to the next one. */
  mode: () => GateMode
}

export type CodemodeInnerCallListener = (sessionId: string, event: InnerCallEvent) => void

export type CodemodeServerHost = Pick<
  CodemodeHttpServer,
  'start' | 'register' | 'unregister' | 'stop' | 'resolveToken'
>
export type ConnectorRelay = Pick<BotToolRelay, 'addRoute' | 'origin' | 'endCaller'>

export type LiveLaunch = {
  launchId: string
  session: CodemodeSession
  /** The child this launch spawned, once its acquisition succeeded. */
  generation?: string
  /** Ends seen before the child was known: an early end of this launch's own child stays owed. */
  earlyEnds: Set<string>
}

export type CodemodeServiceOptions = {
  log?: (message: string, error?: unknown) => void
  /** Tests only. */
  server?: CodemodeServerHost
  /** Tests only; default is the bundled worker entry. */
  workerPath?: string
  /** Where runs are kept for the chat to show; default is the process's store. */
  runs?: CodemodeRunStore
  /** Opened on the first launch; absent: chats get no connectors. */
  connectors?: () => Promise<CodemodeConnectorWiring>
  /** Local MCP server names whose calls need no approval; read on every call. */
  trustedServers?: () => readonly string[]
  /** Where each chat's connector switches are kept; default is memory. */
  sessionOptions?: CodemodeSessionOptionsAccess
  /** Serves connectors to agents directly; default is the process's tool relay. */
  relay?: ConnectorRelay
  /** Orca's runtime as `orca.*` in scripts; absent, `orca.*` calls fail. */
  orcaRpc?: CodemodeOrcaRpc
  /** A chat's worktree/workspace ids for `orca.context()`, read per call. */
  sessionContext?: CodemodeSessionContext
}

export type CodemodeConnectorWiring = {
  store: CodemodeConnectorStore
  auth: CodemodeConnectorAuth
  pool: CodemodeConnectorPool
}

export type CodemodeSessionConnector = {
  connector: CodemodeConnector
  /** This chat's switch; a connector off globally stays `on` here but is still unusable. */
  on: boolean
  status: ConnectorStatus
}
