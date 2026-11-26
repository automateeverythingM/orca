import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const CODEMODE_CONNECTORS_TARGET_ID = 'code-mode-connectors'
export const CODEMODE_TRUSTED_SERVERS_TARGET_ID = 'code-mode-trusted-servers'
export const CODEMODE_FUNCTIONS_TARGET_ID = 'code-mode-functions'
export const CODEMODE_LEARN_TARGET_ID = 'code-mode-learn'

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

export const getCodemodeFunctionsSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  targetSectionId: CODEMODE_FUNCTIONS_TARGET_ID,
  title: translate('settings.codemode.functions.title', 'Functions'),
  description: translate(
    'settings.codemode.functions.description',
    'Saved functions agents call as lib.<name>: view, allow, move between project and global, or delete them.'
  ),
  keywords: [
    ...translateSearchKeyword('settings.codemode.search.lib', 'lib', { englishOnly: true }),
    ...translateSearchKeyword('settings.codemode.search.savedFunction', 'saved function'),
    ...translateSearchKeyword('settings.codemode.search.history', 'history')
  ]
}))

export const getCodemodeLearnSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  targetSectionId: CODEMODE_LEARN_TARGET_ID,
  title: translate('settings.codemode.learn.title', 'Learn'),
  description: translate(
    'settings.codemode.learn.description',
    'Scripts and tool chains agents ran in 2 or more chats, to save as functions.'
  ),
  keywords: [
    ...translateSearchKeyword('settings.codemode.search.repeated', 'repeated'),
    ...translateSearchKeyword('settings.codemode.search.learn', 'learn from runs'),
    ...translateSearchKeyword('settings.codemode.search.proposals', 'find functions to save'),
    ...translateSearchKeyword('settings.codemode.search.clear', 'clear history')
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
  return [
    getCodemodeConnectorsSearchEntry(),
    getCodemodeFunctionsSearchEntry(),
    getCodemodeLearnSearchEntry(),
    getCodemodeTrustedServersSearchEntry()
  ]
}
