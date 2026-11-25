// @protected-copy: the error line every code-mode Settings action shows (connectors, functions, Learn).
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { translate } from '@/i18n/i18n'

/** A code-mode Settings action's error as the person reads it: main's own words, else a generic line. */
export function codemodeErrorMessage(error: unknown): string {
  if (error instanceof RuntimeRpcCallError && error.message) {
    return error.message
  }
  return translate('settings.codemode.connectors.genericError', 'Something went wrong. Try again.')
}
