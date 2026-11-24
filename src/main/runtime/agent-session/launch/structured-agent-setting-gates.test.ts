import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { structuredAgentSettingGates } from './structured-agent-setting-gates'

function codemodeGate(enabled: boolean): () => boolean {
  const gates = structuredAgentSettingGates(() => ({
    ...getDefaultSettings('/home/user'),
    codemodeEnabled: enabled
  }))
  return () => gates.codemodeEnabled?.() === true
}

const hostElectron = process.versions.electron

function runningUnderElectron(electron: string | undefined): void {
  if (electron === undefined) {
    Reflect.deleteProperty(process.versions, 'electron')
  } else {
    Object.defineProperty(process.versions, 'electron', { value: electron, configurable: true })
  }
}

afterEach(() => runningUnderElectron(hostElectron))

describe('code mode setting gate', () => {
  it("is on only in this computer's Electron app with the setting on", () => {
    runningUnderElectron('43.0.0')
    expect(codemodeGate(true)()).toBe(true)
    expect(codemodeGate(false)()).toBe(false)
  })

  it('is off on a remote or WSL host, whose server runs plain Node, whatever the setting', () => {
    runningUnderElectron(undefined)
    expect(codemodeGate(true)()).toBe(false)
  })
})
