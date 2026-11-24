import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
  type VmCallResult
} from 'quickjs-emscripten-core'
import type { CodemodeLimits } from '../codemode-limits'
import { HOST_TOOLS, type HostCall, type HostReply, type ScriptHost } from './codemode-host-tools'
import { CODEMODE_PRELUDE } from './codemode-prelude'
import { ScriptPrintBuffer } from './codemode-print-buffer'
import {
  byteSizeText,
  hostErrorText,
  SCRIPT_FILE,
  thrownValueText,
  type ThrownFields,
  wrapScript
} from './codemode-script-error-text'

export type { HostCall, HostReply, ScriptHost } from './codemode-host-tools'
export type ScriptResult =
  | { ok: true; printed: string[]; value: unknown }
  | { ok: false; printed: string[]; error: string }

const PRELUDE_FILE = 'codemode-prelude'
const INTERRUPTED = 'Interrupted by user'
const UNSETTLED = 'script ended with an unsettled promise'

class QuickJsScriptRun {
  private readonly runtime: QuickJSRuntime
  private readonly context: QuickJSContext
  private readonly prints: ScriptPrintBuffer
  private readonly inFlight = new Set<QuickJSDeferredPromise>()
  private callCount = 0
  private jsUsedMs = 0
  private vmEnteredAt: number | undefined
  private stopError: string | undefined
  private finished = false
  private promise: QuickJSHandle | undefined
  private readThrown: QuickJSHandle | undefined
  private wakeUp: (() => void) | undefined
  private readonly wake = (): void => {
    const wakeUp = this.wakeUp
    this.wakeUp = undefined
    wakeUp?.()
  }

  constructor(
    module: QuickJSWASMModule,
    private readonly host: ScriptHost,
    private readonly limits: CodemodeLimits,
    private readonly signal: AbortSignal
  ) {
    this.prints = new ScriptPrintBuffer(limits.resultBytes)
    this.runtime = module.newRuntime()
    this.runtime.setMemoryLimit(limits.memoryBytes)
    this.runtime.setMaxStackSize(limits.stackBytes)
    this.runtime.setInterruptHandler(() => this.shouldInterrupt())
    this.context = this.runtime.newContext()
    this.context
      .newFunction('__host', (tool, input) => this.startHostCall(tool, input))
      .consume((fn) => this.context.setProp(this.context.global, '__host', fn))
    this.context
      .newFunction('__print', (line) => this.prints.add(this.context.getString(line)))
      .consume((fn) => this.context.setProp(this.context.global, '__print', fn))
    signal.addEventListener('abort', this.wake)
  }

  async run(code: string): Promise<ScriptResult> {
    try {
      return await this.drive(code)
    } catch (error) {
      return this.fail(this.stopError ?? hostErrorText(error))
    } finally {
      this.dispose()
    }
  }

  private async drive(code: string): Promise<ScriptResult> {
    this.readThrown = this.context.unwrapResult(
      this.enterVm(() => this.context.evalCode(CODEMODE_PRELUDE, PRELUDE_FILE))
    )
    const evaluated = this.enterVm(() => this.context.evalCode(wrapScript(code), SCRIPT_FILE))
    if (evaluated.error) {
      return this.failWithThrown(evaluated.error, code)
    }
    this.promise = evaluated.value
    for (;;) {
      if (this.signal.aborted) {
        this.stopError ??= INTERRUPTED
      }
      if (this.stopError !== undefined) {
        return this.fail(this.stopError)
      }
      const jobs = this.enterVm(() => this.runtime.executePendingJobs())
      if (jobs.error) {
        return this.failWithThrown(jobs.error, code)
      }
      if (this.stopError !== undefined) {
        return this.fail(this.stopError)
      }
      const state = this.context.getPromiseState(this.promise)
      if (state.type === 'fulfilled') {
        try {
          const value = this.enterVm(() => this.context.dump(state.value))
          // dump runs toJSON and getters, so the interrupt may have fired inside it.
          if (this.stopError !== undefined) {
            return this.fail(this.stopError)
          }
          return { ok: true, printed: this.prints.printed(), value }
        } finally {
          state.value.dispose()
        }
      }
      if (state.type === 'rejected') {
        return this.failWithThrown(state.error, code)
      }
      if (this.inFlight.size === 0) {
        return this.fail(UNSETTLED)
      }
      await new Promise<void>((resolve) => {
        this.wakeUp = resolve
      })
    }
  }

  private shouldInterrupt(): boolean {
    if (this.stopError === undefined && this.signal.aborted) {
      this.stopError = INTERRUPTED
    }
    if (this.stopError === undefined && this.jsElapsedMs() > this.limits.jsTimeMs) {
      this.stopError = `script exceeded ${this.limits.jsTimeMs / 1000}s JS time`
    }
    return this.stopError !== undefined
  }

  private jsElapsedMs(): number {
    const current = this.vmEnteredAt === undefined ? 0 : performance.now() - this.vmEnteredAt
    return this.jsUsedMs + current
  }

  // Only time spent executing inside QuickJS counts toward jsTimeMs; host calls run between entries.
  private enterVm<T>(fn: () => T): T {
    const enteredAt = performance.now()
    this.vmEnteredAt = enteredAt
    try {
      return fn()
    } finally {
      this.jsUsedMs += performance.now() - enteredAt
      this.vmEnteredAt = undefined
    }
  }

  private startHostCall(
    toolHandle: QuickJSHandle,
    inputHandle: QuickJSHandle
  ): QuickJSHandle | VmCallResult<QuickJSHandle> {
    const tool = this.context.getString(toolHandle)
    if (!HOST_TOOLS.has(tool)) {
      return { error: this.context.newError(`unknown host tool ${tool}`) }
    }
    if (this.callCount >= this.limits.maxCalls) {
      this.stopError ??= `call limit ${this.limits.maxCalls} reached`
      return { error: this.context.newError(`call limit ${this.limits.maxCalls} reached`) }
    }
    let input: unknown
    try {
      input = JSON.parse(this.context.getString(inputHandle))
    } catch {
      return { error: this.context.newError('host call input must be JSON') }
    }
    this.callCount++
    const deferred = this.context.newPromise()
    this.inFlight.add(deferred)
    void this.callHost({ tool, input }).then((reply) => this.settle(deferred, reply))
    return deferred.handle
  }

  private async callHost(call: HostCall): Promise<HostReply> {
    try {
      return await this.host(call)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private settle(deferred: QuickJSDeferredPromise, reply: HostReply): void {
    if (this.finished) {
      return
    }
    this.inFlight.delete(deferred)
    if (this.stopError === undefined) {
      try {
        this.context.newString(this.replyPayload(reply)).consume((value) => deferred.resolve(value))
      } catch (error) {
        this.stopError ??= hostErrorText(error)
      }
    }
    deferred.dispose()
    this.wake()
  }

  private replyPayload(reply: HostReply): string {
    let payload: string
    try {
      payload = JSON.stringify(reply.ok ? reply : { ok: false, error: String(reply.error) })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return JSON.stringify({ ok: false, error: `tool result is not JSON: ${reason}` })
    }
    if (Buffer.byteLength(payload, 'utf8') > this.limits.resultBytes) {
      const error = `tool result exceeds ${byteSizeText(this.limits.resultBytes)}`
      return JSON.stringify({ ok: false, error })
    }
    return payload
  }

  private failWithThrown(handle: QuickJSHandle, code: string): ScriptResult {
    try {
      return this.fail(this.stopError ?? this.describeThrown(handle, code))
    } finally {
      handle.dispose()
    }
  }

  private describeThrown(handle: QuickJSHandle, code: string): string {
    const reader = this.readThrown
    if (!reader) {
      return 'uncaught exception'
    }
    const read = this.enterVm(() =>
      this.context.callFunction(reader, this.context.undefined, handle)
    )
    if (read.error) {
      read.error.dispose()
      return this.stopError ?? 'uncaught exception could not be read'
    }
    const fields: ThrownFields = JSON.parse(
      read.value.consume((value) => this.context.getString(value))
    )
    return this.stopError ?? thrownValueText(fields, code, this.limits.memoryBytes)
  }

  private fail(error: string): ScriptResult {
    return { ok: false, printed: this.prints.printed(), error }
  }

  private dispose(): void {
    this.finished = true
    this.signal.removeEventListener('abort', this.wake)
    try {
      for (const deferred of this.inFlight) {
        deferred.dispose()
      }
      this.inFlight.clear()
      this.promise?.dispose()
      this.readThrown?.dispose()
      this.context.dispose()
      this.runtime.dispose()
    } catch {
      // A host stack overflow can leave the module inconsistent; it is dropped with this run.
    }
  }
}

export async function runScript(
  code: string,
  host: ScriptHost,
  limits: CodemodeLimits,
  signal: AbortSignal
): Promise<ScriptResult> {
  if (signal.aborted) {
    return { ok: false, printed: [], error: INTERRUPTED }
  }
  let module: QuickJSWASMModule
  try {
    // A fresh WebAssembly module per run so a corrupted or exhausted heap never leaks into the next.
    module = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC)
  } catch (error) {
    return { ok: false, printed: [], error: hostErrorText(error) }
  }
  return new QuickJsScriptRun(module, host, limits, signal).run(code)
}
