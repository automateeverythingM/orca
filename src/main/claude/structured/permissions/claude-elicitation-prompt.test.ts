import type { ElicitationRequest } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import type { ClaudeStructuredSessionEvent } from '../lifecycle/claude-structured-session-event'
import { claudeQuestionItems } from '../journal/claude-structured-prompt-items'
import {
  buildClaudePromptReply,
  claudePromptDismissal
} from '../journal/claude-structured-prompt-replies'
import { claudeElicitationPresentation } from './claude-elicitation-prompt'
import { ClaudePromptRegistry } from './claude-prompt-registry'
import {
  buildClaudePermissionCallbacks,
  claudeLaunchPermissions
} from './claude-structured-inbound-control'

const CODE_MODE_REQUEST: ElicitationRequest = {
  serverName: 'orca',
  message: 'Run git push?\n\nPushes main to origin',
  mode: 'form',
  requestedSchema: {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        title: 'Decision',
        enum: ['allow_once', 'allow_session', 'deny'],
        enumNames: ['Allow once', 'Allow for this session', 'Deny']
      }
    },
    required: ['decision']
  },
  title: 'Run git push?',
  displayName: 'Code mode',
  description: 'Pushes main to origin'
}

function harness(codemode = true) {
  const prompts = new ClaudePromptRegistry()
  const events: ClaudeStructuredSessionEvent[] = []
  // Full access must not answer an MCP server's question for the person.
  const { onElicitation } = buildClaudePermissionCallbacks({
    sessionId: 'session-1',
    prompts,
    emit: (event) => events.push(event),
    fullAccessAt: () => true,
    codemode
  })
  const opened = () => {
    const event = events.at(-1)
    if (event?.type !== 'prompt') {
      throw new Error('expected an open prompt')
    }
    return event.prompt
  }
  return { prompts, events, onElicitation, opened }
}

describe('Claude MCP form elicitations', () => {
  it('shows the code-mode decision as one required question with its options in order', () => {
    const questions = claudeElicitationPresentation(CODE_MODE_REQUEST)?.body.questions ?? []

    expect(questions).toHaveLength(1)
    expect(questions[0]!.skippable).toBeUndefined()
    expect(questions[0]!.options.map((option) => option.label)).toEqual([
      'Allow once',
      'Allow for this session',
      'Deny'
    ])
  })

  it('accepts the second option as allow_session and declines a dismissed card', async () => {
    const { onElicitation, opened } = harness()
    const signal = new AbortController().signal
    const answered = onElicitation(CODE_MODE_REQUEST, { signal, requestId: 'request-1' })
    const prompt = opened()
    const [item] = claudeQuestionItems({ sessionId: 'session-1', prompt })
    const question = item!.body.questions![0]!
    prompt.settle(
      buildClaudePromptReply(prompt, {
        kind: 'answers',
        answers: [{ questionId: question.id, optionIds: [question.options[1]!.id] }]
      })
    )
    await expect(answered).resolves.toEqual({
      action: 'accept',
      content: { decision: 'allow_session' }
    })

    const dismissed = onElicitation(CODE_MODE_REQUEST, { signal, requestId: 'request-2' })
    const second = opened()
    second.settle(claudePromptDismissal(second))
    await expect(dismissed).resolves.toEqual({ action: 'decline' })
  })

  it('declines a pending elicitation when the session ends or the request is aborted', async () => {
    const { prompts, events, onElicitation } = harness()
    const ended = onElicitation(CODE_MODE_REQUEST, {
      signal: new AbortController().signal,
      requestId: 'request-1'
    })
    for (const prompt of prompts.clear()) {
      prompt.settle(null)
    }
    await expect(ended).resolves.toEqual({ action: 'decline' })

    const abort = new AbortController()
    const aborted = onElicitation(CODE_MODE_REQUEST, {
      signal: abort.signal,
      requestId: 'request-2'
    })
    abort.abort()
    await expect(aborted).resolves.toEqual({ action: 'decline' })
    expect(events.map((event) => event.type)).toEqual(['prompt', 'prompt', 'prompt-cancelled'])
  })

  it('declines without a card when this process was launched without code mode', async () => {
    const { events, onElicitation } = harness(false)
    const reply = onElicitation(CODE_MODE_REQUEST, {
      signal: new AbortController().signal,
      requestId: 'request-1'
    })
    await expect(reply).resolves.toEqual({ action: 'decline' })
    expect(events).toEqual([])
  })

  it("declines another MCP server's form without a card even with code mode on", async () => {
    const { events, onElicitation } = harness(true)
    const reply = onElicitation(
      { ...CODE_MODE_REQUEST, serverName: 'crm' },
      { signal: new AbortController().signal, requestId: 'request-1' }
    )
    await expect(reply).resolves.toEqual({ action: 'decline' })
    expect(events).toEqual([])
  })

  it("asks the person only for a launch whose MCP config carries code mode's server", async () => {
    const opened = async (codemode: boolean | undefined) => {
      const events: ClaudeStructuredSessionEvent[] = []
      const { handlers } = claudeLaunchPermissions(
        {
          sessionId: 'session-1',
          prompts: new ClaudePromptRegistry(),
          emit: (e) => events.push(e)
        },
        { options: {}, providerSessionId: 'provider-1', ...(codemode ? { codemode } : {}) }
      )
      void handlers.onElicitation?.(CODE_MODE_REQUEST, {
        signal: new AbortController().signal,
        requestId: 'request-1'
      })
      await Promise.resolve()
      return events.map((event) => event.type)
    }
    expect(await opened(true)).toEqual(['prompt'])
    expect(await opened(undefined)).toEqual([])
  })

  it('declines URL elicitations without opening a card', async () => {
    const { events, onElicitation } = harness()
    const reply = onElicitation(
      { serverName: 'auth', message: 'Sign in', mode: 'url', url: 'https://example.com' },
      { signal: new AbortController().signal, requestId: 'request-1' }
    )
    await expect(reply).resolves.toEqual({ action: 'decline' })
    expect(events).toEqual([])
  })
})
