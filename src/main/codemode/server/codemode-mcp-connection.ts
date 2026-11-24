import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  RequestId,
  ServerNotification,
  ServerRequest
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { ApprovalDecision, Approver, CodemodeSession } from '../host/codemode-run-host'
import { buildToolDescription } from './codemode-tool-description'

/** What the server needs from a session; the real `CodemodeSession` satisfies it. */
export type CodemodeSessionHandle = Pick<CodemodeSession, 'run' | 'serverNames' | 'close'>

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

/** One agent connection: keys its allow_session answers and counts its scripts in flight. */
export type CodemodeConnectionState = { running: number }

// Why: a person may take minutes to answer; past this the call fails closed as deny.
const APPROVAL_WAIT_MS = 30 * 60_000
const DECISIONS: readonly ApprovalDecision[] = ['allow_once', 'allow_session', 'deny']

const DECISION_SCHEMA = {
  type: 'object' as const,
  properties: {
    decision: {
      type: 'string' as const,
      title: 'Decision',
      enum: ['allow_once', 'allow_session', 'deny'],
      enumNames: ['Allow once', 'Allow for this session', 'Deny']
    }
  },
  required: ['decision']
}

/** One agent connection's MCP server: the single `run_js` tool, bound to this connection. */
export function createCodemodeMcpServer(
  session: CodemodeSessionHandle,
  describeInput: () => { servers: string[] },
  progressMs: number,
  connection: CodemodeConnectionState = { running: 0 }
): McpServer {
  const mcp = new McpServer({ name: 'orca-codemode', version: '1.0.0' })
  mcp.registerTool(
    'run_js',
    {
      description: buildToolDescription(describeInput()),
      inputSchema: { code: z.string() },
      _meta: { 'anthropic/alwaysLoad': true }
    },
    async ({ code }, extra) => {
      const stopProgress = reportProgress(extra, progressMs)
      connection.running += 1
      try {
        const result = await session.run(code, {
          signal: extra.signal,
          approver: elicitingApprover(mcp, extra.requestId),
          connection
        })
        return { content: [{ type: 'text', text: result.text }], isError: result.isError }
      } finally {
        connection.running -= 1
        stopProgress()
      }
    }
  )
  return mcp
}

function reportProgress(extra: ToolExtra, progressMs: number): () => void {
  const progressToken = extra._meta?.progressToken
  if (progressToken === undefined) {
    return () => {}
  }
  let progress = 0
  const timer = setInterval(() => {
    progress += 1
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress, message: 'Script running' }
      })
      .catch(() => {})
  }, progressMs)
  return () => clearInterval(timer)
}

/** Asks the person through the agent's MCP client; the client's UI is the person. */
function elicitingApprover(mcp: McpServer, relatedRequestId: RequestId): Approver {
  return async ({ title, detail, personOnly, signal }) => {
    if (!mcp.server.getClientCapabilities()?.elicitation?.form) {
      return 'unsupported'
    }
    if (signal.aborted) {
      return 'deny'
    }
    try {
      const result = await mcp.server.elicitInput(
        {
          mode: 'form',
          message: detail ? `${title}\n\n${detail}` : title,
          requestedSchema: DECISION_SCHEMA,
          _meta: {
            'anthropic/permissionDisplay': { title, displayName: 'Code mode', description: detail },
            // A UI hint only: whoever holds the token answers its own connection's prompts.
            'orca/personOnly': personOnly
          }
        },
        { signal, relatedRequestId, timeout: APPROVAL_WAIT_MS }
      )
      const decision = result.action === 'accept' ? result.content?.decision : undefined
      return DECISIONS.find((known) => known === decision) ?? 'deny'
    } catch {
      return 'deny'
    }
  }
}
