import { useEffect, useId, useState } from 'react'
import type React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/class-names'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type {
  CodemodeConnectorStatus,
  CodemodeConnectorView
} from '../../../../../shared/codemode/codemode-connector-types'
import { SettingsBadge } from '../form-controls/SettingsFormControls'
import {
  cancelCodemodeConnectorSignIn,
  codemodeConnectorErrorMessage,
  codemodeUrlHost,
  removeCodemodeConnector,
  setCodemodeConnectorToken,
  startCodemodeConnectorSignIn,
  updateCodemodeConnector,
  watchCodemodeConnectorSignIn
} from './codemode-connectors-client'

function statusTone(status: CodemodeConnectorStatus): string {
  switch (status) {
    case 'connected':
      return 'border-status-success-border bg-status-success-background text-status-success'
    case 'sign-in-needed':
    case 'token-needed':
      return 'border-status-warning-border bg-status-warning-background text-status-warning-text'
    case 'error':
      return 'border-destructive/40 bg-destructive/10 text-destructive'
  }
}

function statusLabel(status: CodemodeConnectorStatus, t: Translate): string {
  switch (status) {
    case 'connected':
      return t('settings.codemode.connectors.status.connected', 'Connected')
    case 'sign-in-needed':
      return t('settings.codemode.connectors.status.signInNeeded', 'Sign in needed')
    case 'token-needed':
      return t('settings.codemode.connectors.status.tokenNeeded', 'Token needed')
    case 'error':
      return t('settings.codemode.connectors.status.error', 'Error')
  }
}

type Busy = 'trusted' | 'enabled' | 'token' | 'remove' | 'sign-in' | null

export function CodemodeConnectorRow({
  connector,
  onChange,
  onRemove,
  onRefresh
}: {
  connector: CodemodeConnectorView
  onChange: (connector: CodemodeConnectorView) => void
  onRemove: (id: string) => void
  /** Reads the list again, after a sign-in in the browser ends. */
  onRefresh: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { id, name } = connector
  const tokenFieldId = useId()
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [panel, setPanel] = useState<'token' | 'remove' | null>(null)
  const [token, setToken] = useState('')
  const [attemptId, setAttemptId] = useState<string | null>(null)

  useEffect(
    () =>
      attemptId === null
        ? undefined
        : watchCodemodeConnectorSignIn(id, ({ failure }) => {
            setAttemptId(null)
            setError(failure)
            onRefresh()
          }),
    [attemptId, id, onRefresh]
  )

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    setError(null)
    try {
      await action()
    } catch (caught: unknown) {
      setError(codemodeConnectorErrorMessage(caught))
    }
    setBusy(null)
  }

  const toggle = (field: 'trusted' | 'enabled'): void =>
    void run(field, async () =>
      onChange(await updateCodemodeConnector(id, { [field]: !connector[field] }))
    )

  const signIn = (): void =>
    void run('sign-in', async () => setAttemptId(await startCodemodeConnectorSignIn(id)))

  const cancelSignIn = (): void => {
    const attempt = attemptId
    setAttemptId(null)
    void cancelCodemodeConnectorSignIn(id, attempt ?? undefined).catch(() => undefined)
  }

  const saveToken = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!token) {
      return
    }
    void run('token', async () => {
      const saved = await setCodemodeConnectorToken(id, token)
      setToken('')
      setPanel(null)
      onChange(saved)
    })
  }

  const remove = (): void =>
    void run('remove', async () => {
      await removeCodemodeConnector(id)
      onRemove(id)
    })

  const showSignIn = connector.auth === 'oauth' && connector.status !== 'connected'
  const showSetToken = connector.auth === 'token'
  return (
    <div data-settings-row="" className="space-y-3 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 grow basis-40 space-y-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{name}</span>
            <SettingsBadge className={cn('shrink-0', statusTone(connector.status))}>
              {statusLabel(connector.status, t)}
            </SettingsBadge>
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" title={connector.url}>
            {codemodeUrlHost(connector.url)}
          </p>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {t('settings.codemode.connectors.trusted', 'Trusted')}
            <Switch
              size="compact"
              checked={connector.trusted}
              disabled={busy === 'trusted'}
              onCheckedChange={() => toggle('trusted')}
              aria-label={t('settings.codemode.connectors.trustedLabel', 'Trust {{name}}', {
                name
              })}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {t('settings.codemode.connectors.enabled', 'Enabled')}
            <Switch
              size="compact"
              checked={connector.enabled}
              disabled={busy === 'enabled'}
              onCheckedChange={() => toggle('enabled')}
              aria-label={t('settings.codemode.connectors.enabledLabel', 'Enable {{name}}', {
                name
              })}
            />
          </label>
          {/* A fixed width keeps every row's switches in one column, whichever actions it has. */}
          <div className="flex items-center justify-end gap-1 sm:w-36">
            {showSignIn ? (
              <Button
                variant="outline"
                size="xs"
                disabled={busy === 'sign-in' || attemptId !== null}
                onClick={signIn}
              >
                {busy === 'sign-in' ? <Loader2 className="animate-spin" /> : null}
                {t('settings.codemode.connectors.signIn', 'Sign in')}
              </Button>
            ) : null}
            {showSetToken ? (
              <Button
                variant="outline"
                size="xs"
                aria-expanded={panel === 'token'}
                onClick={() => setPanel(panel === 'token' ? null : 'token')}
              >
                {t('settings.codemode.connectors.setToken', 'Set token')}
              </Button>
            ) : null}
            <Button
              variant="ghost-destructive"
              size="xs"
              aria-expanded={panel === 'remove'}
              onClick={() => setPanel(panel === 'remove' ? null : 'remove')}
            >
              {t('settings.codemode.connectors.remove', 'Remove')}
            </Button>
          </div>
        </div>
      </div>
      {attemptId !== null ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
          <span>
            {t(
              'settings.codemode.connectors.finishInBrowser',
              'Finish signing in in your browser.'
            )}
          </span>
          <Button variant="ghost" size="xs" onClick={cancelSignIn}>
            {t('settings.codemode.connectors.cancel', 'Cancel')}
          </Button>
        </div>
      ) : null}
      {panel === 'token' ? (
        <form className="flex flex-wrap items-center gap-2" onSubmit={saveToken}>
          <label htmlFor={tokenFieldId} className="sr-only">
            {t('settings.codemode.connectors.tokenLabel', 'Token for {{name}}', { name })}
          </label>
          <Input
            id={tokenFieldId}
            type="password"
            autoComplete="new-password"
            autoFocus
            variant="code"
            className="h-8 min-w-0 flex-1 basis-56"
            maxLength={8192}
            value={token}
            placeholder={t('settings.codemode.connectors.tokenPlaceholder', 'Paste a token')}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={!token || busy === 'token'}>
            {busy === 'token' ? <Loader2 className="animate-spin" /> : null}
            {t('settings.codemode.connectors.save', 'Save')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setToken('')
              setPanel(null)
            }}
          >
            {t('settings.codemode.connectors.cancel', 'Cancel')}
          </Button>
        </form>
      ) : null}
      {panel === 'remove' ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">
            {t(
              'settings.codemode.connectors.removeConfirm',
              'Remove {{name}}? Its sign-in is deleted and chats lose its tools.',
              { name }
            )}
          </p>
          <Button variant="destructive" size="sm" disabled={busy === 'remove'} onClick={remove}>
            {busy === 'remove' ? <Loader2 className="animate-spin" /> : null}
            {t('settings.codemode.connectors.remove', 'Remove')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setPanel(null)}>
            {t('settings.codemode.connectors.cancel', 'Cancel')}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
