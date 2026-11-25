// Learn: repeated scripts and tool chains, read and changed on this computer's runtime (code mode
// is desktop-only).
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  CodemodeLearnListView,
  CodemodeLearnStatusView,
  CodemodeRepeatedChain,
  CodemodeRepeatedScript
} from '../../../../../shared/codemode/codemode-learn-types'
import { saveAsFunctionPrompt } from '../../native-chat/tools/codemode/codemode-save-as-function'

const LOCAL: RuntimeClientTarget = { kind: 'local' }

export type CodemodeRepeat = CodemodeRepeatedScript | CodemodeRepeatedChain

export function codemodeLearnStatus(): Promise<CodemodeLearnStatusView> {
  return callRuntimeRpc<CodemodeLearnStatusView>(LOCAL, 'codemode.learn.status')
}

export function listCodemodeRepeats(): Promise<CodemodeLearnListView> {
  return callRuntimeRpc<CodemodeLearnListView>(LOCAL, 'codemode.learn.list')
}

/** Hides a repeat from the list and from nudges: a script by its shape, a chain by its signature. */
export async function dismissCodemodeRepeat(repeat: CodemodeRepeat): Promise<void> {
  const key = repeat.kind === 'script' ? repeat.shape : repeat.signature
  await callRuntimeRpc(LOCAL, 'codemode.learn.dismiss', { key })
}

export async function clearCodemodeLearn(): Promise<void> {
  await callRuntimeRpc(LOCAL, 'codemode.learn.clear')
}

const isControl = (code: number): boolean =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029

/** A tool name as one line of inline code: control characters and line breaks dropped, and a fence
 *  longer than any backtick run in it, so a name cannot end the list item or the code span. */
function inlineToolName(name: string): string {
  const text = [...name].filter((char) => !isControl(char.codePointAt(0) ?? 0)).join('')
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/** The request to paste into a chat: a script's own save request, or one listing a chain's calls. */
export function learnSaveRequest(repeat: CodemodeRepeat): string {
  if (repeat.kind === 'script') {
    return saveAsFunctionPrompt(repeat.sampleCode)
  }
  const steps = repeat.tools
    .map((tool, index) => `${index + 1}. ${inlineToolName(tool)}`)
    .join('\n')
  return `Write a saved function with lib.save that makes these MCP tool calls in this order, passing on what a later call needs from an earlier result. Pick a clear camelCase name and a one-line description, and take the values that change as parameters. \`source\` must declare \`async function <name>({...})\` taking one object argument.\n\n${steps}`
}
