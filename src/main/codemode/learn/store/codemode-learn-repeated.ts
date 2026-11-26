// The repeated-scripts query: runs grouped by shape across chats. Runs in the Learn DB worker.
import type SyncDatabase from '../../../sqlite/sync-database'
import type { CodemodeRepeatedScript } from '../../../../shared/codemode/codemode-learn-types'
import { clampLimit } from './codemode-learn-rows'

/** The runs (of table or alias `runs`) that count toward a repeat: ok, at least 2 inner calls,
 *  inside the window, and no call to a saved function (`lib.*`), as for the nudge. */
export const counted = (runs: string) =>
  `${runs}.ok = 1 AND ${runs}.call_count >= 2 AND ${runs}.started_at >= ? AND NOT EXISTS
     (SELECT 1 FROM learn_calls lib WHERE lib.run_id = ${runs}.run_id AND substr(lib.tool, 1, 4) = 'lib.')`
export const COUNTED = counted('learn_runs')

/** Repeated shapes (2+ chats, not dismissed) among runs started at or after `since`. */
export function repeatedScriptsOf(
  db: SyncDatabase,
  since: number,
  limit: number
): CodemodeRepeatedScript[] {
  const groups = db
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
    const sample = db
      .prepare(
        `SELECT code FROM learn_runs WHERE shape = ? AND ${COUNTED}
            ORDER BY started_at DESC, rowid DESC LIMIT 1`
      )
      .get(shape, since)
    const tools = db
      .prepare(
        `SELECT DISTINCT c.tool AS tool FROM learn_calls c JOIN learn_runs r ON r.run_id = c.run_id
            WHERE r.shape = ? AND ${counted('r')} ORDER BY c.tool`
      )
      .all(shape, since)
    const roots = db
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

/** The shapes of the runs one chat recorded. */
export function sessionShapesOf(db: SyncDatabase, sessionId: string): string[] {
  return db
    .prepare('SELECT DISTINCT shape FROM learn_runs WHERE session_id = ? ORDER BY shape')
    .all(String(sessionId))
    .map((row) => String(row.shape))
}

/** The average inner calls of the stored runs that called `lib.<name>`; null when none did. */
export function libCallsAfterOf(db: SyncDatabase, name: string): number | null {
  const row = db
    .prepare(
      `SELECT AVG(r.call_count) AS n FROM learn_runs r WHERE EXISTS
         (SELECT 1 FROM learn_calls c WHERE c.run_id = r.run_id AND c.tool = ?)`
    )
    .get(`lib.${String(name)}`)
  return row?.n === null || row?.n === undefined ? null : Number(row.n)
}
