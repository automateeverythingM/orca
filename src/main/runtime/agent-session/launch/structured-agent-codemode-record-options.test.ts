import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  CONNECTORS_OFF_OPTION,
  connectorsOffValue,
  readConnectorsOff
} from '../../../codemode/connectors/codemode-connector-session-switch'
import type { AgentSessionRecordStore } from '../records/agent-session-record-store'
import {
  closeTestAgentSessionRecordStores,
  openTestAgentSessionRecordStore
} from '../records/agent-session-record-store-test-harness'
import { codemodeRecordOptions } from './structured-agent-codemode-launch'

const NOW = 1_800_000_000_000
const SESSION = 'chat-a-0001'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codemode-record-options-'))
})

afterEach(async () => {
  await closeTestAgentSessionRecordStores()
  await rm(root, { recursive: true, force: true })
})

async function liveChat(store: AgentSessionRecordStore): Promise<number> {
  const reserved = await store.reserveOwner({
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    expectedFence: null,
    spawnToken: 'spawn-1',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-${'1'.repeat(32)}`,
      fingerprint: 'fp'
    },
    now: NOW
  })
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence,
    process: { hostId: 'local', pid: 4001, processStartTimeMs: NOW, spawnToken: 'spawn-1' },
    now: NOW
  })
  await store.proveOwner({
    sessionId: SESSION,
    fence,
    link: {
      linkId: 'link-1',
      handle: claudeProviderHandle('provider-1', null),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    },
    now: NOW
  })
  return fence
}

describe('codemodeRecordOptions', () => {
  it('keeps a model pick that lands while a connector switch is being written', async () => {
    const store = await openTestAgentSessionRecordStore(root)
    const fence = await liveChat(store)
    const pick = (key: string, value: string) =>
      store.updateRecord(SESSION, {
        kind: 'pick-option',
        args: { sessionId: SESSION, fence, key, value, models: undefined, now: NOW }
      })
    await pick('model', 'm1')

    await Promise.all([
      pick('model', 'm2'),
      codemodeRecordOptions(store).writeOption(SESSION, CONNECTORS_OFF_OPTION, 'a1')
    ])
    expect(store.getRecord(SESSION)?.options).toEqual({
      model: 'm2',
      [CONNECTORS_OFF_OPTION]: 'a1'
    })
    await Promise.all([
      codemodeRecordOptions(store).writeOption(
        SESSION,
        CONNECTORS_OFF_OPTION,
        connectorsOffValue({}, [])
      ),
      pick('effort', 'high')
    ])

    const saved = store.getRecord(SESSION)?.options
    expect(saved).toMatchObject({ model: 'm2', effort: 'high' })
    expect(readConnectorsOff({ options: saved })).toEqual(new Set())
    const reopened = await openTestAgentSessionRecordStore(root, { mode: 'observe' })
    expect(reopened.getRecord(SESSION)?.options).toEqual(saved)
  })
})
