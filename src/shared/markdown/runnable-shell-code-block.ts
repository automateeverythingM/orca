const RUNNABLE_SHELL_LANGUAGES: ReadonlySet<string> = new Set([
  'ash',
  'bash',
  'bat',
  'batch',
  'cmd',
  'console',
  'dash',
  'dos',
  'fish',
  'ksh',
  'powershell',
  'ps1',
  'pwsh',
  'sh',
  'shell',
  'shellscript',
  'shellsession',
  'terminal',
  'zsh'
])

const PROMPT_TRANSCRIPT_LANGUAGES: ReadonlySet<string> = new Set(['console', 'shellsession'])

const LINE_BREAK_RE = /\r\n|\r|\n/g
const PROMPT_PREFIX_RE = /^\$\s+/

/** Whether a fenced code block language tag represents a runnable shell command. */
export function isRunnableShellLanguage(language: string | undefined): boolean {
  if (!language) {
    return false
  }
  return RUNNABLE_SHELL_LANGUAGES.has(language.trim().toLowerCase())
}

function isCommentLine(trimmed: string, languageKey: string): boolean {
  if (
    languageKey === 'cmd' ||
    languageKey === 'bat' ||
    languageKey === 'batch' ||
    languageKey === 'dos'
  ) {
    return /^rem(?:\s|$)/i.test(trimmed) || trimmed.startsWith('::')
  }
  return trimmed.startsWith('#')
}

/**
 * Normalize a shell code block into the command string sent to a terminal PTY.
 * Preserves multi-line scripts and inline comments; strips `$ ` prompt markers
 * only in transcript fences or when every non-empty command line carries one.
 */
export function prepareShellBlockCommand(code: string, language?: string): string {
  const normalized = code.replace(LINE_BREAK_RE, '\n').replace(/^\n+|\n+$/g, '')
  if (!normalized.trim()) {
    return ''
  }
  const languageKey = language?.trim().toLowerCase() ?? ''
  const lines = normalized.split('\n')
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
  const nonCommentLines = nonEmptyLines.filter((line) => !isCommentLine(line.trim(), languageKey))
  if (nonCommentLines.length === 0) {
    return ''
  }
  const stripPromptPrefix = PROMPT_TRANSCRIPT_LANGUAGES.has(languageKey)
    ? nonCommentLines.some((line) => PROMPT_PREFIX_RE.test(line.trimStart()))
    : nonCommentLines.every((line) => PROMPT_PREFIX_RE.test(line.trimStart()))
  if (!stripPromptPrefix) {
    return normalized
  }
  const cleaned = lines
    .map((line) => {
      const trimmedStart = line.trimStart()
      return PROMPT_PREFIX_RE.test(trimmedStart) ? trimmedStart.replace(PROMPT_PREFIX_RE, '') : line
    })
    .join('\n')
    .trim()
  return cleaned
}
