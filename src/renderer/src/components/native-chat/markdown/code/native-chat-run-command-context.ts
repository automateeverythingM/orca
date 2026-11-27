import { createContext, useContext } from 'react'
import type { NativeChatCodeBlockRunStore } from './native-chat-code-run-store'

export type NativeChatCodeRunner = {
  /** Execute a shell block inline with live output & pass/fail status. */
  store: NativeChatCodeBlockRunStore
  /** Open the command in a full interactive terminal tab on the chat's host. */
  openInTerminal?: (command: string) => Promise<boolean>
  /** Send a run's command and output back to the chat agent. */
  sendToChat?: (text: string) => boolean
}

/** Runs shell code blocks on the chat's host; undefined outside a workspace chat. */
export const NativeChatRunCommandContext = createContext<NativeChatCodeRunner | undefined>(
  undefined
)

export function useNativeChatRunCommand(): NativeChatCodeRunner | undefined {
  return useContext(NativeChatRunCommandContext)
}
