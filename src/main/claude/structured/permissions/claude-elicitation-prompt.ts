import type { ElicitationRequest, ElicitationResult } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { AgentJournalQuestionItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionPromptResponse } from '../../../../shared/agent-session/requests/prompts/agent-session-question-answer'
import { wholeFormElicitationPresentation } from '../../../acp/requests/acp-form-elicitation'

export const CLAUDE_ELICITATION_DECLINE: ElicitationResult = { action: 'decline' }

/** An MCP server's form, shown on the question card ACP and Codex forms use. */
export type ClaudeElicitationForm = {
  body: AgentJournalQuestionItem
  reply: (response: AgentSessionPromptResponse | null) => unknown
}

/** Null for URL mode (out of scope) or a form the card can't show whole; both are declined. */
export function claudeElicitationPresentation(
  request: ElicitationRequest
): ClaudeElicitationForm | null {
  if (request.mode === 'url') {
    return null
  }
  const presentation = wholeFormElicitationPresentation({
    mode: 'form',
    message: request.message,
    requestedSchema: request.requestedSchema
  })
  return presentation?.body.kind === 'question'
    ? { body: presentation.body, reply: presentation.reply }
    : null
}

const acceptedFormSchema = z.object({
  action: z.literal('accept'),
  content: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
})

/** The form's own answer mapping; anything but an accepted form declines. */
export function claudeElicitationResult(
  form: ClaudeElicitationForm,
  response: AgentSessionPromptResponse | null
): ElicitationResult {
  const accepted = acceptedFormSchema.safeParse(form.reply(response))
  return accepted.success ? accepted.data : CLAUDE_ELICITATION_DECLINE
}
