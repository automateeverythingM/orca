import type { ZodType } from 'zod'

export type OrcaMethodLabel = 'read' | 'write' | 'destructive'

/** The fields of a runtime RPC method the code-mode policy reads. */
export type OrcaMethodSource = {
  name: string
  permission: string
  params: ZodType | null
  stream?: boolean
}

const SECRET_NAME =
  /(auth|token|credential|secret|password|apikey|api-key|oauth|signin|signout|login|logout|pairing|cookie)/i

const EXCLUDED_AREAS: ReadonlySet<string> = new Set([
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
  'orcad',
  // prepareLaunch hands out auth env for any pane; tmuxCompat sends keys and runs shell commands.
  'agentTeams'
])

// Why: a script must never answer or change its own chat's approvals, questions or mode.
const AGENT_SESSION_SELF_CONTROL = /respond|answer|approv|permission|setoption/i

// Host↔client protocol: results, acks, stream teardown and client registration a client sends.
const CLIENT_PROTOCOL_AREAS: ReadonlySet<string> = new Set(['desktopBrowserBridge', 'mobileWeb'])
const CLIENT_PROTOCOL_PREFIXES = [
  'browser.clientHost.',
  'browser.clientPage.',
  'browser.screencast.'
]
const CLIENT_PROTOCOL_LAST_SEGMENT =
  /^(commandResult|commandResultChunk|requestResult)$|unsubscribe/i
export const CODEMODE_ORCA_CLIENT_PROTOCOL_METHODS: ReadonlySet<string> = new Set([
  'host.declareClient',
  'runtime.clientCapabilities.update',
  'notifications.reportDesktopPresence',
  'notifications.pushCoverage',
  'terminal.ackOutput',
  'terminal.resizeForClient',
  'terminal.updateViewport',
  'terminal.setViewerColors',
  'browser.grab.viewportBridge',
  'sidebarInputs.repoIcons'
])

export function isClientProtocolMethod(name: string): boolean {
  return (
    CLIENT_PROTOCOL_AREAS.has(orcaMethodArea(name)) ||
    CLIENT_PROTOCOL_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    CLIENT_PROTOCOL_LAST_SEGMENT.test(name.slice(name.lastIndexOf('.') + 1)) ||
    CODEMODE_ORCA_CLIENT_PROTOCOL_METHODS.has(name)
  )
}

/** Workspace methods a script must never reach although the rules above let them through. */
export const CODEMODE_ORCA_DENIED_METHODS: ReadonlySet<string> = new Set([
  // Approvals, questions and permission mode.
  'agentSession.respondToApproval',
  'agentSession.respondToQuestion',
  'agentSession.setOption',
  'agentSession.approveAutoReviewDenial',
  'agentSession.skipAsyncQuestions',
  'orchestration.approvalAnswer',
  'bots.access.decide',
  // Keys, secrets and account sign-in.
  'webhooks.secret',
  'webhooks.reveal',
  'webhooks.rotate',
  'browser.setCredentials',
  'google.client.import',
  'google.client.export',
  'google.disconnect',
  'google.default.set',
  'google.bot.set',
  'bots.googleSetup.read',
  'bots.googleSetup.write',
  'bots.googleSetup.answer',
  'bots.googleSetup.start',
  'bots.googleSetup.importHostKey',
  'bots.composio.setKey',
  'bots.composio.key',
  'bots.composio.removeKey',
  'bots.composio.declineKey',
  'bots.composio.connect',
  'bots.composio.cancelConnect',
  'bots.composio.disconnect',
  'speech.openAiKey.status',
  'browser.profileImportFromBrowser',
  'agentSession.toolCaller',
  // MCP sign-in for the chat's agent.
  'agentSession.mcp',
  // Host-side commands and remote-host control: proxyCommand, setup/archive scripts, setup approval.
  'ssh.addTarget',
  'ssh.updateTarget',
  'worktree.runApprovedSetup',
  'repo.update',
  'projectGroup.update',
  'projectGroup.updateMany',
  'repo.issueCommandWrite',
  // Stored commands the host runs later: MCP stdio servers, automation prechecks.
  'bots.tools.add',
  'bots.tools.update',
  'automation.create',
  'automation.update',
  // Its trustedOrcaHooks field marks repo hook scripts trusted.
  'ui.set'
])

export function orcaMethodArea(name: string): string {
  return name.split('.')[0] ?? name
}

export function isExposedOrcaMethod(method: OrcaMethodSource): boolean {
  const area = orcaMethodArea(method.name)
  return (
    method.permission === 'workspace' &&
    method.stream !== true &&
    !SECRET_NAME.test(method.name) &&
    !EXCLUDED_AREAS.has(area) &&
    !CODEMODE_ORCA_DENIED_METHODS.has(method.name) &&
    !(area === 'agentSession' && AGENT_SESSION_SELF_CONTROL.test(method.name)) &&
    !isClientProtocolMethod(method.name)
  )
}
