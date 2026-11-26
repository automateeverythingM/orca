import { describe, expect, it } from 'vitest'
import { isRunnableShellLanguage, prepareShellBlockCommand } from './runnable-shell-code-block'

describe('runnable shell code blocks', () => {
  it('recognizes POSIX and Windows shell fence tags and rejects non-shell languages', () => {
    for (const tag of [
      'bash',
      'Bash',
      'sh',
      'zsh',
      'shell',
      'fish',
      'console',
      'powershell',
      'pwsh',
      'cmd'
    ]) {
      expect(isRunnableShellLanguage(tag)).toBe(true)
    }
    for (const tag of [undefined, '', 'ts', 'typescript', 'json', 'python', 'html', 'diff']) {
      expect(isRunnableShellLanguage(tag)).toBe(false)
    }
  })

  it('preserves multi-line commands and inline comments verbatim', () => {
    const script = [
      'cd /Users/example/repo',
      'pnpm run build:desktop:assets || true   # keep going on fence',
      'pnpm run build:native && open dist/Orca.app',
      ''
    ].join('\r\n')
    expect(prepareShellBlockCommand(script, 'bash')).toBe(
      [
        'cd /Users/example/repo',
        'pnpm run build:desktop:assets || true   # keep going on fence',
        'pnpm run build:native && open dist/Orca.app'
      ].join('\n')
    )
  })

  it('strips leading $ prompts in console fences or when every command line has one', () => {
    expect(prepareShellBlockCommand('$ git status\n$ git diff --stat\n', 'bash')).toBe(
      'git status\ngit diff --stat'
    )
    expect(prepareShellBlockCommand('$ pnpm test\n', 'console')).toBe('pnpm test')
    // Must not strip $VAR expansions in normal shell scripts.
    expect(prepareShellBlockCommand('echo $HOME\n$EDITOR README.md', 'bash')).toBe(
      'echo $HOME\n$EDITOR README.md'
    )
  })

  it('returns empty string for blank or comment-only blocks', () => {
    expect(prepareShellBlockCommand('   \n  \n', 'bash')).toBe('')
    expect(prepareShellBlockCommand('# just a comment\n# another', 'bash')).toBe('')
    expect(prepareShellBlockCommand('REM windows comment\n:: another', 'cmd')).toBe('')
  })
})
