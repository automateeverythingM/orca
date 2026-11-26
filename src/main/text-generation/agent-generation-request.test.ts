import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runGenerationRequest } from './agent-generation-request'
import type {
  SourceControlAgentSpawnInput,
  SpawnSourceControlAgent,
  SpawnedSourceControlAgentProcess
} from './source-control-text-generation-types'

/** A child that answers `stdout` on close, or never closes when `stdout` is null. */
function fakeSpawn(stdout: string | null): {
  spawnAgent: SpawnSourceControlAgent
  spawned: SourceControlAgentSpawnInput[]
  stdin: string[]
} {
  const spawned: SourceControlAgentSpawnInput[] = []
  const stdin: string[] = []
  const spawnAgent: SpawnSourceControlAgent = (input) => {
    spawned.push(input)
    const child = new EventEmitter()
    const out = new EventEmitter()
    const err = new EventEmitter()
    const input$ = Object.assign(new EventEmitter(), {
      writableEnded: false,
      end(payload?: string) {
        stdin.push(payload ?? '')
        if (stdout !== null) {
          setTimeout(() => {
            out.emit('data', Buffer.from(stdout))
            child.emit('exit', 0)
            child.emit('close', 0)
          }, 0)
        }
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double with only the members the local runner reads (stdin.end/on, stdout/stderr data, close/exit, pid, kill); full Writable/Readable streams are not needed
    const agent = Object.assign(child, {
      pid: undefined,
      kill: () => true,
      stdin: input$,
      stdout: out,
      stderr: err,
      exitCode: null,
      signalCode: null,
      leaderExited: Promise.resolve(),
      ready: Promise.resolve(),
      outcomeLost: false
    }) as unknown as SpawnedSourceControlAgentProcess
    return agent
  }
  return { spawnAgent, spawned, stdin }
}

let cwd = ''
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'orca-gen-request-test-'))
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(cwd, { recursive: true, force: true })
})

describe('runGenerationRequest codemode-learn', () => {
  it('runs tool-free under strict MCP and keeps the reply intact', async () => {
    const reply = '```json\n{"worth": true, "body": "return 1"}\n```'
    const fake = fakeSpawn(reply)
    const result = await runGenerationRequest({
      params: { agentId: 'claude', model: 'opus' },
      prompt: 'BIG PROMPT',
      target: { kind: 'local', cwd, laneId: 'lane-1' },
      operation: 'codemode-learn',
      spawnAgent: fake.spawnAgent
    })
    expect(result).toMatchObject({ success: true, rawOutput: reply })
    const [spawn] = fake.spawned
    expect(spawn.binary).toBe('claude')
    const tools = spawn.args.indexOf('--tools')
    expect(tools).toBeGreaterThan(-1)
    expect(spawn.args[tools + 1]).toBe('')
    expect(spawn.args).not.toContain('--allowedTools')
    expect(spawn.args).toContain('--strict-mcp-config')
    expect(
      spawn.args.slice(spawn.args.indexOf('--model'), spawn.args.indexOf('--model') + 2)
    ).toEqual(['--model', 'opus'])
    // The prompt goes on stdin, so a 48 KiB prompt never meets an argv limit.
    expect(spawn.args).not.toContain('BIG PROMPT')
    expect(fake.stdin).toEqual(['BIG PROMPT'])
  })

  it('forwards timeoutMs past the 60 s default', async () => {
    vi.useFakeTimers()
    const fake = fakeSpawn(null)
    const pending = runGenerationRequest({
      params: { agentId: 'claude', model: 'opus' },
      prompt: 'P',
      target: { kind: 'local', cwd },
      operation: 'codemode-learn',
      spawnAgent: fake.spawnAgent,
      timeoutMs: 180_000
    })
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await pending).toMatchObject({
      success: false,
      error: 'Generation timed out after 180s.'
    })
  })

  it('keeps other operations on their tool list', async () => {
    const fake = fakeSpawn('feat: x')
    await runGenerationRequest({
      params: { agentId: 'claude', model: 'opus' },
      prompt: 'P',
      target: { kind: 'local', cwd },
      operation: 'commit-message',
      spawnAgent: fake.spawnAgent
    })
    const args = fake.spawned[0].args
    expect(args[args.indexOf('--tools') + 1]).not.toBe('')
  })
})
