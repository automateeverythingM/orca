import { describe, expect, it, vi } from 'vitest'
import { disposeCodexServerRequest } from './codex-server-request-disposition'
import { CODEX_MCP_ELICITATION_METHOD, CodexPromptRegistry } from './codex-prompt-registry'

// Shaped as Codex 0.171's generated McpServerElicitationRequestParams: `turnId` is the active turn
// app-server observed, nullable only when it could not correlate one.
function codemodeApproval(turnId: string | null) {
  return {
    id: 7,
    method: CODEX_MCP_ELICITATION_METHOD,
    params: {
      threadId: 'thread-1',
      turnId,
      serverName: 'orca',
      environmentId: null,
      mode: 'form',
      _meta: { 'orca/personOnly': false },
      message: 'Run bash?\n\ngit push',
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
      }
    }
  }
}

function dispose(request: ReturnType<typeof codemodeApproval>) {
  const connection = { respond: vi.fn(), respondWithError: vi.fn() }
  const disposition = disposeCodexServerRequest(new CodexPromptRegistry(), connection, request)
  return { disposition, connection }
}

describe("code mode's approval form in a Codex chat", () => {
  it('becomes a question card when Codex names the turn the run_js call is in', () => {
    const { disposition, connection } = dispose(codemodeApproval('turn-1'))
    expect(disposition.kind).toBe('prompt')
    expect(connection.respond).not.toHaveBeenCalled()
  })

  it('is declined safely when Codex could not correlate a turn', () => {
    const { disposition, connection } = dispose(codemodeApproval(null))
    expect(disposition).toEqual({ kind: 'responded', method: CODEX_MCP_ELICITATION_METHOD })
    expect(connection.respond).toHaveBeenCalledWith(7, {
      action: 'decline',
      content: null,
      _meta: null
    })
  })
})
