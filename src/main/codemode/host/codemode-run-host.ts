import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { CodemodeLimits } from '../codemode-limits'
import type { GateMode } from '../gate/codemode-gate'
import type { CodemodeLibAccess } from '../lib/codemode-lib-host-plan'
import type { CodemodeConnectorAccess } from '../mcp-pool/codemode-mcp-connector-access'
import { CodemodeMcpPool, type CodemodeServerSpec } from '../mcp-pool/codemode-mcp-pool'
import type { OrcaRpcAccess } from '../orca/codemode-orca-dispatch'
import { formatScriptResult, type InnerCallLine, trimOutput } from '../sandbox/codemode-output-trim'
import type { HostCall, HostReply } from '../sandbox/codemode-script-runner'
import { runScriptInWorker } from '../sandbox/codemode-worker-run'
import {
  type Approver,
  CodemodeApprovals,
  DENIED_TEXT,
  deniedCallText,
  INTERRUPTED_TEXT,
  UNSUPPORTED_TEXT
} from './codemode-approvals'
import { hostCallLabel, planHostCall, serverStartCheck } from './codemode-host-dispatch'

export type { ApprovalDecision, ApprovalRequest, Approver } from './codemode-approvals'

/** `seq` numbers the inner calls of one run; `running` and its final state share it. */
export type InnerCallEvent = {
  runId: string
  seq: number
  tool: string
  input: unknown
  state: 'running' | 'ok' | 'error'
  ms?: number
  output?: string
}

/** A run's start (`running`) and its end, which carries the run's wall time. */
export type CodemodeRunEvent = {
  runId: string
  code: string
  state: 'running' | 'ok' | 'error'
  ms?: number
}

export type CodemodeSessionOptions = {
  sessionId: string
  root: string
  env: NodeJS.ProcessEnv
  mode: () => GateMode
  trusted: (server: string) => boolean
  specs: CodemodeServerSpec[]
  /** Remote connectors this chat may call; they win over a local server of the same name. */
  connectors?: CodemodeConnectorAccess
  /** Orca runtime methods as `orca.*`; absent, every `orca.*` call fails. */
  orca?: OrcaRpcAccess
  /** Saved functions as `lib.*`; absent, every `lib.*` call fails. */
  lib?: CodemodeLibAccess
  limits: CodemodeLimits
  onEvent: (event: InnerCallEvent) => void
  onRun?: (event: CodemodeRunEvent) => void
  /** Bundled worker entry; tests pass their own build. */
  workerPath?: string
}

type RunState = {
  runId: string
  approver: Approver
  /** The agent connection the run came in on; allow_session answers stay with it. */
  connection: object
  signal: AbortSignal
  seq: number
  /** Server starts the approver refused in this run; not asked again until the next run. */
  refusedStarts: Map<string, string>
  /** This run's settled inner calls, listed in its text result. */
  calls: InnerCallLine[]
  /** This run's `lib.*` loads by function and hash, so concurrent loads share one trust card. */
  trustLoads: Map<string, Promise<HostReply>>
}

const EVENT_OUTPUT_BYTES = 8 * 1024

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Replies cross a worker boundary, so anything that is not plain JSON becomes text. */
function plainValue(value: unknown): unknown {
  if (value === undefined) {
    return null
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : JSON.parse(json)
  } catch {
    return String(value)
  }
}

function eventOutput(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  return trimOutput(raw ?? String(value), EVENT_OUTPUT_BYTES)
}

/** One per native-chat session: runs agent scripts and routes each inner call through the gate. */
export class CodemodeSession {
  readonly sessionId: string
  private readonly pool: CodemodeMcpPool
  private readonly approvals: CodemodeApprovals
  private readonly runScope = new AsyncLocalStorage<RunState>()
  private readonly activeRuns = new Set<AbortController>()
  private closed = false

  constructor(private readonly opts: CodemodeSessionOptions) {
    this.sessionId = opts.sessionId
    this.approvals = new CodemodeApprovals(opts.mode)
    this.pool = new CodemodeMcpPool(opts.specs, {
      cwd: opts.root,
      env: opts.env,
      approveStart: (spec) => this.approveStart(spec),
      ...(opts.connectors ? { connectors: opts.connectors } : {})
    })
  }

  serverNames(): string[] {
    return this.pool.names()
  }

  /** Whether this chat can call Orca's own actions as `orca.*`. */
  hasOrca(): boolean {
    return this.opts.orca !== undefined
  }

  async run(
    code: string,
    opts: { signal: AbortSignal; approver: Approver; connection?: object }
  ): Promise<{ text: string; isError: boolean }> {
    if (this.closed) {
      return { text: 'Error: code mode session is closed', isError: true }
    }
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort()
    opts.signal.addEventListener('abort', forwardAbort, { once: true })
    if (opts.signal.aborted) {
      controller.abort()
    }
    this.activeRuns.add(controller)
    const run: RunState = {
      runId: randomUUID(),
      approver: opts.approver,
      // Without a connection, an allow_session answer lasts only this run.
      connection: opts.connection ?? {},
      signal: controller.signal,
      seq: 0,
      refusedStarts: new Map(),
      calls: [],
      trustLoads: new Map()
    }
    this.pool.newTurn()
    const started = performance.now()
    this.reportRun({ runId: run.runId, code, state: 'running' })
    let failed = true
    try {
      const result = await runScriptInWorker(
        code,
        (call) => this.hostCall(run, call),
        this.opts.limits,
        controller.signal,
        this.opts.workerPath
      )
      const formatted = formatScriptResult(result, this.opts.limits.outputBytes, run.calls)
      failed = formatted.isError
      return formatted
    } finally {
      const ms = Math.round(performance.now() - started)
      this.reportRun({ runId: run.runId, code, state: failed ? 'error' : 'ok', ms })
      opts.signal.removeEventListener('abort', forwardAbort)
      // Why: a script may return while host work it never awaited (bash, MCP, approval) is still running.
      controller.abort()
      this.activeRuns.delete(controller)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const controller of this.activeRuns) {
      controller.abort()
    }
    await this.pool.close()
  }

  private reportRun(event: CodemodeRunEvent): void {
    try {
      this.opts.onRun?.(event)
    } catch {
      // A failing listener must not fail the script.
    }
  }

  private async hostCall(run: RunState, call: HostCall): Promise<HostReply> {
    const seq = ++run.seq
    const started = performance.now()
    const shown = hostCallLabel(call)
    const emit = (state: InnerCallEvent['state'], output?: string): void => {
      const timing = state === 'running' ? {} : { ms: Math.round(performance.now() - started) }
      if (timing.ms !== undefined) {
        run.calls.push({ tool: shown.tool, ok: state === 'ok', ms: timing.ms })
      }
      try {
        this.opts.onEvent({ runId: run.runId, seq, ...shown, state, ...timing, output })
      } catch {
        // A failing listener must not fail the script's call.
      }
    }
    emit('running')
    const executed = await this.execute(run, call)
    // A denial here may be the call's own or its server's start; either way it names this call.
    const reply: HostReply =
      !executed.ok && executed.error === DENIED_TEXT
        ? { ok: false, error: deniedCallText(shown.tool) }
        : executed
    if (reply.ok) {
      emit('ok', eventOutput(reply.value))
    } else {
      emit('error', reply.error)
    }
    return reply
  }

  private async execute(run: RunState, call: HostCall): Promise<HostReply> {
    try {
      const planned = await planHostCall(call, {
        root: this.opts.root,
        env: this.opts.env,
        limits: this.opts.limits,
        pool: this.pool,
        trusted: this.opts.trusted,
        signal: run.signal,
        orca: this.opts.orca,
        lib: this.opts.lib,
        check: (check) => this.approvals.check(check, run),
        trustLoads: run.trustLoads
      })
      const refusal = await this.approvals.check(planned, run)
      if (refusal !== null) {
        return { ok: false, error: refusal }
      }
      if (run.signal.aborted) {
        return { ok: false, error: INTERRUPTED_TEXT }
      }
      // Why: the pool asks approveStart from inside this call; the scope tells it which run asked.
      const reply = await this.runScope.run(run, planned.execute)
      return reply.ok ? { ok: true, value: plainValue(reply.value) } : reply
    } catch (error) {
      return { ok: false, error: run.signal.aborted ? INTERRUPTED_TEXT : errorText(error) }
    }
  }

  private async approveStart(spec: CodemodeServerSpec): Promise<boolean> {
    const run = this.runScope.getStore()
    if (!run) {
      return false
    }
    const earlier = run.refusedStarts.get(spec.name)
    if (earlier !== undefined) {
      throw new Error(earlier)
    }
    const refusal = await this.approvals.check(serverStartCheck(spec), run)
    if (refusal === null) {
      return true
    }
    if (refusal === DENIED_TEXT || refusal === UNSUPPORTED_TEXT) {
      run.refusedStarts.set(spec.name, refusal)
    }
    throw new Error(refusal)
  }
}
