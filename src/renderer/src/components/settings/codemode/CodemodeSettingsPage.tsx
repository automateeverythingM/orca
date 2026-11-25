import type React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { CodemodeEnabledSetting } from '../chat/CodemodeEnabledSetting'
import type { SettingsSearchEntry } from '../search/settings-search'
import { SettingsSection } from '../section-layout/SettingsSection'
import { CodemodeConnectorList } from './CodemodeConnectorList'
import { CodemodeFunctionList } from './CodemodeFunctionList'
import { CodemodeLearnSection } from './CodemodeLearnSection'
import { CodemodeTrustedServersSetting } from './CodemodeTrustedServersSetting'

export function CodemodeSettingsPage({
  settings,
  updateSettings,
  searchEntries
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  searchEntries: SettingsSearchEntry[]
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsSection
      id="code-mode"
      title={t('settings.codemode.title', 'Code mode')}
      description={t(
        'settings.codemode.description',
        'Let agents run JavaScript that calls your MCP servers and connectors in one step.'
      )}
      searchEntries={searchEntries}
    >
      <CodemodeEnabledSetting
        settings={settings}
        updateSettings={(updates) => void updateSettings(updates)}
        forceVisible
      />
      <CodemodeConnectorList />
      <CodemodeFunctionList />
      <CodemodeLearnSection settings={settings} updateSettings={updateSettings} />
      <CodemodeTrustedServersSetting settings={settings} updateSettings={updateSettings} />
    </SettingsSection>
  )
}
