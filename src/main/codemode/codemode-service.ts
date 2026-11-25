import type { BotToolServer } from '../../shared/bot-tools'
import { botToolRelay } from '../bots/tool-relay/bot-tool-relay'
import { createLaunchSession } from './codemode-launch-session'
import type {
  CodemodeConnectorWiring,
  CodemodeInnerCallListener,
  CodemodeLaunchInput,
  CodemodeOrcaRpc,
  CodemodeServerHost,
  CodemodeServiceOptions,
  CodemodeSessionConnector,
  ConnectorRelay,
  LiveLaunch
} from './codemode-service-types'
import {
  codemodeCallerKey,
  connectorRelayServers,
  createConnectorRelayRoute
} from './connectors/codemode-connector-relay-route'
import {
  type CodemodeSessionOptionsAccess,
  memorySessionOptions,
  CONNECTORS_OFF_OPTION,
  connectorsOffValue,
  readConnectorsOff
} from './connectors/codemode-connector-session-switch'
import type { InnerCallEvent } from './host/codemode-run-host'
import { CodemodeLearnRecorder, workerLearnStore } from './learn/codemode-learn-recorder'
import type { CodemodeLearnRemote } from './learn/store/codemode-learn-ops'
import { type CodemodeLibRecords, createLibRecords, openChatLib } from './lib/codemode-lib-access'
import { readCodemodeServerSpecs } from './mcp-pool/codemode-mcp-config'
import { type CodemodeRunStore, processCodemodeRunStore } from './runs/codemode-run-store'
import { CodemodeHttpServer } from './server/codemode-http-server'

export type {
  CodemodeConnectorWiring,
  CodemodeInnerCallListener,
  CodemodeLaunchInput,
  CodemodeOrcaRpc,
  CodemodeServiceOptions,
  CodemodeSessionConnector,
  CodemodeSessionContext
} from './codemode-service-types'

/** One per process: the loopback run_js server and each structured session's code-mode session. */
export class CodemodeService {
  private readonly server: CodemodeServerHost
  private readonly sessions = new Map<string, LiveLaunch>()
  private readonly listeners = new Set<CodemodeInnerCallListener>()
  private readonly log: (message: string, error?: unknown) => void
  private readonly runs: CodemodeRunStore
  private readonly sessionOptions: CodemodeSessionOptionsAccess
  private readonly switchWrites = new Map<string, Promise<void>>()
  private connectorWiring: CodemodeConnectorWiring | null = null
  private connectorOpening: Promise<CodemodeConnectorWiring | null> | null = null
  private startFailureLogged = false
  private readonly relay: ConnectorRelay
  private removeRelayRoute: (() => void) | null = null
  private orcaRpc: CodemodeOrcaRpc | undefined
  private readonly lib: CodemodeLibRecords
  private readonly learnStores: ReturnType<typeof workerLearnStore>
  private readonly learn: CodemodeLearnRecorder

  constructor(private readonly opts: CodemodeServiceOptions = {}) {
    this.server = opts.server ?? new CodemodeHttpServer()
    this.runs = opts.runs ?? processCodemodeRunStore()
    this.sessionOptions = opts.sessionOptions ?? memorySessionOptions()
    this.relay = opts.relay ?? botToolRelay
    this.log = opts.log ?? ((message, error) => console.warn(`[codemode] ${message}`, error ?? ''))
    this.orcaRpc = opts.orcaRpc
    this.lib = createLibRecords(opts.libHomeDir)
    this.learnStores = workerLearnStore(opts.learnStore)
    this.learn = new CodemodeLearnRecorder({
      enabled: () => this.learnEnabled(),
      store: () => this.learnStore(),
      log: this.log
    })
  }

  /** The Learn switch as the settings say now. */
  learnEnabled(): boolean {
    return this.opts.learnEnabled?.() === true
  }

  /** The profile's Learn store; its worker starts on the first call and stops with the service. */
  learnStore(): CodemodeLearnRemote {
    return this.learnStores.store()
  }

  /** Stops the Learn worker so its file can be deleted, dropping runs in flight so none lands in a
   *  new file; the next `learnStore()` starts a new one. */
  closeLearnStore(): Promise<void> {
    this.learn.dropPending()
    return this.learnStores.close()
  }

  /** The saved-function trust and usage records all chats share; Settings must use these too. */
  libRecords(): CodemodeLibRecords {
    return this.lib
  }

  /** Orca's runtime for launches from now on; a launched chat keeps the access it opened with. */
  setOrcaRpc(orcaRpc: CodemodeOrcaRpc): void {
    this.orcaRpc = orcaRpc
  }

  onInnerCall(listener: CodemodeInnerCallListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * The session's `orca` server with a fresh token, then one server per connector it can use now,
   * all with that token; null when code mode can't serve it.
   */
  async launchServer(input: CodemodeLaunchInput): Promise<BotToolServer[] | null> {
    let origin: string
    try {
      ;({ origin } = await this.server.start())
      this.startFailureLogged = false
    } catch (error) {
      if (!this.startFailureLogged) {
        this.startFailureLogged = true
        this.log('the code-mode server did not start; chats launch without run_js', error)
      }
      return null
    }
    const { sessionId } = input
    try {
      const { specs, problems } = await readCodemodeServerSpecs(input.root)
      if (problems.length > 0) {
        this.log(`MCP config problems for session ${sessionId}: ${problems.join('; ')}`)
      }
      const wiring = await this.openConnectors()
      const { lib, signatures } = await openChatLib(input.root, this.lib, (message, error) =>
        this.log(`${message} for session ${sessionId}`, error)
      )
      const session = createLaunchSession({
        input,
        specs,
        wiring,
        connectorsOff: () => this.connectorsOff(sessionId),
        trustedServers: this.opts.trustedServers ?? (() => []),
        ...(this.orcaRpc ? { orcaRpc: this.orcaRpc } : {}),
        ...(this.opts.sessionContext ? { sessionContext: this.opts.sessionContext } : {}),
        lib,
        onEvent: (event) => this.emit(sessionId, event),
        onRun: (event) => this.runs.run(sessionId, event),
        learn: {
          recorder: this.learn,
          annotate: (runId, patch) => this.runs.annotate(sessionId, runId, patch)
        },
        ...(this.opts.workerPath ? { workerPath: this.opts.workerPath } : {})
      })
      const previous = this.sessions.get(sessionId)
      if (previous && this.removeRelayRoute) {
        // Why: the old launch's relay calls and upstream sessions must not outlive its token.
        this.relay.endCaller(codemodeCallerKey(sessionId))
      }
      this.sessions.set(sessionId, { launchId: input.launchId, session, earlyEnds: new Set() })
      const token = this.server.register(sessionId, session, () => ({
        servers: session.serverNames(),
        orca: session.hasOrca(),
        lib: signatures
      }))
      void previous?.session.close()
      const authorization = `Bearer ${token}`
      const orca: BotToolServer = {
        name: 'orca',
        url: `${origin}/codemode/mcp`,
        transport: 'http',
        headers: { authorization }
      }
      const off = this.connectorsOff(sessionId)
      const direct = await connectorRelayServers(
        wiring?.store.list() ?? [],
        off,
        authorization,
        () => this.relayOrigin()
      ).catch((error: unknown) => {
        this.log(`connectors could not be served to session ${sessionId}; run_js has them`, error)
        return []
      })
      return [orca, ...direct]
    } catch (error) {
      this.log(`code mode could not open for session ${sessionId}`, error)
      return null
    }
  }

  /** Switches a connector off or on for one chat; the chat's next inner call sees it. */
  async setConnectorOff(sessionId: string, connectorId: string, off: boolean): Promise<void> {
    const wiring = await this.openConnectors()
    if (!wiring) {
      throw new Error('connectors unavailable')
    }
    if (off && !wiring.store.get(connectorId)) {
      throw new Error(`unknown connector: ${connectorId}`)
    }
    // Why: each write sets the whole id list, so one chat's switches must not interleave.
    const previous = this.switchWrites.get(sessionId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        const options = this.sessionOptions.read(sessionId)
        const ids = [...readConnectorsOff({ options })].filter(
          (id) => id !== connectorId && wiring.store.get(id)
        )
        const value = connectorsOffValue(options, off ? [...ids, connectorId] : ids)
        await this.sessionOptions.writeOption(sessionId, CONNECTORS_OFF_OPTION, value)
      })
    this.switchWrites.set(sessionId, next)
    try {
      await next
    } finally {
      if (this.switchWrites.get(sessionId) === next) {
        this.switchWrites.delete(sessionId)
      }
    }
  }

  /** Every connector with this chat's switch and its sign-in state; empty until connectors open. */
  connectorsForSession(sessionId: string): CodemodeSessionConnector[] {
    const wiring = this.connectorWiring
    if (!wiring) {
      return []
    }
    const off = this.connectorsOff(sessionId)
    return wiring.store.list().map((connector) => ({
      connector,
      on: !off.has(connector.id),
      status: wiring.auth.status(connector.id)
    }))
  }

  /** The tool relay's origin, serving connectors at `/c/<id>/mcp`; starts it if needed. */
  async relayOrigin(): Promise<string> {
    this.removeRelayRoute ??= this.relay.addRoute(createConnectorRelayRoute(this))
    await this.openConnectors()
    return this.relay.origin()
  }

  /** The live session a code-mode token belongs to; null once its session ended. */
  resolveToken(token: string): string | null {
    return this.server.resolveToken(token)
  }

  /** The connector list and sign-ins once opened; null before or when they couldn't be. */
  openedConnectors(): CodemodeConnectorWiring | null {
    return this.connectorWiring
  }

  /**
   * Revokes the session's token before closing its MCP servers. With `launchId`, only while that
   * launch is still the session's current one: a superseded launch's teardown must not end a newer one.
   */
  endSession(sessionId: string, launchId?: string): Promise<void> {
    const live = this.sessions.get(sessionId)
    if (launchId !== undefined && live?.launchId !== launchId) {
      return Promise.resolve()
    }
    this.sessions.delete(sessionId)
    this.runs.dropSession(sessionId)
    // Why: unregister revokes synchronously, so a relaunch registering after this keeps its token.
    const unregistered = this.server.unregister(sessionId)
    if (this.removeRelayRoute) {
      this.relay.endCaller(codemodeCallerKey(sessionId))
    }
    return unregistered.then(() => live?.session.close())
  }

  /** Ties the launch to the child its acquisition produced, so that child's end ends it. */
  bindChild(sessionId: string, launchId: string, generation: string): void {
    const live = this.sessions.get(sessionId)
    if (!live || live.launchId !== launchId) {
      return
    }
    if (live.earlyEnds.has(generation)) {
      void this.endSession(sessionId, launchId)
      return
    }
    live.generation = generation
    live.earlyEnds.clear()
  }

  /** A child ended: ends the session's code mode only when that child is the current launch's. */
  endChild(sessionId: string, generation: string): Promise<void> {
    const live = this.sessions.get(sessionId)
    if (!live) {
      return Promise.resolve()
    }
    if (live.generation === undefined) {
      live.earlyEnds.add(generation)
      return Promise.resolve()
    }
    return live.generation === generation
      ? this.endSession(sessionId, live.launchId)
      : Promise.resolve()
  }

  async stop(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.endSession(sessionId)))
    await this.server.stop()
    this.removeRelayRoute?.()
    this.removeRelayRoute = null
    await this.connectorWiring?.pool.closeAll()
    await this.learnStores.close()
  }

  connectorsOff(sessionId: string): Set<string> {
    return readConnectorsOff({ options: this.sessionOptions.read(sessionId) })
  }

  /** The connector list and sign-ins, opened on first use; null when they can't be. */
  openConnectors(): Promise<CodemodeConnectorWiring | null> {
    const open = this.opts.connectors
    if (!open) {
      return Promise.resolve(null)
    }
    this.connectorOpening ??= open().then(
      (wiring) => (this.connectorWiring = wiring),
      (error: unknown) => {
        // A later launch tries again.
        this.connectorOpening = null
        this.log('MCP connectors could not be opened; chats launch without them', error)
        return null
      }
    )
    return this.connectorOpening
  }

  private emit(sessionId: string, event: InnerCallEvent): void {
    this.runs.innerCall(sessionId, event)
    for (const listener of this.listeners) {
      try {
        listener(sessionId, event)
      } catch (error) {
        this.log('an inner-call listener failed', error)
      }
    }
  }
}
