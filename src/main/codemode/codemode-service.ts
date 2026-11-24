import type { BotToolServer } from '../../shared/bot-tools'
import { CODEMODE_LIMITS } from './codemode-limits'
import type { GateMode } from './gate/codemode-gate'
import { CodemodeSession, type InnerCallEvent } from './host/codemode-run-host'
import { readCodemodeServerSpecs } from './mcp-pool/codemode-mcp-config'
import { type CodemodeRunStore, processCodemodeRunStore } from './runs/codemode-run-store'
import { CodemodeHttpServer } from './server/codemode-http-server'

export type CodemodeLaunchInput = {
  sessionId: string
  /** The session's launch directory. */
  root: string
  /** The session's launch environment. */
  env: NodeJS.ProcessEnv
  /** Read on every inner call, so a mode change applies to the next one. */
  mode: () => GateMode
}

export type CodemodeInnerCallListener = (sessionId: string, event: InnerCallEvent) => void

type CodemodeServerHost = Pick<CodemodeHttpServer, 'start' | 'register' | 'unregister' | 'stop'>

export type CodemodeServiceOptions = {
  log?: (message: string, error?: unknown) => void
  /** Tests only. */
  server?: CodemodeServerHost
  /** Tests only; default is the bundled worker entry. */
  workerPath?: string
  /** Where runs are kept for the chat to show; default is the process's store. */
  runs?: CodemodeRunStore
}

/** One per process: the loopback run_js server and each structured session's code-mode session. */
export class CodemodeService {
  private readonly server: CodemodeServerHost
  private readonly sessions = new Map<string, CodemodeSession>()
  private readonly listeners = new Set<CodemodeInnerCallListener>()
  private readonly log: (message: string, error?: unknown) => void
  private readonly runs: CodemodeRunStore
  private startFailureLogged = false

  constructor(private readonly opts: CodemodeServiceOptions = {}) {
    this.server = opts.server ?? new CodemodeHttpServer()
    this.runs = opts.runs ?? processCodemodeRunStore()
    this.log = opts.log ?? ((message, error) => console.warn(`[codemode] ${message}`, error ?? ''))
  }

  onInnerCall(listener: CodemodeInnerCallListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The session's `orca` server with a fresh token; null when code mode can't serve it. */
  async launchServer(input: CodemodeLaunchInput): Promise<BotToolServer | null> {
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
      const session = new CodemodeSession({
        sessionId,
        root: input.root,
        env: input.env,
        mode: input.mode,
        trusted: () => false,
        specs,
        limits: CODEMODE_LIMITS,
        onEvent: (event) => this.emit(sessionId, event),
        onRun: (event) => this.runs.run(sessionId, event),
        ...(this.opts.workerPath ? { workerPath: this.opts.workerPath } : {})
      })
      const previous = this.sessions.get(sessionId)
      this.sessions.set(sessionId, session)
      const token = this.server.register(sessionId, session, () => ({
        servers: session.serverNames()
      }))
      void previous?.close()
      return {
        name: 'orca',
        url: `${origin}/codemode/mcp`,
        transport: 'http',
        headers: { authorization: `Bearer ${token}` }
      }
    } catch (error) {
      this.log(`code mode could not open for session ${sessionId}`, error)
      return null
    }
  }

  /** Revokes the session's token before closing its MCP servers. */
  endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    this.runs.dropSession(sessionId)
    // Why: unregister revokes synchronously, so a relaunch registering after this keeps its token.
    const unregistered = this.server.unregister(sessionId)
    return unregistered.then(() => session?.close())
  }

  async stop(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.endSession(sessionId)))
    await this.server.stop()
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

let processService: CodemodeService | null = null

/** The process's one service; the first caller's options win. */
export function processCodemodeService(opts?: CodemodeServiceOptions): CodemodeService {
  return (processService ??= new CodemodeService(opts))
}
