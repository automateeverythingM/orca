import { Braces } from 'lucide-react'
import { getCodemodeSettingsSearchEntries } from '@/components/settings/codemode/codemode-settings-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsNavSection } from '@/components/settings/navigation/settings-navigation-types'
import type { SettingsNavigationBuildOptions } from './settings-navigation-build-options'

// Code mode runs only in the desktop app, so the web client lists no page for it.
export function buildCodemodeSettingsSections(
  { isWebClient }: SettingsNavigationBuildOptions,
  t: Translate = translate
): SettingsNavSection[] {
  if (isWebClient) {
    return []
  }
  return [
    {
      id: 'code-mode',
      title: t('settings.codemode.title', 'Code mode'),
      description: t(
        'settings.codemode.description',
        'Let agents run JavaScript that calls your MCP servers and connectors in one step.'
      ),
      icon: Braces,
      searchEntries: getCodemodeSettingsSearchEntries(),
      group: 'capabilities'
    }
  ]
}
