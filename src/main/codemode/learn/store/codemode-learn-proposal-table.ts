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
const OPEN_STATES = ['writing', 'testing', 'ready', 'saved']

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

  /** Adds a `writing` proposal and applies the 50-proposal retention. */
  create(input: NewProposal, now: number): CodemodeLearnProposal {
    const id = randomUUID()
    const body = capped(input)
    this.db
      .prepare(
        'INSERT INTO learn_proposals (id, created_at, state, source_key, body) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, now, 'writing', String(input.sourceKey), JSON.stringify(body))
    this.applyRetention()
    return { ...body, id, createdAt: now, state: 'writing' }
  }

  /** Applies the patch only while the proposal's state is one of `onlyFrom`. */
  update(id: string, patch: ProposalPatch, onlyFrom: CodemodeLearnProposalState[]): boolean {
    const current = this.get(id)
    if (!current || !onlyFrom.includes(current.state)) {
      return false
    }
    const next = { ...current, ...capped(patch) }
    const body: Partial<CodemodeLearnProposal> = { ...next }
    delete body.id
    delete body.createdAt
    delete body.state
    this.db
      .prepare('UPDATE learn_proposals SET state = ?, body = ? WHERE id = ?')
      .run(next.state, JSON.stringify(body), id)
    return true
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

  /** Source keys with a proposal being written, tested, ready or saved. */
  openKeys(): string[] {
    const marks = OPEN_STATES.map(() => '?').join(', ')
    return this.db
      .prepare(
        `SELECT DISTINCT source_key FROM learn_proposals WHERE state IN (${marks}) ORDER BY source_key`
      )
      .all(...OPEN_STATES)
      .map((row) => String(row.source_key))
  }

  clear(): void {
    this.db.prepare('DELETE FROM learn_proposals').run()
  }

  /** Past 50: the oldest dismissed or failed go first, then the oldest ready; saved ones never. */
  applyRetention(): void {
    const total = Number(this.db.prepare('SELECT COUNT(1) AS n FROM learn_proposals').get()?.n ?? 0)
    let excess = total - LEARN_MAX_PROPOSALS
    for (const states of [['dismissed', 'failed'], ['ready']]) {
      if (excess <= 0) {
        return
      }
      const marks = states.map(() => '?').join(', ')
      const doomed = this.db
        .prepare(
          `SELECT id FROM learn_proposals WHERE state IN (${marks})
            ORDER BY created_at, rowid LIMIT ?`
        )
        .all(...states, excess)
      for (const row of doomed) {
        this.db.prepare('DELETE FROM learn_proposals WHERE id = ?').run(String(row.id))
      }
      excess -= doomed.length
    }
  }
}
