import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkUpstreamReleaseForNotification,
  hasPackagedUpdateConfig
} from './local-build-update-notification'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-updater-notify-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('hasPackagedUpdateConfig', () => {
  it('detects whether Resources/app-update.yml exists', async () => {
    const dir = makeTempDir()
    expect(await hasPackagedUpdateConfig(dir)).toBe(false)
    writeFileSync(join(dir, 'app-update.yml'), 'provider: github\n')
    expect(await hasPackagedUpdateConfig(dir)).toBe(true)
  })
})

describe('checkUpstreamReleaseForNotification', () => {
  it('returns available with changelog when upstream has a newer tag', async () => {
    const outcome = await checkUpstreamReleaseForNotification(
      { currentVersion: '1.20.0', includePrerelease: false },
      {
        fetchTags: async () => ({ tags: ['v1.21.0'], state: 'ready' }),
        loadChangelog: async (target) => ({
          release: {
            title: `Orca ${target}`,
            description: 'Release summary',
            releaseNotesUrl: `https://github.com/stablyai/orca/releases/tag/v${target}`
          },
          releasesBehind: 1
        })
      }
    )

    expect(outcome).toEqual({
      kind: 'available',
      version: '1.21.0',
      publishingWindow: false,
      changelog: {
        release: {
          title: 'Orca 1.21.0',
          description: 'Release summary',
          releaseNotesUrl: 'https://github.com/stablyai/orca/releases/tag/v1.21.0'
        },
        releasesBehind: 1
      }
    })
  })

  it('returns not-available when upstream has no newer version', async () => {
    const outcome = await checkUpstreamReleaseForNotification(
      { currentVersion: '1.21.0', includePrerelease: false },
      {
        fetchTags: async () => ({ tags: ['v1.21.0'], state: 'ready' }),
        loadChangelog: async () => {
          throw new Error('should not fetch changelog when already up to date')
        }
      }
    )

    expect(outcome).toEqual({ kind: 'not-available', delayedUpdate: null })
  })
})
