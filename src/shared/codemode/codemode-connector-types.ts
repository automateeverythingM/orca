export type CodemodeConnectorAuth = 'oauth' | 'token' | 'none'

export type CodemodeConnector = {
  id: string
  name: string
  url: string
  auth: CodemodeConnectorAuth
  trusted: boolean
  enabled: boolean
}

export type CodemodeConnectorStatus = 'connected' | 'sign-in-needed' | 'token-needed' | 'error'

/** A connector as the connector RPCs list it; never carries a token or header value. */
export type CodemodeConnectorView = CodemodeConnector & { status: CodemodeConnectorStatus }

/** One chat's view of a connector: `on` is false when switched off here or turned off globally. */
export type CodemodeSessionConnectorView = {
  id: string
  name: string
  on: boolean
  enabled: boolean
  status: CodemodeConnectorStatus
}

export const CODEMODE_CONNECTOR_NAME = /^[a-z][a-z0-9_-]{0,39}$/

export const CODEMODE_RESERVED_NAMES = ['orca', 'list', 'describe', 'call']
