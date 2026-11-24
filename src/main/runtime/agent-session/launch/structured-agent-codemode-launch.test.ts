import { describe, expect, it } from 'vitest'
import type { BotToolServer } from '../../../../shared/bot-tools'
import { acpSessionMcpServers } from '../../../acp/launch/acp-mcp-server'
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

function codemode(enabled: boolean) {
  const launched: string[] = []
  return {
    launched,
    launch: {
      enabled: () => enabled,
      service: {
        launchServer: async ({ sessionId }: { sessionId: string }): Promise<BotToolServer> => {
          launched.push(sessionId)
          return {
            name: 'orca',
            url: URL,
            transport: 'http',
            headers: { authorization: `Bearer ${TOKEN}` }
          }
        },
        endSession: async () => {}
      }
    }
  }
}

function toolsFor(agent: string, enabled = true): Promise<BotLaunchTools> {
  return withCodemodeTools(BotLaunchTools.none, codemode(enabled).launch, {
    agent,
    sessionId: 's1',
    root: '/work',
    env: {},
    mode: () => 'ask'
  })
}

const basis = { instructions: async () => null, readOnly: null }

describe('code mode in a structured launch', () => {
  it('gives Claude an orca server that names the token variable, with the token in its env', async () => {
    const tools = await toolsFor('claude')
    const options = await claudeBotSessionOptions(basis, [], tools, { mcpConfig: false })
    expect(options.mcpServers).toEqual({
      orca: {
        type: 'http',
        url: URL,
        headers: { authorization: `Bearer \${${CODEMODE_TOKEN_ENV}}` }
      }
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
      'mcp_servers.orca.http_headers': { authorization: `Bearer ${TOKEN}` }
    })
    expect(withBotLaunchToolsEnv({}, tools)[CODEMODE_TOKEN_ENV]).toBeUndefined()
    expect(tools.commandEnv).toEqual({})
  })

  it("adds orca to Pi's tool config, naming the token variable", async () => {
    const tools = await toolsFor('pi')
    expect(JSON.parse(piBotToolsConfig(tools) ?? '{}')).toEqual({
      orca: { url: URL, headers: { authorization: `Bearer \${${CODEMODE_TOKEN_ENV}}` } }
    })
    expect(withBotLaunchToolsEnv({}, tools)[CODEMODE_TOKEN_ENV]).toBe(TOKEN)
    expect(PI_BOT_TOOLS_ENV).toBe('ORCA_PI_BOT_TOOLS')
  })

  it('adds nothing and opens no code-mode session when the setting is off', async () => {
    const off = codemode(false)
    const tools = await withCodemodeTools(BotLaunchTools.none, off.launch, {
      agent: 'claude',
      sessionId: 's1',
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

  it('gives an ACP agent orca only when it says it takes MCP over HTTP', async () => {
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
    expect(withHttp).toEqual([
      {
        type: 'http',
        name: 'orca',
        url: URL,
        headers: [{ name: 'authorization', value: `Bearer ${TOKEN}` }]
      }
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
