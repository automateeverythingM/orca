import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { useAppStore } from '../../../store/index'
import { matchesSettingsSearch } from '../search/settings-search'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { getCodemodeEnabledSearchEntry } from './codemode-enabled-search'

type CodemodeEnabledSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible?: boolean
}

export function CodemodeEnabledSetting({
  settings,
  updateSettings,
  forceVisible = false
}: CodemodeEnabledSettingProps): React.JSX.Element | null {
  const t = useTranslate()
  const enabled = settings.codemodeEnabled === true
  const entry = getCodemodeEnabledSearchEntry()
  const query = useAppStore((state) => state.settingsSearchQuery)
  // Skip the whole group, not just its row, so a filtered-out row leaves no empty slot.
  if (!forceVisible && !matchesSettingsSearch(query, [entry])) {
    return null
  }
  return (
    <SettingsGroup>
      <SearchableSetting
        {...entry}
        id="chat-codemode-enabled"
        forceVisible={forceVisible}
        className="max-w-none"
      >
        <SettingsSwitchRow
          label={entry.title}
          description={entry.description}
          checked={enabled}
          ariaLabel={t('components.settings.nativeChat.codemodeToggleLabel', 'Toggle code mode')}
          onChange={() => updateSettings({ codemodeEnabled: !enabled })}
        />
      </SearchableSetting>
    </SettingsGroup>
  )
}
