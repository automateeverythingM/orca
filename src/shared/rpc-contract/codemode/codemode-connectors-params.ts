import * as z from 'zod'
import { CODEMODE_CONNECTOR_NAME } from '../../codemode/codemode-connector-types'

const ConnectorId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Unknown connector')
const ConnectorName = z
  .string()
  .regex(CODEMODE_CONNECTOR_NAME, 'A connector name is lowercase letters, digits, - and _')
const SessionId = z.string().trim().min(1).max(256)

export const CodemodeConnectorAdd = z.strictObject({
  url: z.string().trim().min(1, 'Enter the MCP server URL').max(2048),
  name: ConnectorName.optional()
})

export const CodemodeConnectorUpdate = z.strictObject({
  id: ConnectorId,
  name: ConnectorName.optional(),
  trusted: z.boolean().optional(),
  enabled: z.boolean().optional()
})

export const CodemodeConnectorTarget = z.strictObject({ id: ConnectorId })

// The pasted value is never echoed: its only message names the rule, not the value.
export const CodemodeConnectorSetToken = z.strictObject({
  id: ConnectorId,
  token: z.string().min(1, 'Paste the token').max(8192, 'The token is too long')
})

export const CodemodeConnectorSignInCancel = z.strictObject({
  id: ConnectorId,
  attemptId: z.string().min(1).max(128).optional()
})

export const CodemodeConnectorRegistrySearch = z.strictObject({
  query: z.string().trim().max(200),
  cursor: z.string().min(1).max(1024).optional()
})

export const CodemodeSessionConnectors = z.strictObject({ sessionId: SessionId })

export const CodemodeSessionConnectorToggle = z.strictObject({
  sessionId: SessionId,
  id: ConnectorId,
  on: z.boolean()
})
