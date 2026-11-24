import { useState } from 'react'
import type React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import {
  CODEMODE_TRUSTED_SERVERS_TARGET_ID,
  getCodemodeTrustedServersSearchEntry
} from './codemode-settings-search'

const MAX_SERVER_NAME_LENGTH = 128

export function CodemodeTrustedServersSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getCodemodeTrustedServersSearchEntry()
  const servers = settings.codemodeTrustedServers ?? []
  const [draft, setDraft] = useState('')
  const name = draft.trim()
  const duplicate = servers.includes(name)

  const add = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!name || duplicate) {
      return
    }
    void updateSettings({ codemodeTrustedServers: [...servers, name] })
    setDraft('')
  }

  const remove = (server: string): void =>
    void updateSettings({ codemodeTrustedServers: servers.filter((item) => item !== server) })

  return (
    <SettingsGroup
      id={CODEMODE_TRUSTED_SERVERS_TARGET_ID}
      title={entry.title}
      description={entry.description}
    >
      {servers.length === 0 ? (
        <p data-settings-row="" className="py-3 text-xs text-muted-foreground">
          {t(
            'settings.codemode.trusted.empty',
            'None yet. Unless a chat has full access, code mode asks before each call to a local server.'
          )}
        </p>
      ) : (
        servers.map((server) => (
          <div
            key={server}
            data-settings-row=""
            className="flex items-center justify-between gap-3 py-2"
          >
            <span className="min-w-0 truncate font-mono text-xs">{server}</span>
            <Button
              variant="ghost-destructive"
              size="xs"
              aria-label={t('settings.codemode.trusted.removeNamed', 'Stop trusting {{name}}', {
                name: server
              })}
              onClick={() => remove(server)}
            >
              {t('settings.codemode.trusted.remove', 'Remove')}
            </Button>
          </div>
        ))
      )}
      <form data-settings-row="" className="flex flex-wrap items-center gap-2 py-3" onSubmit={add}>
        <Input
          variant="code"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 basis-48"
          maxLength={MAX_SERVER_NAME_LENGTH}
          value={draft}
          aria-invalid={duplicate && name !== ''}
          aria-label={t('settings.codemode.trusted.inputLabel', 'Local server name')}
          placeholder={t('settings.codemode.trusted.placeholder', 'Server name from .mcp.json')}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={!name || duplicate}>
          {t('settings.codemode.trusted.add', 'Trust')}
        </Button>
      </form>
    </SettingsGroup>
  )
}
