// Learn's memory of code-mode runs: each run's code, shape and inner calls, kept 30 days. Runs only in
// the Learn DB worker; the main side reaches it through codemode-learn-ops.ts.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SyncDatabase from '../../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../../sqlite/harden-database-files'
import type {
  CodemodeLearnRun,
  CodemodeLearnStats,
  CodemodeRepeatedChain,
  CodemodeRepeatedScript
} from '../../../../shared/codemode/codemode-learn-types'
import { codemodeShapeHash } from '../codemode-shape'
import {
  DELETE_PAST_BYTE_BUDGET,
  DELETE_PAST_RUN_COUNT,
  LEARN_MAX_RUNS,
  LEARN_RETENTION_MS,
  LEARN_RUN_CALL_BUDGET_BYTES,
  LEARN_SCHEMA,
  LEARN_STORE_BUDGET_BYTES,
  callColumns,
  clampLimit,
  callOf,
  chainOf,
  runColumns,
  runOf
} from './codemode-learn-rows'

/** Byte budgets; tests pass small ones. */
export type CodemodeLearnBudgets = { runCallBytes: number; storeBytes: number }

export type CodemodeLearnRecorded = { shape: string; otherSessions: number; dismissed: boolean }

/** The runs that count toward a repeat: ok, at least 2 inner calls, inside the window. */
const COUNTED = 'ok = 1 AND call_count >= 2 AND started_at >= ?'

export class CodemodeLearnStore {
  private constructor(
    private readonly db: SyncDatabase,
    private readonly budgets: CodemodeLearnBudgets
  ) {}

  static open(path: string, budgets: Partial<CodemodeLearnBudgets> = {}): CodemodeLearnStore {
    mkdirSync(dirname(path), { recursive: true })
    const db = new SyncDatabase(path)
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    db.pragma('foreign_keys = ON')
    db.exec(LEARN_SCHEMA)
    hardenSqliteDatabaseFiles(path)
    return new CodemodeLearnStore(db, {
      runCallBytes: budgets.runCallBytes ?? LEARN_RUN_CALL_BUDGET_BYTES,
      storeBytes: budgets.storeBytes ?? LEARN_STORE_BUDGET_BYTES
    })
  }

  /** Releases the file, so its folder can be removed. */
  dispose(): void {
    this.db.close()
  }

  /** Stores the run (unless a clear came after it started) and says how often other chats ran its shape. */
  record(run: CodemodeLearnRun, now: number): CodemodeLearnRecorded {
    const shape = codemodeShapeHash(String(run.code))
    const clearedAt = this.meta('cleared_at')
    if (clearedAt === null || run.startedAt >= clearedAt) {
      this.transaction(() => {
        this.insert(run, shape)
        this.applyRetention(now)
      })
    }
    const other = this.db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) AS n FROM learn_runs
          WHERE shape = ? AND session_id <> ? AND ${COUNTED}`
      )
      .get(shape, String(run.sessionId), now - LEARN_RETENTION_MS)
    return { shape, otherSessions: Number(other?.n ?? 0), dismissed: this.isDismissed(shape) }
  }

  /** Shapes run ok with 2+ calls in 2+ chats within 30 days, not dismissed; most chats first. */
  repeatedScripts(now: number, limit: number): CodemodeRepeatedScript[] {
    const since = now - LEARN_RETENTION_MS
    const groups = this.db
      .prepare(
        `SELECT shape, COUNT(DISTINCT session_id) AS sessions, COUNT(1) AS runs, MAX(started_at) AS last_seen
           FROM learn_runs
          WHERE ${COUNTED} AND shape NOT IN (SELECT key FROM learn_dismissed)
          GROUP BY shape HAVING COUNT(DISTINCT session_id) >= 2
          ORDER BY sessions DESC, last_seen DESC, shape LIMIT ?`
      )
      .all(since, clampLimit(limit))
    return groups.map((group) => {
      const shape = String(group.shape)
      const sample = this.db
        .prepare(
          `SELECT code FROM learn_runs WHERE shape = ? AND ${COUNTED}
            ORDER BY started_at DESC, rowid DESC LIMIT 1`
        )
        .get(shape, since)
      const tools = this.db
        .prepare(
          `SELECT DISTINCT c.tool AS tool FROM learn_calls c JOIN learn_runs r ON r.run_id = c.run_id
            WHERE r.shape = ? AND r.ok = 1 AND r.call_count >= 2 AND r.started_at >= ? ORDER BY c.tool`
        )
        .all(shape, since)
      const roots = this.db
        .prepare(
          `SELECT DISTINCT project_root FROM learn_runs WHERE shape = ? AND ${COUNTED}
            ORDER BY project_root`
        )
        .all(shape, since)
      return {
        kind: 'script',
        shape,
        sessions: Number(group.sessions),
        runs: Number(group.runs),
        lastSeen: Number(group.last_seen),
        sampleCode: String(sample?.code ?? ''),
        tools: tools.map((row) => String(row.tool)),
        projectRoots: roots.map((row) => String(row.project_root))
      }
    })
  }

  /** Every stored run of this shape, newest first, with its calls. */
  runsForShape(shape: string, limit: number): CodemodeLearnRun[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, session_id, project_root, started_at, ms, ok, code, code_truncated
           FROM learn_runs WHERE shape = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`
      )
      .all(shape, clampLimit(limit))
    const calls = this.db.prepare(
      `SELECT seq, tool, ok, input, input_truncated, output, output_truncated, error, ms
         FROM learn_calls WHERE run_id = ? ORDER BY seq`
    )
    return rows.map((row) => runOf(row, calls.all(String(row.run_id)).map(callOf)))
  }

  /** Replaces the cached repeated chains, unless a clear came after their computation started. */
  saveChains(chains: CodemodeRepeatedChain[], computedAt: number): void {
    if (computedAt < (this.meta('cleared_at') ?? -Infinity)) {
      return
    }
    this.transaction(() => {
      this.db.prepare('DELETE FROM learn_chains').run()
      const insert = this.db.prepare(
        `INSERT INTO learn_chains (position, signature, tools, sessions, occurrences, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      chains.forEach((chain, position) => {
        insert.run(
          position,
          String(chain.signature),
          JSON.stringify(chain.tools.map(String)),
          chain.sessions,
          chain.occurrences,
          chain.lastSeen
        )
      })
      this.setMeta('chains_computed_at', computedAt)
    })
  }

  chains(): { computedAt: number | null; chains: CodemodeRepeatedChain[] } {
    const rows = this.db
      .prepare(
        `SELECT signature, tools, sessions, occurrences, last_seen FROM learn_chains ORDER BY position`
      )
      .all()
    return { computedAt: this.meta('chains_computed_at'), chains: rows.map(chainOf) }
  }

  /** A shape hash or chain signature the person said not to suggest again. */
  dismiss(key: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO learn_dismissed (key, dismissed_at) VALUES (?, ?)')
      .run(String(key), Date.now())
  }

  dismissed(): string[] {
    return this.db
      .prepare('SELECT key FROM learn_dismissed ORDER BY dismissed_at, key')
      .all()
      .map((row) => String(row.key))
  }

  /** Forgets everything, shrinks the file, and refuses runs that started before now. */
  clear(now: number = Date.now()): void {
    this.transaction(() => {
      for (const table of [
        'learn_calls',
        'learn_runs',
        'learn_chains',
        'learn_dismissed',
        'learn_meta'
      ]) {
        this.db.prepare(`DELETE FROM ${table}`).run()
      }
      this.setMeta('cleared_at', now)
    })
    this.db.exec('VACUUM')
    this.db.pragma('wal_checkpoint(TRUNCATE)')
  }

  stats(): CodemodeLearnStats {
    const runs = this.db
      .prepare('SELECT COUNT(1) AS n, MIN(started_at) AS oldest FROM learn_runs')
      .get()
    const calls = this.db.prepare('SELECT COUNT(1) AS n FROM learn_calls').get()
    const pages = Number(this.db.pragma('page_count', { simple: true }) ?? 0)
    const pageSize = Number(this.db.pragma('page_size', { simple: true }) ?? 0)
    const oldest = runs?.oldest
    return {
      runs: Number(runs?.n ?? 0),
      calls: Number(calls?.n ?? 0),
      bytes: pages * pageSize,
      oldest: oldest === null || oldest === undefined ? null : Number(oldest)
    }
  }

  private insert(run: CodemodeLearnRun, shape: string): void {
    const runId = String(run.runId)
    const calls = callColumns(
      runId,
      Array.isArray(run.calls) ? run.calls : [],
      this.budgets.runCallBytes
    )
    // Same run id again: the newer report replaces it (its calls go with it).
    this.db.prepare('DELETE FROM learn_runs WHERE run_id = ?').run(runId)
    this.db
      .prepare(
        `INSERT INTO learn_runs (run_id, session_id, project_root, started_at, ms, ok, code,
           code_truncated, shape, call_count, stored_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(...runColumns(run, shape, calls.rows.length, calls.bytes))
    const insertCall = this.db.prepare(
      `INSERT OR REPLACE INTO learn_calls (run_id, seq, tool, ok, input, input_truncated, output,
         output_truncated, error, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const row of calls.rows) {
      insertCall.run(...row)
    }
  }

  /** Past 30 days, past 5000 runs, or past the byte budget: the oldest runs go, calls with them. */
  private applyRetention(now: number): void {
    this.db.prepare('DELETE FROM learn_runs WHERE started_at < ?').run(now - LEARN_RETENTION_MS)
    const totals = this.db
      .prepare('SELECT COUNT(1) AS n, SUM(stored_bytes) AS bytes FROM learn_runs')
      .get()
    if (Number(totals?.n ?? 0) > LEARN_MAX_RUNS) {
      this.db.prepare(DELETE_PAST_RUN_COUNT).run(LEARN_MAX_RUNS)
    }
    if (Number(totals?.bytes ?? 0) > this.budgets.storeBytes) {
      this.db.prepare(DELETE_PAST_BYTE_BUDGET).run(this.budgets.storeBytes)
    }
  }

  private isDismissed(key: string): boolean {
    return (
      this.db.prepare('SELECT 1 AS hit FROM learn_dismissed WHERE key = ?').get(key) !== undefined
    )
  }

  private meta(key: string): number | null {
    const row = this.db.prepare('SELECT value FROM learn_meta WHERE key = ?').get(key)
    return row ? Number(row.value) : null
  }

  private setMeta(key: string, value: number): void {
    this.db
      .prepare(
        'INSERT INTO learn_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  private transaction(body: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      body()
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK')
      }
      throw error
    }
  }
}
