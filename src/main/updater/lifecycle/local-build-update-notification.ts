import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChangelogData } from '../../../shared/updater/update-status-types'
import { fetchChangelog } from '../releases/updater-changelog'
import { compareVersions } from '../releases/updater-fallback'
import {
  fetchNewerReleaseTagsWithReadiness,
  normalizeTagToVersion,
  type FetchNewerReleaseTagsResult
} from '../releases/updater-prerelease-feed'
import { toDelayedUpdate } from '../releases/updater-release-delay'

export type NotifyOnlyUpstreamCheckOutcome =
  | {
      kind: 'available'
      version: string
      changelog: ChangelogData | null
      publishingWindow: boolean
    }
  | {
      kind: 'not-available'
      delayedUpdate: ReturnType<typeof toDelayedUpdate>
    }

/** Local `--dir` / custom fork builds omit `app-update.yml`, so electron-updater cannot run on them. */
export async function hasPackagedUpdateConfig(
  resourcesPath: string | undefined = process.resourcesPath
): Promise<boolean> {
  // Non-Electron test processes lack resourcesPath; only real packaged builds without app-update.yml are notify-only.
  if (!resourcesPath) {
    return true
  }
  return access(join(resourcesPath, 'app-update.yml')).then(
    () => true,
    () => false
  )
}

export async function checkUpstreamReleaseForNotification(
  input: {
    currentVersion: string
    includePrerelease: boolean
    releaseFilter?: 'perf'
    minimumVersion?: string
    minReleaseAgeMs?: number
    delayDays?: number
    now?: number
  },
  deps: {
    fetchTags?: (
      currentVersion: string,
      maxTags: number,
      options: {
        includePrerelease: boolean
        releaseFilter?: 'perf'
        minimumVersion?: string
        minReleaseAgeMs?: number
        now?: number
      }
    ) => Promise<FetchNewerReleaseTagsResult>
    loadChangelog?: (targetVersion: string, currentVersion: string) => Promise<ChangelogData | null>
  } = {}
): Promise<NotifyOnlyUpstreamCheckOutcome> {
  const fetchTags = deps.fetchTags ?? fetchNewerReleaseTagsWithReadiness
  const loadChangelog = deps.loadChangelog ?? fetchChangelog
  const delayDays = input.delayDays ?? 0
  const result = await fetchTags(input.currentVersion, 1, {
    includePrerelease: input.includePrerelease,
    ...(input.releaseFilter ? { releaseFilter: input.releaseFilter } : {}),
    ...(input.minimumVersion ? { minimumVersion: input.minimumVersion } : {}),
    ...(input.minReleaseAgeMs && input.minReleaseAgeMs > 0
      ? { minReleaseAgeMs: input.minReleaseAgeMs, now: input.now }
      : {})
  })
  const delayedUpdate = toDelayedUpdate(result.releaseDelay?.heldRelease, delayDays)
  const tag = result.tags[0] ?? (result.state === 'not-ready' ? result.lastGoodTag : undefined)
  if (!tag) {
    return { kind: 'not-available', delayedUpdate }
  }
  const version = normalizeTagToVersion(tag)
  if (compareVersions(version, input.currentVersion) <= 0) {
    return { kind: 'not-available', delayedUpdate }
  }
  const changelog = await loadChangelog(version, input.currentVersion).catch(() => null)
  return {
    kind: 'available',
    version,
    changelog,
    publishingWindow: result.state === 'not-ready'
  }
}
