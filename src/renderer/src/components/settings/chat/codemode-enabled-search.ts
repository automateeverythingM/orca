import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from '../search/settings-search'

export const getCodemodeEnabledSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  targetSectionId: 'chat-codemode-enabled',
  title: translate('components.settings.nativeChat.codemodeTitle', 'Code mode'),
  description: translate(
    'components.settings.nativeChat.codemodeCopy',
    'Agents can run JavaScript that calls your MCP servers, files, and shell in one step. New chats only.'
  )
}))
