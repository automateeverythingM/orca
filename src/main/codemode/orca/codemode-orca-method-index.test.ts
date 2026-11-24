import { describe, expect, it } from 'vitest'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import { OrcaMethodIndex } from './codemode-orca-method-index'
import { labelOrcaMethod } from './codemode-orca-method-labels'
import { CODEMODE_ORCA_DENIED_METHODS, isExposedOrcaMethod } from './codemode-orca-method-policy'

const SECRET_NAME =
  /(auth|token|credential|secret|password|apikey|api-key|oauth|signin|signout|login|logout|pairing|cookie)/i
const EXCLUDED_AREAS = [
  'codemode',
  'accounts',
  'orcaAccount',
  'pairing',
  'pairedServerAsks',
  'mobileRelay',
  'settings',
  'plugins',
  'skills',
  'updater',
  'managedRuntime',
  'orcad'
]

const AGENT_LAUNCHES = [
  'agentSession.create',
  'agentSession.ensure',
  'agentSession.restartContinue',
  'agentSession.continueInterrupted',
  'agent.launch',
  'agent.launchReplay',
  'terminal.createAgentSession',
  'terminal.ensureAgentSession',
  'terminal.create',
  'session.tabs.createTerminal',
  'worktree.create',
  'folderWorkspace.create',
  'orchestration.dispatch',
  'orchestration.workerStart',
  'orchestration.run',
  'automation.runNow',
  'bots.create',
  'bots.session.start',
  'bots.kickoff.retry',
  'bots.sendRunAgain',
  'bots.takeOver',
  'bots.groups.send',
  'bots.lookAround.lookNow',
  'bots.suggestions.start',
  'bots.tidyUp.now'
]
const CLIENT_PROTOCOL = [
  'browser.clientHost.commandResult',
  'browser.clientHost.commandResultChunk',
  'browser.clientHost.requestResult',
  'browser.clientHost.pageMetadata',
  'browser.clientHost.fileChannel.write',
  'browser.clientPage.initializationAction',
  'browser.screencast.ack',
  'browser.screencast.reclaimForDesktop',
  'browser.grab.viewportBridge',
  'desktopBrowserBridge.result',
  'desktopBrowserBridge.fileRead',
  'mobileWeb.bundle.manifest',
  'host.declareClient',
  'runtime.clientCapabilities.update',
  'notifications.reportDesktopPresence',
  'notifications.pushCoverage',
  'terminal.ackOutput',
  'terminal.resizeForClient',
  'terminal.updateViewport',
  'terminal.setViewerColors',
  'terminal.unsubscribe',
  'session.tabs.unsubscribeAll',
  'orchestration.workerApprovalsUnsubscribe',
  'sidebarInputs.repoIcons'
]

const registryNames = new Set<string>(ALL_RPC_METHODS.map((m) => m.name))
const exposed = ALL_RPC_METHODS.filter(isExposedOrcaMethod)
const exposedNames = new Set<string>(exposed.map((m) => m.name))

describe('Orca method exposure for code mode', () => {
  it('never exposes credentials, settings, code mode, streams or approval answers', () => {
    for (const method of exposed) {
      const area = method.name.split('.')[0]
      expect(method.name).not.toMatch(SECRET_NAME)
      expect(method.permission).toBe('workspace')
      expect('stream' in method && method.stream).toBeFalsy()
      expect(EXCLUDED_AREAS).not.toContain(area)
      expect(CODEMODE_ORCA_DENIED_METHODS.has(method.name)).toBe(false)
      if (area === 'agentSession') {
        expect(method.name).not.toMatch(/respond|answer|approv|permission|setOption/i)
      }
    }
    for (const name of [
      'codemode.connectors.setToken',
      'codemode.connectors.add',
      'webhooks.secret',
      'webhooks.reveal',
      'browser.setCredentials',
      'bots.tools.signIn.start',
      'agentSession.respondToApproval',
      'agentSession.setOption',
      'orchestration.approvalAnswer'
    ]) {
      expect(exposedNames.has(name), name).toBe(false)
    }
    const accountOrSettings = [...exposedNames].filter((name) =>
      /^(accounts|settings)\./.test(name)
    )
    expect(accountOrSettings).toEqual([])
  })

  it('never exposes host-client protocol plumbing', () => {
    for (const name of CLIENT_PROTOCOL) {
      expect(registryNames.has(name), name).toBe(true)
      expect(exposedNames.has(name), name).toBe(false)
    }
    const plumbing = [...exposedNames].filter(
      (name) =>
        /^(browser\.clientHost|browser\.clientPage|desktopBrowserBridge|mobileWeb)\./.test(name) ||
        /\.(commandResult|commandResultChunk)$/.test(name) ||
        /unsubscribe/i.test(name)
    )
    expect(plumbing).toEqual([])
  })

  it('labels every method that starts an agent or worker destructive', () => {
    for (const name of AGENT_LAUNCHES) {
      expect(exposedNames.has(name), name).toBe(true)
      expect(labelOrcaMethod(name), name).toBe('destructive')
    }
  })

  it('labels every exposed method and sorts verbs into read, write and destructive', () => {
    for (const method of exposed) {
      expect(['read', 'write', 'destructive']).toContain(labelOrcaMethod(method.name))
    }
    const expected: Record<string, string> = {
      'worktree.list': 'read',
      'worktree.set': 'write',
      'worktree.remove': 'destructive',
      'worktree.rm': 'destructive',
      'repo.remove': 'destructive',
      'repo.rm': 'destructive',
      'terminal.close': 'destructive',
      'terminal.stop': 'destructive',
      'git.status': 'read',
      'git.resolveConflict': 'write',
      'repo.sparsePresets': 'read',
      'files.read': 'read',
      'orchestration.runList': 'read',
      'orchestration.check': 'write'
    }
    for (const [name, label] of Object.entries(expected)) {
      expect(labelOrcaMethod(name), name).toBe(label)
    }
    for (const name of ['worktree.rm', 'repo.rm', 'terminal.close', 'terminal.stop']) {
      expect(exposedNames.has(name), name).toBe(true)
    }
  })

  it('indexes exposed methods by area and name', () => {
    const index = OrcaMethodIndex.from(ALL_RPC_METHODS)
    const areas = index.areas()
    expect(areas).toEqual([...new Set(areas)].sort())
    expect(index.get('worktree.create')).toMatchObject({
      name: 'worktree.create',
      area: 'worktree',
      label: 'destructive'
    })
    expect(index.get('codemode.connectors.setToken')).toBeNull()
    expect(index.inArea('nope')).toEqual([])
    expect(index.inArea('worktree').every((entry) => entry.area === 'worktree')).toBe(true)

    const counts = { read: 0, write: 0, destructive: 0 }
    for (const area of areas) {
      for (const entry of index.inArea(area)) {
        counts[entry.label] += 1
      }
    }
    console.log(`orca.* exposed ${exposed.length} of ${ALL_RPC_METHODS.length}`, counts)
  })
})
