import { memo } from 'react'
import { Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import {
  NATIVE_CHAT_COMPRESSION_MODES,
  type NativeChatCompressionMode
} from '../../../../../../shared/native-chat/input/composer/native-chat-compression'
import { useNativeChatPickerFocusReturn } from '../focus/native-chat-picker-focus-return'

export type NativeChatCompressionPickerProps = {
  mode: NativeChatCompressionMode
  disabled?: boolean
  onSelect: (mode: NativeChatCompressionMode) => void
  focusComposer?: () => void
  /** Overflow menu renders a labeled trigger so the control stays clear inside the More popover. */
  inOverflow?: boolean
}

function compressionModeLabel(mode: NativeChatCompressionMode, t: Translate): string {
  switch (mode) {
    case 'off':
      return t('components.native-chat.composer.compressionOff', 'Off')
    case 'terra':
      return t('components.native-chat.composer.compressionTerra', 'Terra')
    case 'ultra':
      return t('components.native-chat.composer.compressionUltra', 'Ultra')
  }
}

function compressionModeDescription(mode: NativeChatCompressionMode, t: Translate): string {
  switch (mode) {
    case 'off':
      return t(
        'components.native-chat.composer.compressionOffDescription',
        'Normal response detail'
      )
    case 'terra':
      return t(
        'components.native-chat.composer.compressionTerraDescription',
        'Terse, concise replies without filler'
      )
    case 'ultra':
      return t(
        'components.native-chat.composer.compressionUltraDescription',
        'Maximum caveman-style token compression'
      )
  }
}

function NativeChatCompressionPickerInner({
  mode,
  disabled = false,
  onSelect,
  focusComposer,
  inOverflow = false
}: NativeChatCompressionPickerProps): React.JSX.Element {
  const t = useTranslate()
  useUiLanguageRevision()
  const focusReturn = useNativeChatPickerFocusReturn(focusComposer)
  const title = t('components.native-chat.composer.compression', 'Compression')
  const valueLabel = compressionModeLabel(mode, t)
  const active = mode !== 'off'
  const accessibleName = t(
    'components.native-chat.composer.pillAccessibleName',
    '{{value0}} {{value1}}',
    { value0: title, value1: valueLabel }
  )
  const tooltipLabel = t(
    'components.native-chat.composer.compressionTooltip',
    '{{title}} · {{mode}}',
    { title, mode: valueLabel }
  )

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <Button
              ref={focusReturn.triggerRef}
              type="button"
              variant={active ? 'secondary' : 'ghost'}
              size={!active && !inOverflow ? 'icon-sm' : 'xs'}
              aria-label={accessibleName}
              className={
                !active && !inOverflow ? 'size-7 pointer-coarse:size-11' : 'min-w-0 shrink'
              }
            >
              <Minimize2 className="size-3.5 shrink-0" aria-hidden />
              {inOverflow ? (
                <span className="truncate">{tooltipLabel}</span>
              ) : active ? (
                <span data-composer-label className="truncate">
                  {valueLabel}
                </span>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {tooltipLabel}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        side="top"
        collisionPadding={8}
        className="w-64 max-w-(--radix-dropdown-menu-content-available-width)"
        onInteractOutside={focusReturn.onInteractOutside}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
      >
        <DropdownMenuRadioGroup aria-label={title} value={mode}>
          {NATIVE_CHAT_COMPRESSION_MODES.map((choice) => (
            <DropdownMenuRadioItem
              key={choice}
              value={choice}
              disabled={disabled}
              onSelect={() => {
                focusReturn.notePick()
                onSelect(choice)
              }}
            >
              <div className="min-w-0 py-0.5">
                <div className="text-sm font-medium">{compressionModeLabel(choice, t)}</div>
                <div className="text-xs font-normal text-muted-foreground">
                  {compressionModeDescription(choice, t)}
                </div>
              </div>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const NativeChatCompressionPicker = memo(NativeChatCompressionPickerInner)
