import { describe, expect, it } from 'vitest'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { claudeAndCodexAgents } from '../../../native-chat/agent-session-wire/providers/testing/structured-agent-session-adapter-router.test-fixture'
import { CodemodeAcquisitionRouter } from './structured-agent-codemode-router'

const PROCESS = { hostId: 'local', pid: 1, processStartTimeMs: null, spawnToken: 'token' }

function attempt(attemptId: string) {
  return {
    attemptId,
    identity: {
      sessionId: 's1',
      workspaceId: 'w1',
      hostId: 'local',
      agent: 'claude' as const,
      providerHandle: null
    },
    fence: 1,
    spawnToken: 'token'
  }
}

function router(acquire: StructuredAgentSessionAdapter['acquire']) {
  const calls: string[] = []
  const adapter: StructuredAgentSessionAdapter = {
    ...claudeAndCodexAgents().registration('claude')!.adapter,
    acquire
  }
  const routed = new CodemodeAcquisitionRouter(claudeAndCodexAgents(adapter), async () => {}, {
    bindChild: (sessionId, launchId, generation) => {
      calls.push(`bind ${sessionId} ${launchId} ${generation}`)
    },
    endSession: async (sessionId, launchId) => {
      calls.push(`end ${sessionId} ${launchId}`)
    }
  })
  return { routed, calls }
}

describe('CodemodeAcquisitionRouter', () => {
  it("binds an attempt's launch to the child it acquired", async () => {
    const { routed, calls } = router(async () => ({
      process: PROCESS,
      acquisitionGeneration: 'generation-1'
    }))
    await routed.acquire(attempt('attempt-1'))
    expect(calls).toEqual(['bind s1 attempt-1 generation-1'])
  })

  it("ends only the failed attempt's own launch", async () => {
    const { routed, calls } = router(async () => {
      throw new Error('spawn failed')
    })
    await expect(routed.acquire(attempt('attempt-2'))).rejects.toThrow('spawn failed')
    expect(calls).toEqual(['end s1 attempt-2'])
  })
})
