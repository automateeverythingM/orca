import type {
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../../../../../shared/native-chat/native-chat-types'
import type {
  CodemodeInnerCallRecord,
  CodemodeRunRecord
} from '../../../../../../shared/codemode/codemode-run-wire'
import {
  codemodeCallCode,
  isCodemodeRunCall
} from '../../../../../../shared/codemode/codemode-run-match'

export function isCodemodeRunBlock(block: NativeChatToolCallBlock): boolean {
  return isCodemodeRunCall(block.name, block.mcpIdentity)
}

export type CodemodeRunCall = {
  /** The provider's call id, else the row's own identity. */
  callId: string
  code: string | null
  running: boolean
}

export function codemodeRunCall(
  block: NativeChatToolCallBlock,
  result: NativeChatToolResultBlock | undefined,
  lineIdentity: string
): CodemodeRunCall {
  return {
    callId: block.callId ?? lineIdentity,
    code: codemodeCallCode(block.input),
    running: block.state === 'running' || (block.state === undefined && result === undefined)
  }
}

/** The script's first line with words in it, for the row's one-line summary. */
export function codemodeCodePreview(code: string | null): string {
  const line = code?.split('\n').find((text) => text.trim().length > 0)
  return line?.trim() ?? ''
}

export type CodemodeInnerCallRow = CodemodeInnerCallRecord & { key: string }

export function codemodeInnerCallRows(run: CodemodeRunRecord | null): CodemodeInnerCallRow[] {
  return (run?.calls ?? []).map((call) => ({ ...call, key: `${run?.runId}:${call.seq}` }))
}
