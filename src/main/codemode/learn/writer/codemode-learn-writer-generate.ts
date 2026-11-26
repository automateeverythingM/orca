// The real Learn writer: Claude (opus) on the person's own login, through Orca's background text
// generation, tool-free, under strict MCP and with no saved session (the prompt holds recorded tool
// data), in a fresh empty folder under one fixed parent, removed afterwards.
// Unit tests use a fake `generate`; this file never runs in them.
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedSourceControlAiGenerationParams } from '../../../../shared/source-control/ai/source-control-ai-operation-resolution'
import { runGenerationRequest } from '../../../text-generation/agent-generation-request'
import { spawnSourceControlAgent } from '../../../text-generation/execution/source-control-agent-launch'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from '../../../text-generation/execution/commit-message-agent-environment'
import { cancelLocalGeneration } from '../../../text-generation/execution/source-control-generation-lanes'
import type { LearnWriterGenerate } from './codemode-learn-writer'

const WRITER_PARAMS: ResolvedSourceControlAiGenerationParams = { agentId: 'claude', model: 'opus' }

/** The one parent every writer folder lives under. */
export const learnWriterParentDir = (): string => join(tmpdir(), 'orca-codemode-learn')

export function createLearnWriterGenerate(deps: {
  getAgentEnvResolvers: () => CommitMessageAgentEnvironmentResolvers | undefined
  /** Tests only; the app uses `learnWriterParentDir()`. */
  parentDir?: string
}): LearnWriterGenerate {
  return async (prompt, opts) => {
    if (opts.signal?.aborted) {
      return { ok: false, error: 'Generation canceled.' }
    }
    // An empty folder of its own: the writer reads no project, and nothing it leaves stays behind.
    const parent = deps.parentDir ?? learnWriterParentDir()
    await mkdir(parent, { recursive: true })
    const cwd = await mkdtemp(join(parent, 'run-'))
    // Its own cancel lane, so aborting this request never stops another generation.
    const laneId = randomUUID()
    const cancel = (): void => cancelLocalGeneration('codemode-learn', cwd, laneId)
    opts.signal?.addEventListener('abort', cancel, { once: true })
    try {
      const prepared = await prepareLocalCommitMessageAgentEnv(
        'claude',
        deps.getAgentEnvResolvers()
      )
      if (!prepared.ok) {
        return { ok: false, error: prepared.error }
      }
      const result = await runGenerationRequest({
        params: WRITER_PARAMS,
        prompt,
        target: { kind: 'local', cwd, laneId, ...(prepared.env ? { env: prepared.env } : {}) },
        operation: 'codemode-learn',
        spawnAgent: spawnSourceControlAgent,
        timeoutMs: opts.timeoutMs,
        // Also makes the request wait for the agent to exit, so the folder is free to remove.
        shouldExecute: () => !opts.signal?.aborted
      })
      if (result.success) {
        return { ok: true, text: result.rawOutput }
      }
      return result.errorCode === 'timedOut'
        ? { ok: false, error: result.error, timedOut: true }
        : { ok: false, error: result.error }
    } finally {
      opts.signal?.removeEventListener('abort', cancel)
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
