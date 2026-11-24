import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const CODEMODE_CONNECTORS_TARGET_ID = 'code-mode-connectors'
export const CODEMODE_TRUSTED_SERVERS_TARGET_ID = 'code-mode-trusted-servers'

export const getCodemodeConnectorsSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  targetSectionId: CODEMODE_CONNECTORS_TARGET_ID,
  title: translate('settings.codemode.connectors.title', 'MCP connectors'),
  description: translate(
    'settings.codemode.connectors.description',
    'Remote MCP servers agents can call from code mode, added by URL or from the MCP Registry.'
  ),
  keywords: [
    ...translateSearchKeyword('settings.codemode.search.mcp', 'MCP', { englishOnly: true }),
    ...translateSearchKeyword('settings.codemode.search.registry', 'registry'),
    ...translateSearchKeyword('settings.codemode.search.remote', 'remote server'),
    ...translateSearchKeyword('settings.codemode.search.signIn', 'sign in'),
    ...translateSearchKeyword('settings.codemode.search.token', 'token')
  ]
}))

export const getCodemodeTrustedServersSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    targetSectionId: CODEMODE_TRUSTED_SERVERS_TARGET_ID,
    title: translate('settings.codemode.trusted.title', 'Trusted local servers'),
    description: translate(
      'settings.codemode.trusted.description',
      'Code mode runs these local MCP servers’ tools without asking first.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.codemode.search.mcp', 'MCP', { englishOnly: true }),
      ...translateSearchKeyword('settings.codemode.search.approval', 'approval'),
      ...translateSearchKeyword('settings.codemode.search.mcpJson', '.mcp.json', {
        englishOnly: true
      })
    ]
  })
)

export function getCodemodeSettingsSearchEntries(): SettingsSearchEntry[] {
  return [getCodemodeConnectorsSearchEntry(), getCodemodeTrustedServersSearchEntry()]
}
