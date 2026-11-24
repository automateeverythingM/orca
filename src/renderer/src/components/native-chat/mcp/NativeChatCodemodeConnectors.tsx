import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { statusLabel } from '../../settings/codemode/CodemodeConnectorRow'
import type { CodemodeSessionConnectorsState } from './use-codemode-session-connectors'

/** The tray's "Code mode connectors" section: one switch per connector for this chat. */
export function NativeChatCodemodeConnectors({
  connectors,
  errors,
  toggle
}: CodemodeSessionConnectorsState): React.JSX.Element | null {
  const t = useTranslate()
  if (connectors.length === 0) {
    return null
  }
  const title = t('components.native-chat.mcp.codemode.title', 'Code mode connectors')
  return (
    <div className="border-t border-border py-1">
      <p className="px-3 pt-1.5 pb-0.5 font-mono text-3xs uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <ul role="list" aria-label={title}>
        {connectors.map((connector) => {
          const detail = connector.enabled
            ? statusLabel(connector.status, t)
            : t('components.native-chat.mcp.codemode.disabled', 'Disabled in Settings')
          return (
            <li key={connector.id}>
              <div className="flex h-8 min-w-0 items-center gap-2 pr-2 pl-3">
                <span
                  aria-hidden="true"
                  className="flex size-3 shrink-0 items-center justify-center"
                >
                  <span
                    className={cn(
                      'size-1.75 rounded-full',
                      connector.enabled && connector.status === 'connected'
                        ? 'bg-status-success'
                        : connector.enabled && connector.status === 'error'
                          ? 'bg-destructive'
                          : connector.enabled
                            ? 'bg-status-warning'
                            : 'bg-muted-foreground/40'
                    )}
                  />
                </span>
                <span className="max-w-1/2 shrink-0 truncate font-medium text-foreground">
                  {connector.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={detail}>
                  {detail}
                </span>
                <Switch
                  size="compact"
                  checked={connector.enabled && connector.on}
                  disabled={!connector.enabled}
                  aria-label={t('components.native-chat.mcp.toggle', 'Use {{name}}', {
                    name: connector.name
                  })}
                  onCheckedChange={(checked) => toggle(connector.id, checked)}
                />
              </div>
              {errors[connector.id] ? (
                <p className="mr-2 mb-1.5 ml-8 text-destructive">{errors[connector.id]}</p>
              ) : null}
            </li>
          )
        })}
      </ul>
      <p className="px-3 pt-1 pb-1 text-muted-foreground">
        {t(
          'components.native-chat.mcp.codemode.caption',
          "Off stops use in this chat now; the agent's direct tool list updates next launch."
        )}
      </p>
    </div>
  )
}
