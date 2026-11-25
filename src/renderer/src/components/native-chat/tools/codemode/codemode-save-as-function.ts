import { appendQuoteToChatDraft } from '../../drafts/native-chat-selection-quote-draft'
import { structuredAgentSessionDraftScopeKey } from '../../drafts/native-chat-draft-scope'
import { fencedCode } from '../../../../../../shared/codemode/codemode-fenced-code'

/** The request that turns a finished script into a saved function; the person edits it, then sends. */
export function saveAsFunctionPrompt(code: string): string {
  return `Save the script below as a saved function with lib.save: pick a clear camelCase name and a one-line description, and turn its hard-coded values into parameters. \`source\` must declare \`async function <name>({...})\` taking one object argument.\n\n${fencedCode(code, 'js')}`
}

/** Puts the request in the chat's composer, after what the person has typed; nothing is sent. */
export function askToSaveAsFunction(sessionId: string, code: string): void {
  // Why: the quote append is plain "keep the draft, blank line, add text" with the loaded-draft fallback.
  appendQuoteToChatDraft(structuredAgentSessionDraftScopeKey(sessionId), saveAsFunctionPrompt(code))
}
