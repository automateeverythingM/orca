// Code mode's one Learn DB worker: started on first call, released when idle. A crash fails the calls
// it caught; the next call starts a new worker. The Learn store's SQL is reached only through it.
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../worker-threads/worker-thread-entry-path'
import { WorkerThreadRequestQueue } from '../../../worker-threads/worker-thread-request-queue'
import type {
  WorkerRequestTransport,
  WorkerThreadFactory
} from '../../../worker-threads/worker-thread-transport'
import { CODEMODE_LEARN_OPS, type CodemodeLearnRemote } from '../store/codemode-learn-ops'
import type {
  CodemodeLearnWorkerRequest,
  CodemodeLearnWorkerResponse
} from './codemode-learn-worker-protocol'

const WORKER_ENTRY_FILENAME = 'codemode-learn-worker-entry.js'
// One call's budget from dispatch: a cold open (schema, WAL) plus a lock wait.
const OPERATION_TIMEOUT_MS = 10_000
const IDLE_TEARDOWN_MS = 60_000
const MAX_QUEUED_CALLS = 200

function spawnCodemodeLearnWorker(): WorkerRequestTransport {
  return spawnWorkerThread(
    resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_ENTRY_FILENAME),
    { name: 'orca-codemode-learn' }
  )
}

export class CodemodeLearnWorkerClient {
  private readonly queue: WorkerThreadRequestQueue<
    CodemodeLearnWorkerRequest,
    CodemodeLearnWorkerResponse
  >

  constructor(
    factory: WorkerThreadFactory = spawnCodemodeLearnWorker,
    private readonly timeoutMs = OPERATION_TIMEOUT_MS
  ) {
    this.queue = new WorkerThreadRequestQueue({
      factory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      maxConsecutiveDeaths: 2,
      queueCap: {
        maxQueuedCalls: MAX_QUEUED_CALLS,
        describeFull: (request) => `too many waiting Learn calls, ${request.op} refused`
      },
      // A timed-out transaction can still be inside SQLite; never start a second worker beside it.
      awaitRetirement: true,
      createUnavailableError: (message) => new Error(message),
      describeTimeout: (ms) => `the Learn DB worker timed out after ${ms}ms`,
      describeExit: (code) => `the Learn DB worker exited with code ${code}`,
      describeCrashLoop: (lastError) => `the Learn DB worker crashed repeatedly: ${lastError}`,
      onUnavailable: (error) => console.warn('[codemode] Learn DB worker unavailable:', error)
    })
  }

  /** One store call in the worker; a store's refusal comes back as a rejected promise. */
  async call(path: string, op: string, args: unknown[]): Promise<unknown> {
    const response = await this.queue.dispatch((id) => ({ id, path, op, args }), this.timeoutMs)
    if (response.ok) {
      return response.value
    }
    throw new Error(response.error)
  }

  /** The Learn store in `path`, every call answered by the worker. */
  store(path: string): CodemodeLearnRemote {
    const remote = Object.fromEntries(
      CODEMODE_LEARN_OPS.map((op) => [op, (...args: unknown[]) => this.call(path, op, args)])
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each op forwards its own arguments to the store method of that name, whose return value the worker answers unchanged.
    return remote as unknown as CodemodeLearnRemote
  }

  /** Stops the worker and fails any waiting call; resolves once the thread has exited. The client
   * takes no calls after this. */
  async close(): Promise<void> {
    this.queue.dispose()
    await this.queue.retired()
  }
}
