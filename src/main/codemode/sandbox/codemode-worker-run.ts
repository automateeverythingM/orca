import type { CodemodeLimits } from '../codemode-limits'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import { hostErrorText } from './codemode-script-error-text'
import type { ScriptHost, ScriptResult } from './codemode-script-runner'
import type { CodemodeWorkerInput, CodemodeWorkerMessage } from './codemode-worker-protocol'

// QuickJS enforces its own 512 KiB stack limit; Node's native stack must be larger so that limit trips first.
const WORKER_STACK_MB = 4

export function runScriptInWorker(
  code: string,
  host: ScriptHost,
  limits: CodemodeLimits,
  signal: AbortSignal,
  workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    'codemode-worker-entry.js'
  )
): Promise<ScriptResult> {
  if (signal.aborted) {
    return Promise.resolve({ ok: false, printed: [], error: 'Interrupted by user' })
  }
  return new Promise((resolve) => {
    const input: CodemodeWorkerInput = { code, limits }
    const worker = spawnWorkerThread(workerPath, {
      name: 'orca-codemode',
      workerData: input,
      execArgv: [],
      resourceLimits: { stackSizeMb: WORKER_STACK_MB }
    })
    let settled = false
    const finish = (result: ScriptResult): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => {
      finish({ ok: false, printed: [], error: 'Interrupted by user' })
      void worker.terminate()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    worker.on('message', (message: CodemodeWorkerMessage) => {
      if (settled) {
        return
      }
      if (message.type === 'done') {
        finish(message.result)
      } else if (message.type === 'call') {
        const { id, call } = message
        host(call)
          .catch((error: unknown) => ({ ok: false as const, error: hostErrorText(error) }))
          .then((reply) => {
            if (!settled) {
              worker.postMessage({ type: 'reply', id, reply } satisfies CodemodeWorkerMessage)
            }
          })
      }
    })
    worker.on('error', () => {})
    worker.once('exit', (code) => {
      finish({ ok: false, printed: [], error: `sandbox crashed (exit ${code})` })
    })
  })
}
