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

function learnGate(learn: boolean | undefined): () => boolean {
  const gates = structuredAgentSettingGates(() => ({
    ...getDefaultSettings('/home/user'),
    codemodeEnabled: true,
    ...(learn === undefined ? {} : { codemodeLearnEnabled: learn })
  }))
  return () => gates.codemodeLearnEnabled?.() === true
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

describe('code mode Learn gate', () => {
  it('is on only when the setting is exactly true, in the Electron app', () => {
    runningUnderElectron('43.0.0')
    expect(learnGate(true)()).toBe(true)
    expect(learnGate(false)()).toBe(false)
    expect(learnGate(undefined)()).toBe(false)
    runningUnderElectron(undefined)
    expect(learnGate(true)()).toBe(false)
  })
})
