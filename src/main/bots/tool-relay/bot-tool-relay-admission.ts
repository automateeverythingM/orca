// How many calls the relay lets in at once, counted from arrival (before any wait for a token), and
// the open calls a removed tool or deleted bot cuts. Streams, calls and session cleanup each have
// their own slots, so idle event streams can never starve tool calls or DELETE. Limits are per
// caller: `bot:<botId>` or `codemode:<sessionId>`.

type Pool = 'stream' | 'call' | 'cleanup' | 'process-stream'

/** 16 MiB bodies × 64 calls is already ~1 GiB a caller; raise these only with that in mind. */
const LIMITS: Record<Pool, { perCaller: number; perHost: number }> = {
  /** GET event streams stay open for a session's life. */
  stream: { perCaller: 16, perHost: 256 },
  call: { perCaller: 64, perHost: 512 },
  cleanup: { perCaller: 8, perHost: 64 },
  /** A shared server's event stream: one per agent session using it, for that session's life. */
  'process-stream': { perCaller: 256, perHost: 1024 }
}

const poolOf = (method: string, process: boolean): Pool =>
  method === 'GET'
    ? process
      ? 'process-stream'
      : 'stream'
    : method === 'DELETE'
      ? 'cleanup'
      : 'call'

/** One admitted call: aborting it cuts its wait, its upstream request and its stream. */
export type RelayCall = {
  callerKey: string
  credentialKey: string
  pool: Pool
  abort: AbortController
}

export class RelayAdmission {
  private readonly perCaller = new Map<string, number>()
  private readonly perHost = new Map<Pool, number>()
  private readonly open = new Set<RelayCall>()

  /**
   * The call's slot, or null when the caller or this computer has too many of its kind open. A token
   * many sessions share (`perCallerLimit` false) is bound by this computer's limit alone.
   */
  admit(
    callerKey: string,
    method: string,
    credentialKey: string,
    perCallerLimit = true,
    /** A shared server's: its event streams have their own pool. */
    process = false
  ): RelayCall | null {
    const pool = poolOf(method, process)
    const slotKey = `${pool}\0${callerKey}`
    const forCaller = this.perCaller.get(slotKey) ?? 0
    const forHost = this.perHost.get(pool) ?? 0
    if (
      (perCallerLimit && forCaller >= LIMITS[pool].perCaller) ||
      forHost >= LIMITS[pool].perHost
    ) {
      return null
    }
    this.perCaller.set(slotKey, forCaller + 1)
    this.perHost.set(pool, forHost + 1)
    const call = { callerKey, credentialKey, pool, abort: new AbortController() }
    this.open.add(call)
    return call
  }

  release(call: RelayCall): void {
    if (!this.open.delete(call)) {
      return
    }
    const slotKey = `${call.pool}\0${call.callerKey}`
    const left = (this.perCaller.get(slotKey) ?? 1) - 1
    if (left > 0) {
      this.perCaller.set(slotKey, left)
    } else {
      this.perCaller.delete(slotKey)
    }
    this.perHost.set(call.pool, (this.perHost.get(call.pool) ?? 1) - 1)
  }

  /** Aborts every open call `matches` picks, with `reason`; their slots free as they unwind. */
  abortWhere(matches: (call: RelayCall) => boolean, reason: unknown): void {
    for (const call of this.open) {
      if (matches(call)) {
        call.abort.abort(reason)
      }
    }
  }
}
