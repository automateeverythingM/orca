import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runGenerationRequest: vi.fn(),
  prepareEnv: vi.fn(),
  cancel: vi.fn()
}))

vi.mock('../../../text-generation/agent-generation-request', () => ({
  runGenerationRequest: mocks.runGenerationRequest
}))
vi.mock('../../../text-generation/execution/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.prepareEnv
}))
vi.mock('../../../text-generation/execution/source-control-generation-lanes', () => ({
  cancelLocalGeneration: mocks.cancel
}))
vi.mock('../../../text-generation/execution/source-control-agent-launch', () => ({
  spawnSourceControlAgent: vi.fn(() => {
    throw new Error('a unit test must never spawn an agent')
  })
}))

import { createLearnWriterGenerate } from './codemode-learn-writer-generate'

type GenerationInput = {
  params: unknown
  operation: string
  timeoutMs?: number
  prompt: string
  target: { kind: string; cwd: string; laneId?: string; env?: NodeJS.ProcessEnv }
  shouldExecute?: () => boolean
}

const lastInput = (): GenerationInput => mocks.runGenerationRequest.mock.calls.at(-1)?.[0]

let parentDir = ''
afterEach(async () => {
  await rm(dirname(parentDir), { recursive: true, force: true })
})

beforeEach(async () => {
  parentDir = join(await mkdtemp(join(tmpdir(), 'orca-learn-gen-test-')), 'orca-codemode-learn')
  vi.clearAllMocks()
  mocks.prepareEnv.mockResolvedValue({ ok: true, env: { HOME: '/home/test' } })
})

describe('createLearnWriterGenerate', () => {
  it('runs Claude opus as codemode-learn in an empty temp folder it removes after', async () => {
    let cwdDuringRun = ''
    let entriesDuringRun: string[] = []
    mocks.runGenerationRequest.mockImplementation(async (input: GenerationInput) => {
      cwdDuringRun = input.target.cwd
      entriesDuringRun = readdirSync(input.target.cwd)
      return { success: true, rawOutput: '{"worth":false}' }
    })
    const resolvers = {}
    const generate = createLearnWriterGenerate({ getAgentEnvResolvers: () => resolvers, parentDir })
    expect(await generate('PROMPT', { timeoutMs: 180_000 })).toEqual({
      ok: true,
      text: '{"worth":false}'
    })
    expect(mocks.prepareEnv).toHaveBeenCalledWith('claude', resolvers)
    const input = lastInput()
    expect(input.params).toEqual({ agentId: 'claude', model: 'opus' })
    expect(input.operation).toBe('codemode-learn')
    expect(input.timeoutMs).toBe(180_000)
    expect(input.prompt).toBe('PROMPT')
    expect(input.target).toMatchObject({ kind: 'local', env: { HOME: '/home/test' } })
    expect(input.target.laneId).toEqual(expect.any(String))
    expect(entriesDuringRun).toEqual([])
    expect(existsSync(cwdDuringRun)).toBe(false)
    // One fixed parent, a fresh child per request; the parent stays.
    expect(dirname(cwdDuringRun)).toBe(parentDir)
    expect(existsSync(parentDir)).toBe(true)
    const first = cwdDuringRun
    await generate('AGAIN', { timeoutMs: 1000 })
    expect(lastInput().target.cwd).not.toBe(first)
    expect(dirname(lastInput().target.cwd)).toBe(parentDir)
  })

  it('reports env and generation failures as errors', async () => {
    const generate = createLearnWriterGenerate({ getAgentEnvResolvers: () => undefined, parentDir })
    mocks.prepareEnv.mockResolvedValueOnce({ ok: false, error: 'Claude is not signed in.' })
    expect(await generate('P', { timeoutMs: 1000 })).toEqual({
      ok: false,
      error: 'Claude is not signed in.'
    })
    expect(mocks.runGenerationRequest).not.toHaveBeenCalled()
    mocks.runGenerationRequest.mockResolvedValueOnce({
      success: false,
      error: 'Generation timed out after 180s.',
      errorCode: 'timedOut'
    })
    expect(await generate('P', { timeoutMs: 1000 })).toEqual({
      ok: false,
      error: 'Generation timed out after 180s.',
      timedOut: true
    })
    mocks.runGenerationRequest.mockResolvedValueOnce({ success: false, error: 'Claude exited 1.' })
    expect(await generate('P', { timeoutMs: 1000 })).toEqual({
      ok: false,
      error: 'Claude exited 1.'
    })
  })

  it('cancels its own lane on abort', async () => {
    const stop = new AbortController()
    mocks.runGenerationRequest.mockImplementation(async (input: GenerationInput) => {
      expect(input.shouldExecute?.()).toBe(true)
      stop.abort()
      expect(input.shouldExecute?.()).toBe(false)
      return { success: false, error: 'Generation canceled.', canceled: true }
    })
    const generate = createLearnWriterGenerate({ getAgentEnvResolvers: () => undefined, parentDir })
    expect(await generate('P', { timeoutMs: 1000, signal: stop.signal })).toEqual({
      ok: false,
      error: 'Generation canceled.'
    })
    const input = lastInput()
    expect(mocks.cancel).toHaveBeenCalledWith(
      'codemode-learn',
      input.target.cwd,
      input.target.laneId
    )
  })
})
