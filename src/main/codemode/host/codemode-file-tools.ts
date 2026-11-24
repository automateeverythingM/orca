import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import { spawnBundledRipgrep } from '../../ripgrep/bundled-ripgrep-spawn'
import type { HostReply } from '../sandbox/codemode-script-runner'
import { resolveInRoot } from './codemode-paths'

export type FileToolContext = { root: string }

const MAX_RG_OUTPUT_BYTES = 8 * 1024 * 1024

function outside(input: string): HostReply {
  return { ok: false, error: `path is outside the workspace: ${input}` }
}

function failure(error: unknown): HostReply {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

async function resolveOrRefuse(
  root: string,
  input: string
): Promise<{ path: string } | { refusal: HostReply }> {
  try {
    const resolved = await resolveInRoot(root, input)
    return resolved.inside ? { path: resolved.path } : { refusal: outside(input) }
  } catch (error) {
    return { refusal: failure(error) }
  }
}

/** `offset` is the 1-based first line to return; `limit` is a line count. */
export async function readFileTool(
  input: { path: string; offset?: number; limit?: number },
  ctx: FileToolContext
): Promise<HostReply> {
  const target = await resolveOrRefuse(ctx.root, input.path)
  if ('refusal' in target) {
    return target.refusal
  }
  try {
    const text = await readFile(target.path, 'utf8')
    if (input.offset === undefined && input.limit === undefined) {
      return { ok: true, value: text }
    }
    const start = Math.max(0, (input.offset ?? 1) - 1)
    const end = input.limit === undefined ? undefined : start + Math.max(0, input.limit)
    return { ok: true, value: text.split('\n').slice(start, end).join('\n') }
  } catch (error) {
    return failure(error)
  }
}

export async function writeFileTool(
  input: { path: string; content: string },
  ctx: FileToolContext
): Promise<HostReply> {
  const target = await resolveOrRefuse(ctx.root, input.path)
  if ('refusal' in target) {
    return target.refusal
  }
  try {
    await mkdir(dirname(target.path), { recursive: true })
    await writeFile(target.path, input.content)
    return { ok: true, value: `wrote ${input.path}` }
  } catch (error) {
    return failure(error)
  }
}

export async function editFileTool(
  input: { path: string; old_string: string; new_string: string },
  ctx: FileToolContext
): Promise<HostReply> {
  const target = await resolveOrRefuse(ctx.root, input.path)
  if ('refusal' in target) {
    return target.refusal
  }
  try {
    const text = await readFile(target.path, 'utf8')
    const parts = input.old_string === '' ? [text] : text.split(input.old_string)
    const matches = parts.length - 1
    if (matches === 0) {
      return { ok: false, error: 'old_string not found' }
    }
    if (matches > 1) {
      return { ok: false, error: `old_string matches ${matches} times; include more context` }
    }
    await writeFile(target.path, parts.join(input.new_string))
    return { ok: true, value: `edited ${input.path}` }
  } catch (error) {
    return failure(error)
  }
}

function runRipgrep(
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (code: number, extra = ''): void => {
      if (!settled) {
        settled = true
        resolve({ code, stdout, stderr: stderr + extra })
      }
    }
    const child = spawnBundledRipgrep(['--no-config', ...args], { cwd })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_RG_OUTPUT_BYTES) {
        stdout += chunk.toString('utf8')
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => done(2, error.message))
    child.on('close', (code) => done(code ?? 2))
  })
}

function cleanLines(stdout: string): string {
  return stdout
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => line.replace(/^\.[\\/]/, ''))
    .map((line) =>
      process.platform === 'win32' ? line.replace(/^[^:]*/, (p) => p.replaceAll('\\', '/')) : line
    )
    .join('\n')
}

async function searchBase(
  root: string,
  input: string | undefined
): Promise<{ realRoot: string; arg: string } | { refusal: HostReply }> {
  const target = await resolveOrRefuse(root, input ?? '.')
  if ('refusal' in target) {
    return { refusal: input === undefined ? target.refusal : outside(input) }
  }
  const realRoot = (await resolveInRoot(root, '.')).path
  return { realRoot, arg: relative(realRoot, target.path) || '.' }
}

export async function grepTool(
  input: { pattern: string; path?: string; glob?: string },
  ctx: FileToolContext
): Promise<HostReply> {
  const base = await searchBase(ctx.root, input.path)
  if ('refusal' in base) {
    return base.refusal
  }
  const args = ['--line-number', '--no-heading', '--with-filename', '--color', 'never']
  if (input.glob) {
    args.push('-g', input.glob)
  }
  args.push('-e', input.pattern, '--', base.arg)
  const result = await runRipgrep(args, base.realRoot)
  if (result.code === 1) {
    return { ok: true, value: '' }
  }
  if (result.code !== 0) {
    return { ok: false, error: result.stderr.trim() || `rg exited with ${result.code}` }
  }
  return { ok: true, value: cleanLines(result.stdout) }
}

export async function findTool(
  input: { pattern: string; path?: string },
  ctx: FileToolContext
): Promise<HostReply> {
  const base = await searchBase(ctx.root, input.path)
  if ('refusal' in base) {
    return base.refusal
  }
  const args = [
    '--files',
    '--sort',
    'path',
    '--color',
    'never',
    '-g',
    input.pattern,
    '--',
    base.arg
  ]
  const result = await runRipgrep(args, base.realRoot)
  if (result.code === 1) {
    return { ok: true, value: '' }
  }
  if (result.code !== 0) {
    return { ok: false, error: result.stderr.trim() || `rg exited with ${result.code}` }
  }
  return { ok: true, value: cleanLines(result.stdout) }
}
