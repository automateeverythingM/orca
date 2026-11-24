import { describe, expect, it } from 'vitest'
import type { BotToolServer } from '../../../../shared/bot-tools'
import { acpCodemodeUnavailableRow, acpSessionMcpServers } from '../../../acp/launch/acp-mcp-server'
import { acpBotMcpServers } from '../../../bots/bot-tools-acp'
import {
  BotLaunchTools,
  CODEMODE_TOKEN_ENV,
  withBotLaunchToolsEnv
} from '../../../bots/bot-launch-tools'
import { codexBotToolsThreadConfig } from '../../../bots/bot-tools-codex'
import { PI_BOT_TOOLS_ENV, piBotToolsConfig } from '../../../bots/bot-tools-pi'
import { claudeBotSessionOptions } from '../../../claude/structured/launch/claude-bot-session-options'
import { codemodeGateMode, withCodemodeTools } from './structured-agent-codemode-launch'

const TOKEN = 'a'.repeat(64)
const URL = 'http://127.0.0.1:4100/codemode/mcp'
const FAKE_URL = 'http://127.0.0.1:4200/c/AbCdEfGh12345678/mcp'
const BEARER = `Bearer ${TOKEN}`
const REFERENCED = `Bearer \${${CODEMODE_TOKEN_ENV}}`

function codemode(enabled: boolean) {
  const launched: string[] = []
  return {
    launched,
    launch: {
      enabled: () => enabled,
      service: {
        // The service's answer for a chat with connector `fake` enabled and on.
        launchServer: async ({ sessionId }: { sessionId: string }): Promise<BotToolServer[]> => {
          launched.push(sessionId)
          return [
            { name: 'orca', url: URL, transport: 'http', headers: { authorization: BEARER } },
            { name: 'fake', url: FAKE_URL, transport: 'http', headers: { authorization: BEARER } }
          ]
        },
        endSession: async () => {}
      }
    }
  }
}

function toolsFor(
  agent: string,
  base: BotLaunchTools = BotLaunchTools.none
): Promise<BotLaunchTools> {
  return withCodemodeTools(base, codemode(true).launch, {
    agent,
    sessionId: 's1',
    launchId: 'launch-1',
    root: '/work',
    env: {},
    mode: () => 'ask'
  })
}

const basis = { instructions: async () => null, readOnly: null }

describe('code mode in a structured launch', () => {
  it('gives Claude orca and each connector, naming the token variable, with the token in its env', async () => {
    const tools = await toolsFor('claude')
    const options = await claudeBotSessionOptions(basis, [], tools, { mcpConfig: false })
    expect(options.mcpServers).toEqual({
      orca: { type: 'http', url: URL, headers: { authorization: REFERENCED } },
      fake: { type: 'http', url: FAKE_URL, headers: { authorization: REFERENCED } }
    })
    const env = withBotLaunchToolsEnv({ NO_PROXY: 'corp.example' }, tools)
    expect(env[CODEMODE_TOKEN_ENV]).toBe(TOKEN)
    expect(env.NO_PROXY).toBe('corp.example,127.0.0.1,localhost,::1')
  })

  it("starts Claude without code mode, and without the bot's tools-off note, when managed settings refuse MCP config", async () => {
    const tools = await toolsFor('claude')
    const options = await claudeBotSessionOptions(basis, [], tools, { mcpConfig: true })
    expect(options.mcpServers).toBeUndefined()
    expect(options.systemPrompt).toBeUndefined()
  })

  it("puts the literal bearer in Codex's thread config and none of it in Codex's env", async () => {
    const tools = await toolsFor('codex')
    expect(codexBotToolsThreadConfig(tools, [])).toEqual({
      'mcp_servers.orca.url': URL,
      'mcp_servers.orca.http_headers': { authorization: BEARER },
      'mcp_servers.fake.url': FAKE_URL,
      'mcp_servers.fake.http_headers': { authorization: BEARER }
    })
    expect(withBotLaunchToolsEnv({}, tools)[CODEMODE_TOKEN_ENV]).toBeUndefined()
    expect(tools.commandEnv).toEqual({})
  })

  it("adds orca and each connector to Pi's tool config, naming the token variable", async () => {
    const tools = await toolsFor('pi')
    expect(JSON.parse(piBotToolsConfig(tools) ?? '{}')).toEqual({
      orca: { url: URL, headers: { authorization: REFERENCED } },
      fake: { url: FAKE_URL, headers: { authorization: REFERENCED } }
    })
    expect(withBotLaunchToolsEnv({}, tools)[CODEMODE_TOKEN_ENV]).toBe(TOKEN)
    expect(PI_BOT_TOOLS_ENV).toBe('ORCA_PI_BOT_TOOLS')
  })

  it('adds nothing and opens no code-mode session when the setting is off', async () => {
    const off = codemode(false)
    const tools = await withCodemodeTools(BotLaunchTools.none, off.launch, {
      agent: 'claude',
      sessionId: 's1',
      launchId: 'launch-1',
      root: '/work',
      env: {},
      mode: () => 'ask'
    })
    expect(off.launched).toEqual([])
    expect(tools.servers).toEqual([])
    expect(piBotToolsConfig(tools)).toBeNull()
    expect(codexBotToolsThreadConfig(tools, [])).toEqual({})
    expect(await claudeBotSessionOptions(basis, [], tools, { mcpConfig: false })).toEqual({})
  })

  it('replaces a bot server named like a connector with the connector', async () => {
    const relay = { grant: async () => ({ origin: 'http://127.0.0.1:4300', token: 'bot' }) }
    const base = await BotLaunchTools.for(relay, { botId: 'b1', folder: '/bot', agent: 'claude' }, [
      { name: 'fake', command: 'bot-fake', args: [] },
      { name: 'keep', command: 'bot-keep', args: [] }
    ])
    const tools = await toolsFor('claude', base)
    const options = await claudeBotSessionOptions(basis, [], tools, { mcpConfig: false })
    expect(options.mcpServers).toEqual({
      keep: { type: 'stdio', command: 'bot-keep', args: [] },
      orca: { type: 'http', url: URL, headers: { authorization: REFERENCED } },
      fake: { type: 'http', url: FAKE_URL, headers: { authorization: REFERENCED } }
    })
    expect(tools.botServers.map((server) => server.name)).toEqual(['keep'])
    const acp = acpBotMcpServers(await toolsFor('gemini', base))
    expect(acp.map((server) => [server.name, 'url' in server ? server.url : null])).toEqual([
      ['keep', null],
      ['orca', URL],
      ['fake', FAKE_URL]
    ])
  })

  it('gives an ACP agent orca and its connectors only when it says it takes MCP over HTTP', async () => {
    const tools = await toolsFor('gemini')
    const launch = {
      mcpServers: acpBotMcpServers(tools),
      orcaMcpServerNames: tools.orcaServerNames
    }
    const withoutHttp = acpSessionMcpServers(launch, { agentCapabilities: {} })
    const withHttp = acpSessionMcpServers(launch, {
      agentCapabilities: { mcpCapabilities: { http: true } }
    })
    expect(withoutHttp).toEqual([])
    expect(acpCodemodeUnavailableRow(launch, withoutHttp, 'p1')).toEqual([
      expect.objectContaining({
        item: 'codemode-unavailable:p1',
        body: expect.objectContaining({ kind: 'status', tone: 'warning' })
      })
    ])
    expect(acpCodemodeUnavailableRow(launch, withHttp, 'p1')).toEqual([])
    expect(acpCodemodeUnavailableRow({}, [], 'p1')).toEqual([])
    const headers = [{ name: 'authorization', value: BEARER }]
    expect(withHttp).toEqual([
      { type: 'http', name: 'orca', url: URL, headers },
      { type: 'http', name: 'fake', url: FAKE_URL, headers }
    ])
  })
})

describe('codemodeGateMode', () => {
  it("follows the session's saved permission mode on every read", () => {
    const record = { provider: 'claude', permissionMode: 'ask' }
    const mode = codemodeGateMode(
      () => record,
      () => null,
      's1',
      'full-access'
    )
    expect(mode()).toBe('ask')
    record.permissionMode = 'full-access'
    expect(mode()).toBe('full-access')
  })

  it('is read-only for a Look-around session and for a session whose record is gone', () => {
    const record = { provider: 'claude', permissionMode: 'full-access' }
    expect(
      codemodeGateMode(
        () => record,
        () => 'look-around',
        's1',
        undefined
      )()
    ).toBe('read-only')
    expect(
      codemodeGateMode(
        () => null,
        () => null,
        's1',
        'full-access'
      )()
    ).toBe('read-only')
  })
})
