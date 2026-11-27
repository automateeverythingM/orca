import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { app } from 'electron'
import releaseClassicIcon from '../../../../resources/icon.png?asset'
import forkMacIcon from '../../../../resources/app-icons/orca-fork-mac.png?asset'

// A packaged local build with its own bundle ID (build:mac:stable-local) is "Orca Fork": its classic
// icon is the fork icon, like its bundle icon, so the Dock never shows the release icon for it.
export function isMacForkBuild(): boolean {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    return false
  }
  try {
    const plist = readFileSync(resolve(dirname(app.getPath('exe')), '..', 'Info.plist'), 'utf8')
    const id = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
    return id !== undefined && id !== 'com.stablyai.orca'
  } catch {
    return false
  }
}

/** The packaged app's classic icon: the fork icon in Orca Fork, else the release icon. */
export const packagedClassicIcon = isMacForkBuild() ? forkMacIcon : releaseClassicIcon
