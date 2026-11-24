# Code Mode Part B (connectors) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remote MCP servers ("connectors") added once by URL, signed in with OAuth or a pasted token, usable in every code-mode chat both inside `run_js` (`mcp.<connector>.<tool>()`) and as direct agent tools, with a per-chat on/off switch.

**Architecture:** Connector metadata lives in `~/.orca/codemode-connectors.json`; secrets reuse the bot tool credential store and OAuth flow under one fixed credential folder key, so sign-in, refresh, revoke and sealing are the existing, tested code. A main-process `ConnectorPool` keeps one upstream MCP client per connector for all chats; `CodemodeMcpPool` delegates connector names to it. Agents reach connectors directly through a new `/c/<connectorId>/mcp` route on the existing bot tool relay, authorized by the chat's code-mode token.

**Tech Stack:** TypeScript, Electron main, `@modelcontextprotocol/sdk` 1.32.1 (`Client`, `StreamableHTTPClientTransport`), existing bot tool OAuth/credential/relay modules, React renderer, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-codemode-design.md` §7 (connectors), §4.1 trust, §10.1 connector tests, §10.2 scenario 6, §12. Part A plan and rulings: `docs/superpowers/plans/2026-11-24-codemode-part-a.md`.

## Decisions this plan makes (beyond the spec)

- **Secrets:** the spec says "Orca's existing credential store". Concretely: `src/main/bots/bot-tool-credentials.ts` with `folder = CODEMODE_CONNECTOR_CREDENTIAL_FOLDER` and `credentialId = connector.id`. OAuth uses `BotToolOAuthKey { folder, credentialId }` with the existing `connectBotToolSignIn`, `botToolAccessToken`, `refreshBotToolAccessToken`, `signOutBotTool`. No new secret storage.
- **No move of the OAuth code:** spec §7 said to move `src/main/bots/tool-oauth/` to `src/main/mcp-auth/`. Connectors use it in place through the folder key instead; moving upstream files would create merge conflicts on every upstream sync for no behaviour gain.
- **List file:** `~/.orca/codemode-connectors.json` (beside Orca's other `~/.orca` credential files) instead of Electron userData; written with `writeSecureJsonFile`.
- **Direct access:** a second route on `BotToolRelay`, not a new proxy. The token is the chat's code-mode token (`CodemodeTokens`), the same one the `orca` server uses.
- **Per-chat switch:** stored on the session record's `options` map under key `codemode.connectorsOff` (comma-separated connector ids), read live on every call. A connector switched off mid-chat is refused immediately in `run_js` and on the relay; direct tools stay listed by the agent until the next launch.
- **UI wording:** Orca's Bots area already uses "Connectors" for Slack/GitHub/etc. The settings page is titled "Code mode" and the list "MCP connectors".
- **Trust for local servers:** spec §4.1/§12 asks for per-server trust. Part B adds it: setting `codemodeTrustedServers: string[]` (local server names) plus `trusted` on each connector.
- **Catalog:** no bundled catalog; add by URL or search the official MCP Registry.

## Global Constraints

- Code mode, and therefore connectors, stays Electron-only (gate in `src/main/runtime/agent-session/launch/structured-agent-setting-gates.ts`) and only applies when `codemodeEnabled === true`.
- Secrets never appear in `codemode-connectors.json`, logs, RPC results, or agent configs. The relay attaches them; agents only ever hold the chat's code-mode token.
- Connector names: `/^[a-z][a-z0-9_-]{0,39}$/`, unique, not one of `orca`, `list`, `describe`, `call`. Ids: `newBotToolCredentialId()` (base64url, 16 chars).
- Name clash: a connector wins over `.orca/mcp.json` and `.mcp.json` servers of the same name (spec §7).
- 401 from a connector → exactly one refresh and one retry; still refused → error text `connector <name> needs sign-in`.
- Connector auth kinds: `oauth` | `token` | `none`. Token connectors send `Authorization: Bearer <token>`.
- Registry: `GET https://registry.modelcontextprotocol.io/v0.1/servers?version=latest&limit=<1..100>&search=<q>&cursor=<c>`, 15 s timeout, keep only remotes with `type === 'streamable-http'` and an `https://` URL; no headers → `oauth`; exactly one header named `Authorization` (case-insensitive) with `isSecret` → `token`; anything else skipped; dedupe by URL.
- English strings only (Part A Ruling R13). Follow `docs/STYLEGUIDE.md` and existing primitives for UI.
- Repo rules (`AGENTS.md`): no vague file names, minimal comments, files ≤ 300 lines (lint ratchet), `pnpm check:changed` passes at the end, `ORCA_BACKGROUND_LAUNCH=1` for any app run. No live agent logins in tests.
- Branch `codemode/part-b` off `fork`; Conventional Commits; no `Co-Authored-By` trailer.

## Review Focus

1. A connector whose refresh token was revoked mid-chat must fail calls with `connector <name> needs sign-in` in both paths, never hang or loop — Task 4 and Task 6 tests.
2. A connector named like a local server (or `orca`, `list`) — reserved names rejected at add; a local clash resolves to the connector — Task 1 and Task 5 tests.
3. Chat A's token must never reach a connector that chat A switched off, even if chat B has it on — Task 6 test.
4. An upstream redirect (to `http://` or another host) must not be followed with the bearer attached — Task 4 test.
5. Removing a connector while a script is calling it fails that call cleanly, closes the upstream client and revokes the sign-in — Task 3 and Task 4 tests.

---

### Task 1: Connector store

**Files:**

- Create: `src/main/codemode/connectors/codemode-connector-store.ts`, `src/shared/codemode/codemode-connector-types.ts`
- Test: `src/main/codemode/connectors/codemode-connector-store.test.ts`

**Interfaces:**

- Produces (shared types): `type CodemodeConnectorAuth = 'oauth' | 'token' | 'none'`; `type CodemodeConnector = { id: string; name: string; url: string; auth: CodemodeConnectorAuth; trusted: boolean; enabled: boolean }`; `CODEMODE_CONNECTOR_NAME = /^[a-z][a-z0-9_-]{0,39}$/`; `CODEMODE_RESERVED_NAMES = ['orca', 'list', 'describe', 'call']`.
- Produces (main): `CODEMODE_CONNECTOR_CREDENTIAL_FOLDER = join(homedir(), '.orca', 'codemode-connectors')` (a key for the credential store, never created as a directory); `class CodemodeConnectorStore { constructor(path?: string); list(): CodemodeConnector[]; get(id): CodemodeConnector | null; byName(name): CodemodeConnector | null; add(input: { name: string; url: string; auth: CodemodeConnectorAuth }): CodemodeConnector; update(id, patch: Partial<Pick<CodemodeConnector, 'name' | 'trusted' | 'enabled'>>): CodemodeConnector; remove(id): CodemodeConnector | null; onChange(listener: () => void): () => void }`. Default path `~/.orca/codemode-connectors.json`; file shape `{ version: 1, connectors: CodemodeConnector[] }`.

`add` validates the name rule, reserved names, uniqueness (`name taken: <name>`), `https://` URL (allow `http://127.0.0.1`/`http://localhost` only when `process.env.NODE_ENV === 'test'`), and sets `trusted: false`, `enabled: true`. A corrupt file reads as an empty list and is not overwritten until the next successful write (keep the bad file as `<path>.corrupt`).

- [ ] **Step 1: Failing tests:** round trip through a temp path; name rule cases (`Fcu` rejected, `fcu` ok, `orca` rejected, 41 chars rejected, duplicate rejected); `update` rename re-validates; `remove` returns the removed entry; the written JSON has exactly the keys of `CodemodeConnector` per entry (no `token`, `headers`, `secret`); corrupt file → `list()` is `[]` and `<path>.corrupt` exists after the next `add`; `onChange` fires on add/update/remove.
- [ ] **Step 2:** Run `pnpm test src/main/codemode/connectors --maxWorkers=2` — FAIL. **Step 3:** Implement with `writeSecureJsonFile` (`src/shared/secure-storage/secure-file.ts`). **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(codemode): connector store`.

### Task 2: Fake OAuth MCP server fixture

**Files:**

- Create: `src/main/bots/tool-oauth/testing/fake-oauth-mcp-server.ts`
- Modify: `src/main/bots/tool-oauth/bot-tool-oauth.test.ts` (use the extracted fixture; assertions unchanged)

**Interfaces:**

- Produces: `class FakeOAuthMcpServer { static start(opts?: { requireAuth?: boolean; tokenTtlSeconds?: number }): Promise<FakeOAuthMcpServer>; readonly base: string; readonly mcpUrl: string /* `${base}/mcp` */; approve(authorizeUrl: string): Promise<void> /* follows the authorize URL, auto-approves, calls the redirect */; expireAccessTokens(): void; revokeAll(): void; redirectMcpTo(url: string | null): void; counts(): { tokenRequests: number; refreshes: number; mcpSessions: number; calls: number }; setTools(names: string[]): void /* sends tools/list_changed */; stop(): Promise<void> }`. MCP tools: `echo({ text })` → text, `whoami()` → `structuredContent { user: 'fake' }`, `count()` → calls so far.

Move the fake authorization server class that `bot-tool-oauth.test.ts` defines (127.0.0.1 server: protected-resource metadata, authorization-server metadata, `/register`, `/authorize`, `/token`) into the fixture unchanged, then add `/mcp` with `McpServer` + `StreamableHTTPServerTransport` requiring `Authorization: Bearer <valid access token>` when `requireAuth` (default true), answering 401 otherwise. `redirectMcpTo` makes `/mcp` answer 302 to the given URL.

- [ ] **Step 1:** Extract; run `pnpm test src/main/bots/tool-oauth --maxWorkers=2` — PASS (unchanged behaviour).
- [ ] **Step 2:** Add a fixture self-test in `fake-oauth-mcp-server.test.ts`: register + authorize + token exchange yields a token that lists the 3 tools through the SDK `Client`; `expireAccessTokens` makes the next call 401; `revokeAll` makes refresh fail with `invalid_grant`.
- [ ] **Step 3:** Run — PASS. **Step 4:** Commit `test(bots): reusable fake OAuth MCP server`.

### Task 3: Connector auth and lifecycle

**Files:**

- Create: `src/main/codemode/connectors/codemode-connector-auth.ts`
- Test: `src/main/codemode/connectors/codemode-connector-auth.test.ts`

**Interfaces:**

- Consumes: Task 1 store, Task 2 fixture; `discoverBotToolAuth`, `connectBotToolSignIn`, `botToolSignInProgress`, `cancelBotToolSignIn`, `botToolSignInState`, `signOutBotTool`, `changeBotToolCredentials`, `readBotToolCredential`, `readBotToolOAuth`, `setBotToolSignInBrowser`, `newBotToolCredentialId`; the signed-out OAuth entry creation used by `addSortedBotTool` (`src/main/bots/bot-tool-owned-sign-in.ts:46`).
- Produces: `type ConnectorStatus = 'connected' | 'sign-in-needed' | 'token-needed' | 'error'`; `class CodemodeConnectorAuth { constructor(store: CodemodeConnectorStore); add(input: { url: string; name?: string }): Promise<CodemodeConnector>; setToken(id: string, token: string): void; startSignIn(id): Promise<{ attemptId: string; authorizationOrigin: string }>; signInProgress(id): BotToolSignInProgress; cancelSignIn(id, attemptId?): void; status(id): ConnectorStatus; remove(id): Promise<void>; key(id): BotToolOAuthKey }`.

`add`: default name = sanitized host label (e.g. `mcp.linear.app` → `linear`, de-duplicated with `-2`); discovery `oauth` → OAuth connector with a signed-out entry; `none` → `auth: 'none'`; `unsupported` → `auth: 'token'` (status `token-needed`); `unavailable` → throw `could not reach <url>`. `setToken` stores header `authorization: Bearer <token>` for that id. `remove` signs out (revokes tokens), forgets the credential, closes nothing itself (Task 4 listens to `store.onChange`), removes the store entry.

- [ ] **Step 1: Failing tests** (fake server, test browser hook calling `fixture.approve(url)`): add → `auth: 'oauth'`, status `sign-in-needed`; `startSignIn` + progress → `done`, status `connected`; `requireAuth: false` server → `auth: 'none'`, status `connected`; token connector: status `token-needed` → `setToken` → `connected`; `connectors.json` never contains the access token or the pasted token (grep the file text); `remove` → fixture saw a revocation, `readBotToolOAuth(folder, id)` is null, store entry gone.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(codemode): add, sign in and remove connectors`.

### Task 4: Connector pool (shared upstream clients)

**Files:**

- Create: `src/main/codemode/connectors/codemode-connector-pool.ts`, `src/main/codemode/connectors/codemode-connector-fetch.ts`
- Test: `src/main/codemode/connectors/codemode-connector-pool.test.ts`

**Interfaces:**

- Consumes: Task 1, Task 3 (`auth.key(id)`), `botToolAccessToken`, `refreshBotToolAccessToken`, `readBotToolCredential`; `renderMcpContent` (`src/main/codemode/mcp-pool/codemode-mcp-content.ts`).
- Produces: `class CodemodeConnectorPool { constructor(store, auth); describe(id: string, signal?: AbortSignal): Promise<CodemodeToolInfo[]>; call(id: string, tool: string, args: unknown, signal: AbortSignal): Promise<{ text: string; structured?: unknown }>; close(id: string): Promise<void>; closeAll(): Promise<void>; sessionCount(id): number /* test-visible */ }`. `connectorFetch(id, auth): typeof fetch` in `codemode-connector-fetch.ts` adds the current bearer (OAuth access token, or saved header, or nothing), uses `redirect: 'manual'` and turns any 3xx into an error `connector <name> redirected; refusing to follow`, and on 401 refreshes once (`refreshBotToolAccessToken(key, rejected)`) and retries once; a second 401 or a null refresh throws `connector <name> needs sign-in`.

One `Client` + `StreamableHTTPClientTransport({ fetch: connectorFetch })` per connector id, created lazily and shared by every caller; concurrent first calls share one connect promise; tool list cached and dropped on `notifications/tools/list_changed`; a dropped transport reconnects once per call before failing. `store.onChange` closes clients of removed, disabled or renamed connectors. `isError` results reject with the rendered text (same contract as `CodemodeMcpPool.call`, Ruling R10 for `structuredContent`).

- [ ] **Step 1: Failing tests** (fake server): two callers → `fixture.counts().mcpSessions === 1`; `expireAccessTokens()` → next call succeeds and `refreshes === 1`; `revokeAll()` + expire → rejects `connector <name> needs sign-in` within 2 s; `redirectMcpTo('http://127.0.0.1:1/x')` → rejects with the redirect message and the redirect target saw no request; `setTools(['echo'])` → next `describe` returns only `echo`; removing the connector from the store while a call is in flight → call rejects, `sessionCount` 0; `whoami` returns `structured: { user: 'fake' }`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(codemode): shared upstream pool for connectors`.

### Task 5: Connectors inside run_js, trust, per-chat switch

**Files:**

- Modify: `src/main/codemode/mcp-pool/codemode-mcp-pool.ts` (delegate connector names), `src/main/codemode/host/codemode-run-host.ts` (session options), `src/main/codemode/codemode-service.ts` (wire store/pool, trust, per-chat off set), `src/main/codemode/server/codemode-tool-description.ts` (list connectors), `src/shared/codemode/codemode-settings.ts` (`codemodeTrustedServers?: string[]`)
- Create: `src/main/codemode/connectors/codemode-connector-session-switch.ts`
- Test: `src/main/codemode/connectors/codemode-connector-session-switch.test.ts`, additions in `codemode-mcp-pool.test.ts`, `codemode-run-host.test.ts`

**Interfaces:**

- Produces: `type CodemodeConnectorAccess = { names(): string[]; describe(name, signal?): Promise<CodemodeToolInfo[]>; call(name, tool, args, signal): Promise<{ text: string; structured?: unknown }> }` (resolved by name, filtered by global `enabled` and the chat's off set); `CodemodeMcpPool` ctor option `connectors?: CodemodeConnectorAccess`; `CodemodeSessionOptions.connectors?: CodemodeConnectorAccess`; `readConnectorsOff(record): Set<string>`, `writeConnectorsOff(options, ids): Record<string, string>` for key `codemode.connectorsOff`; `CodemodeService.setConnectorOff(sessionId, connectorId, off: boolean): Promise<void>` and `connectorsForSession(sessionId): { connector: CodemodeConnector; on: boolean; status: ConnectorStatus }[]`.

Pool: connector names come first in `names()`/`list()`, a local server with the same name is hidden, connectors need no start approval. `trusted(server)`: connector → `connector.trusted`; local → `settings.codemodeTrustedServers` includes the name. Tool description's server list includes connector names. A switched-off connector behaves as unknown in `run_js` (`unknown MCP server <name>`).

- [ ] **Step 1: Failing tests:** switch helpers round-trip ids and ignore empty/garbage values; pool with a fake `CodemodeConnectorAccess` named `crm` plus local `crm` → calls go to the connector, local server never starts; run host (ask mode): untrusted connector call asks, trusted connector call does not, local server in `codemodeTrustedServers` does not; with a real fixture connector a `run_js` script `return await mcp.fake.echo({ text: 'hi' })` returns `hi`; after `setConnectorOff` the same script fails with `unknown MCP server fake`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(codemode): connectors in run_js with trust and per-chat switch`.

### Task 6: Relay route for direct agent access

**Files:**

- Modify: `src/main/bots/tool-relay/bot-tool-relay.ts` (second route family), `src/main/bots/tool-relay/bot-tool-relay-admission.ts` (caller key instead of botId)
- Create: `src/main/codemode/connectors/codemode-connector-relay-route.ts`
- Test: `src/main/codemode/connectors/codemode-connector-relay-route.test.ts`

**Interfaces:**

- Produces: `BotToolRelay.addRoute(route: RelayRoute): () => void` where `type RelayRoute = { pattern: RegExp /* captures the target id */; resolve(token: string): { callerKey: string; folder: string } | null; allow(callerKey: string, targetId: string): RelayAllowance }` and `type RelayAllowance = { ok: true } | { ok: false; status: 403 | 404; message: string }`; the existing `/bot-tools/` route becomes the first registered route with unchanged behaviour. `createConnectorRelayRoute(service): RelayRoute` with pattern `/^\/c\/([A-Za-z0-9_-]{8,64})\/mcp(?:\?.*)?$/`, `resolve` via `CodemodeTokens.resolve` → `callerKey = 'codemode:' + sessionId`, `folder = CODEMODE_CONNECTOR_CREDENTIAL_FOLDER`, `allow` → 404 `unknown connector` for unknown/disabled ids, 403 `connector <name> is off for this chat` when off for that session. `CodemodeService.relayOrigin(): Promise<string>` starts/gets the relay origin.

Session tokens never work on `/bot-tools/` and bot tokens never work on `/c/`. Upstream forwarding, mcp-session-id mapping, 401 refresh-once, sign-in-needed JSON-RPC answers are the existing relay code paths with `{ folder, credentialId: connectorId }`.

- [ ] **Step 1: Failing tests** (real relay + fake server + real `CodemodeService` session): SDK client with the session token lists the fixture's tools through `/c/<id>/mcp`; a bot token on `/c/` → 401; the session token on `/bot-tools/...` → 401; chat A off / chat B on → A's request 403 with the message, B's succeeds; disabled connector → 404; expired upstream token → client call still succeeds (one refresh); revoked → JSON-RPC error `-32001`; existing `bot-tool-relay.test.ts` passes unchanged.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS (plus `pnpm test src/main/bots/tool-relay --maxWorkers=2`).
- [ ] **Step 5:** Commit `feat(codemode): relay route for direct connector access`.

### Task 7: Inject connectors into chats

**Files:**

- Modify: `src/main/codemode/codemode-service.ts` (`launchServer` → returns the `orca` server plus one entry per connector that is enabled and on for the session), `src/main/runtime/agent-session/launch/structured-agent-codemode-launch.ts`, `src/main/bots/bot-launch-tools.ts` (`withExtraServers` accepts several extra servers; same env-reference token handling as `orca`)
- Test: additions in `src/main/runtime/agent-session/launch/structured-agent-codemode-launch.test.ts`, `src/main/codemode/codemode-service.test.ts`

**Interfaces:**

- Produces: `CodemodeService.launchServer(input): Promise<BotToolServer[] | null>` (first entry is `orca`); each connector entry `{ name: connector.name, url: \`${relayOrigin}/c/${id}/mcp\`, transport: 'http', headers: { authorization: <same token form as orca> } }`.

- [ ] **Step 1: Failing tests:** with code mode on and connector `fake` enabled: Claude `mcpServers`, Codex thread config, Pi config and an HTTP-capable ACP agent each contain `fake` pointing at `/c/<id>/mcp` with the code-mode token form; connector switched off for the session or globally disabled → absent; code mode off → no `orca`, no connectors; a bot server named `fake` is replaced by the connector (connector wins).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(codemode): give chats their connectors as direct tools`.

### Task 8: Registry search

**Files:**

- Create: `src/main/codemode/connectors/codemode-registry-search.ts`
- Test: `src/main/codemode/connectors/codemode-registry-search.test.ts`

**Interfaces:**

- Produces: `type RegistryEntry = { name: string; title: string; description: string; url: string; auth: 'oauth' | 'token'; iconUrl?: string }`; `parseRegistryPage(json: unknown): { entries: RegistryEntry[]; nextCursor?: string }`; `searchRegistry(query: string, opts?: { cursor?: string; limit?: number; fetch?: typeof fetch; signal?: AbortSignal }): Promise<{ entries: RegistryEntry[]; nextCursor?: string }>`.

- [ ] **Step 1: Failing tests** for `parseRegistryPage` with this fixture (from the user's harness) and expectations: keeps `app.linear/linear` (`https://mcp.linear.app/mcp`, `oauth`); drops `io.github.x/broker` (sse); drops `io.github.y/paid` (non-Authorization header); keeps `ai.smithery/notion` as `token` with `iconUrl` `https://s.example/i.svg`; drops `io.local/stdio` (no remotes); drops `app.linear/linear-dup` (same URL); unknown fields ignored; malformed JSON → `entries: []`. `searchRegistry` with a stub fetch: builds `version=latest&limit=20&search=lin` (+ `cursor` when given), clamps limit to 1..100, 15 s timeout, non-2xx → throws `MCP Registry answered <status>`.

```json
{
  "servers": [
    {
      "server": {
        "name": "app.linear/linear",
        "title": "Linear",
        "description": "Issues",
        "remotes": [{ "type": "streamable-http", "url": "https://mcp.linear.app/mcp" }]
      },
      "_meta": {}
    },
    {
      "server": {
        "name": "io.github.x/broker",
        "remotes": [{ "type": "sse", "url": "https://x.example/sse" }]
      }
    },
    {
      "server": {
        "name": "io.github.y/paid",
        "remotes": [
          {
            "type": "streamable-http",
            "url": "https://y.example/mcp",
            "headers": [{ "name": "payment-signature" }]
          }
        ]
      }
    },
    {
      "server": {
        "name": "ai.smithery/notion",
        "description": "N",
        "remotes": [
          {
            "type": "streamable-http",
            "url": "https://s.example/notion/mcp",
            "headers": [{ "name": "Authorization", "isSecret": true, "value": "Bearer {k}" }]
          }
        ],
        "icons": [{ "src": "https://s.example/i.svg" }]
      }
    },
    { "server": { "name": "io.local/stdio", "packages": [{ "registryType": "npm" }] } },
    {
      "server": {
        "name": "app.linear/linear-dup",
        "remotes": [{ "type": "streamable-http", "url": "https://mcp.linear.app/mcp" }]
      }
    }
  ],
  "metadata": { "nextCursor": "abc" }
}
```

- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement (zod parsing; `title` falls back to the part of `name` after `/`). **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(codemode): search the MCP Registry for connectors`.

### Task 9: RPC methods

**Files:**

- Create: `src/main/runtime/rpc/methods/codemode/codemode-connectors.ts`, `src/shared/rpc-contract/codemode/codemode-connectors-params.ts`
- Modify: the RPC method registry and the generated params catalog (`config/scripts/generate-rpc-params-catalog.mjs` → `src/shared/rpc-contract/rpc-params-catalog.generated.ts`)

**Interfaces:**

- Produces (copy the `bots.tools.*` pattern in `src/main/runtime/rpc/methods/bots-tools.ts` for permission, params and errors): `codemode.connectors.list` → `{ connectors: (CodemodeConnector & { status: ConnectorStatus })[] }`; `.add { url, name? }`; `.update { id, name?, trusted?, enabled? }`; `.remove { id }`; `.setToken { id, token }`; `.signIn.start { id }` → `{ attemptId, authorizationOrigin }`; `.signIn.status { id }` → progress; `.signIn.cancel { id, attemptId? }`; `.registry.search { query, cursor? }`; `codemode.connectors.session.list { sessionId }` → `{ connectors: { id, name, on, status }[] }`; `.session.toggle { sessionId, id, on }`. Session methods use the same session-access checks as `agentSession.mcp`. No method returns a token or header value.

- [ ] **Step 1:** Implement, regenerate the catalog, `pnpm tc:node`.
- [ ] **Step 2:** Add one test `codemode-connectors.test.ts` asserting no method result contains the fixture's access token or a pasted token string after add + sign-in + setToken (serialize every result and search it).
- [ ] **Step 3:** Run — PASS. **Step 4:** Commit `feat(codemode): connector RPC methods`.

### Task 10: Settings page "Code mode"

**Files:**

- Create: `src/renderer/src/components/settings/codemode/CodemodeSettingsPage.tsx`, `CodemodeConnectorList.tsx`, `CodemodeConnectorRow.tsx`, `AddCodemodeConnectorDialog.tsx`, `CodemodeTrustedServersSetting.tsx`, `codemode-connectors-client.ts`, `codemode-settings-search.ts`, `CodemodeSettingsPage.fixture.tsx`
- Modify: `src/renderer/src/components/settings/navigation/settings-navigation-types.ts` (`SETTINGS_NAV_TARGETS`), a `settings-navigation-*-sections.ts` builder (new section id `code-mode`, desktop-only like the toggle), `src/renderer/src/components/settings/page/settings-page-renderer.tsx`, `src/renderer/src/i18n/locales/en.json`

**Interfaces:**

- Consumes: Task 9 RPC methods; existing `CodemodeEnabledSetting` (rendered at the top of the page too; it stays in Chat settings).

Page content: the code mode switch; "MCP connectors" list (name, URL host, status chip, Trusted switch, Enabled switch, actions Sign in / Set token / Remove); "Add connector" dialog with two tabs, "URL" (URL + optional name) and "Search registry" (debounced search, results with title, description, auth badge, Add); "Trusted local servers" (editable list of names). Sign-in polls `signIn.status` every 2 s up to 10 min like `bot-tools-client.ts`. Reuse `BotToolEditor` pieces only where they don't need a `BotRef`.

- [ ] **Step 1:** Implement; `pnpm tc:web`.
- [ ] **Step 2:** Fixture states: empty, three connectors (connected / sign-in-needed / token-needed), add dialog URL tab, add dialog registry tab with results. `pnpm fixtures:shot <id>` each, light and dark; look at the images.
- [ ] **Step 3:** Commit `feat(codemode): settings page with MCP connectors`.

### Task 11: Per-chat switches in the native chat MCP tray

**Files:**

- Create: `src/renderer/src/components/native-chat/mcp/NativeChatCodemodeConnectors.tsx`, `use-codemode-session-connectors.ts`
- Modify: `src/renderer/src/components/native-chat/mcp/NativeChatMcpTray.tsx` (render the section when the chat has code mode), `NativeChatMcpTray.fixture.tsx`

Section "Code mode connectors": one row per connector with name, status and an on/off switch calling `codemode.connectors.session.toggle`; caption "Off stops use in this chat now; the agent's direct tool list updates next launch."

- [ ] **Step 1:** Implement; `pnpm tc:web`. **Step 2:** Fixture with two connectors (one off); screenshot and look. **Step 3:** Commit `feat(codemode): per-chat connector switches in the MCP tray`.

### Task 12: Proof

**Files:**

- Create: `src/main/codemode/connectors/codemode-connectors-end-to-end.test.ts`

Headless, real pieces: `CodemodeService` with a temp connector store, the fake OAuth MCP server added through `CodemodeConnectorAuth.add`, signed in through the test browser hook, a code-mode session launched through the service, the SDK `Client` acting as the agent.

- [ ] **Step 1: Tests:** `run_js` `return await mcp.fake.echo({ text: 'ok' })` → `ok`; the same session's direct entry from `launchServer` lists and calls `echo` through the relay; two sessions using the connector → `mcpSessions === 1` upstream for the `run_js` path; `expireAccessTokens()` mid-test → both paths still succeed; `setConnectorOff(session, id, true)` → `run_js` fails `unknown MCP server fake` and the relay answers 403; `remove` → both paths fail and the fixture saw a revocation.
- [ ] **Step 2:** Run — PASS.
- [ ] **Step 3:** `ORCA_CODE_QUALITY_BASE=$(git merge-base fork HEAD) pnpm check:changed` — Expected: no failures.
- [ ] **Step 4:** Commit `test(codemode): end-to-end proof for connectors`.
