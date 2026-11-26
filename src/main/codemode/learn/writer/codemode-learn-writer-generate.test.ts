import { existsSync, readdirSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

beforeEach(() => {
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
    const generate = createLearnWriterGenerate({ getAgentEnvResolvers: () => resolvers })
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
  })

  it('reports env and generation failures as errors', async () => {
    const generate = createLearnWriterGenerate({ getAgentEnvResolvers: () => undefined })
    mocks.prepareEnv.mockResolvedValueOnce({ ok: false, error: 'Claude is not signed in.' })
    expect(await generate('P', { timeoutMs: 1000 })).toEqual({
      ok: false,
      error: 'Claude is not signed in.'
    })
    expect(mocks.runGenerationRequest).not.toHaveBeenCalled()
    mocks.runGenerationRequest.mockResolvedValueOnce({
      success: false,
      error: 'Generation timed out after 180s.'
    })
    expect(await generate('P', { timeoutMs: 1000 })).toEqual({
      ok: false,
      error: 'Generation timed out after 180s.'
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
    const generate = createLearnWriterGenerate({ getAgentEnvResolvers: () => undefined })
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
