// Learn's side of a run_js run: buffers its inner calls, hands the whole run to the Learn store, and
// turns a repeat seen in other chats into a note for the agent. Never fails or holds up a run.
import { join } from 'node:path'
import type {
  CodemodeLearnCall,
  CodemodeLearnRun
} from '../../../shared/codemode/codemode-learn-types'
import type { CodemodeRunHeader } from '../../../shared/codemode/codemode-run-wire'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import type { CodemodeRunFinish } from '../host/codemode-run-host'
import { capLearnCall, LearnCallBudget } from './codemode-learn-caps'
import { CodemodeLearnWorkerClient } from './db-worker/codemode-learn-worker-client'
import type { CodemodeLearnRemote } from './store/codemode-learn-ops'

const LEARN_STORE_FILE = 'codemode-learn.sqlite'
/** The longest a run's result waits on the Learn worker. */
const FINISH_WAIT_MS = 2_000

export type CodemodeLearnRecorderDeps = {
  /** The Learn switch, read at each run's start. */
  enabled: () => boolean
  /** Reached only once a run is recorded, so a switched-off Learn never starts its worker. */
  store: () => CodemodeLearnRemote
  log: (message: string, error?: unknown) => void
}

export type CodemodeLearnFinish = { note: string | null; seenInChats: number | null }

/** A run in flight: its calls are cut as they settle, so only what the store would keep is held. */
type Pending = { run: Omit<CodemodeLearnRun, 'startedAt' | 'ms' | 'ok'>; budget: LearnCallBudget }

const NO_NUDGE: CodemodeLearnFinish = { note: null, seenInChats: null }

/** The text appended to a run_js result when the same script ran in other chats. */
export function learnNote(otherSessions: number): string {
  return `\nNote: you have run this same script in ${otherSessions} other chat(s). If the person may want it again, offer to save it as a function with lib.save.`
}

/** Only a working script that does real work, not one that already calls a saved function. */
function mayNudge(run: CodemodeLearnRun): boolean {
  return run.ok && run.calls.length >= 2 && !run.calls.some((call) => call.tool.startsWith('lib.'))
}

export class CodemodeLearnRecorder {
  private readonly pending = new Map<string, Pending>()
  private failureLogged = false
  private timeoutLogged = false

  constructor(private readonly deps: CodemodeLearnRecorderDeps) {}

  begin(sessionId: string, projectRoot: string, runId: string, code: string): void {
    if (this.deps.enabled()) {
      this.pending.set(runId, {
        run: { runId, sessionId, projectRoot, code, calls: [] },
        budget: new LearnCallBudget()
      })
    }
  }

  call(runId: string, call: CodemodeLearnCall): void {
    const pending = this.pending.get(runId)
    pending?.run.calls.push(capLearnCall(call, pending.budget))
  }

  async finish(
    runId: string,
    end: { ok: boolean; ms: number; startedAt: number }
  ): Promise<CodemodeLearnFinish> {
    const pending = this.pending.get(runId)
    if (!pending) {
      return NO_NUDGE
    }
    this.pending.delete(runId)
    const run: CodemodeLearnRun = { ...pending.run, ...end }
    let recorded: ReturnType<CodemodeLearnRemote['record']>
    try {
      recorded = this.deps.store().record(run, Date.now())
    } catch (error) {
      this.failed(error)
      return NO_NUDGE
    }
    const settled = recorded.catch((error: unknown) => {
      this.failed(error)
      return null
    })
    if (!mayNudge(run)) {
      return NO_NUDGE
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        // Why: logged apart from failures, so a slow worker never hides a later real failure.
        if (!this.timeoutLogged) {
          this.timeoutLogged = true
          this.log(`the Learn store did not answer within ${FINISH_WAIT_MS}ms; no nudge`, null)
        }
        resolve(null)
      }, FINISH_WAIT_MS)
    })
    const result = await Promise.race([settled, timedOut])
    clearTimeout(timer)
    if (!result || result.dismissed || result.otherSessions < 1) {
      return NO_NUDGE
    }
    return { note: learnNote(result.otherSessions), seenInChats: result.otherSessions + 1 }
  }

  private failed(error: unknown): void {
    if (!this.failureLogged) {
      this.failureLogged = true
      this.log('Learn could not record a run; runs go on without it', error)
    }
  }

  private log(message: string, error: unknown): void {
    try {
      this.deps.log(message, error)
    } catch {
      // Logging must not fail a run either.
    }
  }
}

/** One launched chat's hooks into the recorder; `annotate` marks the run the agent was nudged on. */
export type CodemodeRunLearnHooks = {
  begin: (runId: string, code: string) => void
  onCall: (runId: string, call: CodemodeLearnCall) => void
  onFinish: (run: CodemodeRunFinish) => Promise<string | null>
}

export function learnSessionHooks(
  recorder: CodemodeLearnRecorder,
  chat: {
    sessionId: string
    projectRoot: string
    annotate: (runId: string, patch: Pick<CodemodeRunHeader, 'seenInChats'>) => void
  }
): CodemodeRunLearnHooks {
  return {
    begin: (runId, code) => recorder.begin(chat.sessionId, chat.projectRoot, runId, code),
    onCall: (runId, call) => recorder.call(runId, call),
    onFinish: async ({ runId, ok, ms, startedAt }) => {
      const { note, seenInChats } = await recorder.finish(runId, { ok, ms, startedAt })
      if (seenInChats !== null) {
        chat.annotate(runId, { seenInChats })
      }
      return note
    }
  }
}

/** The profile's Learn store behind one worker client, created on first use; tests pass their own. */
export function workerLearnStore(testStore?: CodemodeLearnRemote): {
  store: () => CodemodeLearnRemote
  close: () => Promise<void>
} {
  let client: CodemodeLearnWorkerClient | null = null
  let remote: CodemodeLearnRemote | null = testStore ?? null
  return {
    store: () => {
      if (!remote) {
        client = new CodemodeLearnWorkerClient()
        remote = client.store(join(getProfileUserDataPath(), LEARN_STORE_FILE))
      }
      return remote
    },
    close: async () => {
      const closing = client
      client = null
      remote = testStore ?? null
      await closing?.close()
    }
  }
}
