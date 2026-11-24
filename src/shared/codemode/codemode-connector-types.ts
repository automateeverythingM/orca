export type CodemodeConnectorAuth = 'oauth' | 'token' | 'none'

export type CodemodeConnector = {
  id: string
  name: string
  url: string
  auth: CodemodeConnectorAuth
  trusted: boolean
  enabled: boolean
}

export const CODEMODE_CONNECTOR_NAME = /^[a-z][a-z0-9_-]{0,39}$/

export const CODEMODE_RESERVED_NAMES = ['orca', 'list', 'describe', 'call']
