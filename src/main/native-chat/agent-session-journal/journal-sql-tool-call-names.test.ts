import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTrackedJournalOpener } from './store-lifecycle/journal-host-database-test-support'
import { openTestAgentSessionDatabase } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { writeToolCallChat } from './journal-tool-call-chat.test-fixture'
import type { JournalToolCallName, JournalToolCallNamesResult } from './journal-sql-tool-call-names'

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY
const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-tool-call-names-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function page(
  afterOrdinal: number,
  limit: number,
  since = NOW - 30 * DAY
): Promise<JournalToolCallNamesResult> {
  const { readers } = await openTestAgentSessionDatabase(root)
  const result = await readers.point({
    sessionId: 'chat-a',
    operation: { kind: 'tool-call-names', afterOrdinal, limit, since }
  })
  if (result.kind !== 'tool-call-names') {
    throw new Error(`answered ${result.kind}`)
  }
  return result
}

describe('tool-call-names', () => {
  it('pages names, turns and agents; leaves out calls older than since', async () => {
    await writeToolCallChat(
      journals,
      root,
      'chat-a',
      [
        { name: 'mcp__crm__old', turn: 't1', observedAt: NOW - 31 * DAY },
        { name: 'mcp__crm__find', turn: 't1' },
        { name: 'crm/update', turn: 't1', mcp: ['crm', 'update'] },
        { name: 'Bash', turn: null },
        { name: 'mcp__crm__sub', turn: 't1', agentId: 'sub-1' }
      ],
      NOW - DAY
    )
    const calls: JournalToolCallName[] = []
    let after = -1
    let pages = 0
    for (;;) {
      const result = await page(after, 2)
      pages += 1
      calls.push(...result.calls)
      if (result.nextOrdinal === null) {
        break
      }
      after = result.nextOrdinal
    }
    expect(pages).toBe(2)
    expect(calls.map(({ ordinal: _ordinal, ...call }) => call)).toEqual([
      {
        observedAt: NOW - DAY,
        turnItemId: 't1',
        agentId: null,
        name: 'mcp__crm__find',
        mcpServer: null,
        mcpTool: null
      },
      {
        observedAt: NOW - DAY,
        turnItemId: 't1',
        agentId: null,
        name: 'crm/update',
        mcpServer: 'crm',
        mcpTool: 'update'
      },
      {
        observedAt: NOW - DAY,
        turnItemId: null,
        agentId: null,
        name: 'Bash',
        mcpServer: null,
        mcpTool: null
      },
      {
        observedAt: NOW - DAY,
        turnItemId: 't1',
        agentId: 'sub-1',
        name: 'mcp__crm__sub',
        mcpServer: null,
        mcpTool: null
      }
    ])
  })

  it('never replies with a call output', async () => {
    await writeToolCallChat(
      journals,
      root,
      'chat-a',
      [{ name: 'mcp__crm__dump', turn: 't1', output: 'x'.repeat(5 * 2 ** 20) }],
      NOW - DAY
    )
    const result = await page(-1, 10)
    expect(result.calls.map((call) => call.name)).toEqual(['mcp__crm__dump'])
    expect(JSON.stringify(result).length).toBeLessThan(1024)
  })
})
