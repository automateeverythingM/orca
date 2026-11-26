// Learn's proposals: functions the writer drafted from repeated work. Runs in the Learn DB worker,
// on the store's connection; the store hands its transaction helper in.
import { randomUUID } from 'node:crypto'
import type SyncDatabase from '../../../sqlite/sync-database'
import type {
  CodemodeLearnProposal,
  CodemodeLearnProposalState
} from '../../../../shared/codemode/codemode-learn-types'
import { capText } from '../codemode-learn-caps'
import { clampLimit } from './codemode-learn-rows'

export const LEARN_MAX_PROPOSALS = 50
export const LEARN_PROPOSAL_SOURCE_CAP_BYTES = 256 * 1024
export const LEARN_PROPOSAL_LOG_CAP_BYTES = 16 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
/** A writer's "not worth it" holds its source this long; an error holds nothing. */
export const LEARN_NOT_WORTH_HOLD_MS = 7 * DAY_MS
/** Retention never deletes a ready proposal younger than this: the person may not have seen it. */
export const LEARN_READY_KEEP_MS = DAY_MS
const OPEN_STATES: CodemodeLearnProposalState[] = ['writing', 'testing', 'ready', 'saved']
const STATES: ReadonlySet<string> = new Set([
  ...OPEN_STATES,
  'failed',
  'dismissed'
] satisfies CodemodeLearnProposalState[])
/** Body fields a patch may set; `id`, `createdAt` and `sourceKey` never change, `state` is a column.
 *  Plain identifiers, so each one is safe in a `json_set` path. */
const PATCHABLE: ReadonlySet<string> = new Set([
  'sourceKind',
  'sourceSessions',
  'projectRoot',
  'error',
  'failure',
  'name',
  'description',
  'params',
  'source',
  'sampleArgs',
  'expect',
  'callsSaved',
  'scope',
  'why',
  'testStatus',
  'testReason',
  'testLog',
  'callsBefore',
  'savedAs',
  'savedAt'
] satisfies (keyof Body)[])

export const LEARN_PROPOSAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS learn_proposals (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  source_key TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS learn_proposals_created ON learn_proposals (created_at);
`

export type NewProposal = Omit<CodemodeLearnProposal, 'id' | 'createdAt' | 'state'>
export type ProposalPatch = Partial<Omit<CodemodeLearnProposal, 'id' | 'createdAt'>>

type Row = Record<string, unknown>
type Body = Omit<CodemodeLearnProposal, 'id' | 'createdAt' | 'state'>

/** The proposal with its source and test log held to their caps. */
function capped<T extends Partial<CodemodeLearnProposal>>(proposal: T): T {
  const next = { ...proposal }
  if (typeof next.source === 'string') {
    next.source = capText(next.source, LEARN_PROPOSAL_SOURCE_CAP_BYTES).text
  }
  if (typeof next.testLog === 'string') {
    next.testLog = capText(next.testLog, LEARN_PROPOSAL_LOG_CAP_BYTES).text
  }
  return next
}

function proposalOf(row: Row): CodemodeLearnProposal {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: body is JSON this table wrote from a Body.
  const body = JSON.parse(String(row.body)) as Body
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: state is only ever written from a CodemodeLearnProposalState.
  const state = String(row.state) as CodemodeLearnProposalState
  return { ...body, id: String(row.id), createdAt: Number(row.created_at), state }
}

export class CodemodeLearnProposalTable {
  constructor(private readonly db: SyncDatabase) {}

  /** Adds a `writing` proposal, replacing the failed ones of its source, and applies the
   *  50-proposal retention. The store runs it in one transaction. */
  create(input: NewProposal, now: number): CodemodeLearnProposal {
    const id = randomUUID()
    const body = capped(input)
    // Why: a new draft supersedes the old failure; keeping both would show two cards for one repeat.
    this.db
      .prepare("DELETE FROM learn_proposals WHERE source_key = ? AND state = 'failed'")
      .run(String(input.sourceKey))
    this.db
      .prepare(
        'INSERT INTO learn_proposals (id, created_at, state, source_key, body) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, now, 'writing', String(input.sourceKey), JSON.stringify(body))
    this.applyRetention(now)
    return { ...body, id, createdAt: now, state: 'writing' }
  }

  /** Applies the patch only while the proposal's state is one of `onlyFrom`: one conditional
   *  UPDATE, so the state check and the write cannot be split by another write. */
  update(id: string, patch: ProposalPatch, onlyFrom: CodemodeLearnProposalState[]): boolean {
    const states = (Array.isArray(onlyFrom) ? onlyFrom : []).map(String)
    if (states.length === 0) {
      return false
    }
    const fields = Object.entries(capped(patch)).filter(
      ([key, value]) => PATCHABLE.has(key) && value !== undefined
    )
    // Why: `json_set` per top-level field replaces it whole (a merge patch would merge objects).
    const sets = fields.map(([key]) => `, '$.${key}', json(?)`).join('')
    const state = patch.state === undefined ? null : String(patch.state)
    if (state !== null && !STATES.has(state)) {
      return false
    }
    const result = this.db
      .prepare(
        `UPDATE learn_proposals SET state = COALESCE(?, state), body = json_set(body${sets})
          WHERE id = ? AND state IN (${states.map(() => '?').join(', ')})`
      )
      .run(state, ...fields.map(([, value]) => JSON.stringify(value)), String(id), ...states)
    return Number(result.changes) > 0
  }

  get(id: string): CodemodeLearnProposal | null {
    const row = this.db.prepare('SELECT * FROM learn_proposals WHERE id = ?').get(String(id))
    return row ? proposalOf(row) : null
  }

  list(limit: number): CodemodeLearnProposal[] {
    return this.db
      .prepare('SELECT * FROM learn_proposals ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(clampLimit(limit))
      .map(proposalOf)
  }

  /** Source keys with a proposal being written, tested, ready or saved, or one the writer found
   *  not worth a function in the 7 days before `now`. */
  openKeys(now: number): string[] {
    const marks = OPEN_STATES.map(() => '?').join(', ')
    return this.db
      .prepare(
        `SELECT DISTINCT source_key FROM learn_proposals
          WHERE state IN (${marks})
             OR (state = 'failed' AND json_extract(body, '$.failure') = 'not-worth'
                 AND created_at > ?)
          ORDER BY source_key`
      )
      .all(...OPEN_STATES, now - LEARN_NOT_WORTH_HOLD_MS)
      .map((row) => String(row.source_key))
  }

  clear(): void {
    this.db.prepare('DELETE FROM learn_proposals').run()
  }

  /** Past 50: the oldest dismissed or failed go first, then the oldest ready made over 24 h before
   *  `now`; saved ones never. */
  applyRetention(now: number): void {
    const total = Number(this.db.prepare('SELECT COUNT(1) AS n FROM learn_proposals').get()?.n ?? 0)
    let excess = total - LEARN_MAX_PROPOSALS
    const tiers: [string[], number][] = [
      [['dismissed', 'failed'], Infinity],
      [['ready'], now - LEARN_READY_KEEP_MS]
    ]
    for (const [states, before] of tiers) {
      if (excess <= 0) {
        return
      }
      const marks = states.map(() => '?').join(', ')
      const doomed = this.db
        .prepare(
          `SELECT id FROM learn_proposals WHERE state IN (${marks}) AND created_at < ?
            ORDER BY created_at, rowid LIMIT ?`
        )
        .all(...states, before, excess)
      for (const row of doomed) {
        this.db.prepare('DELETE FROM learn_proposals WHERE id = ?').run(String(row.id))
      }
      excess -= doomed.length
    }
  }
}
