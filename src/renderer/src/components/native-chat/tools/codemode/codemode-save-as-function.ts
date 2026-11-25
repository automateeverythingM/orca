import { appendQuoteToChatDraft } from '../../drafts/native-chat-selection-quote-draft'
import { structuredAgentSessionDraftScopeKey } from '../../drafts/native-chat-draft-scope'

/** The request that turns a finished script into a saved function; the person edits it, then sends. */
export function saveAsFunctionPrompt(code: string): string {
  return `Save the script below as a saved function with lib.save: pick a clear camelCase name and a one-line description, and turn its hard-coded values into parameters.\n\n\`\`\`js\n${code}\n\`\`\``
}

/** Puts the request in the chat's composer, after what the person has typed; nothing is sent. */
export function askToSaveAsFunction(sessionId: string, code: string): void {
  // Why: the quote append is plain "keep the draft, blank line, add text" with the loaded-draft fallback.
  appendQuoteToChatDraft(structuredAgentSessionDraftScopeKey(sessionId), saveAsFunctionPrompt(code))
}
