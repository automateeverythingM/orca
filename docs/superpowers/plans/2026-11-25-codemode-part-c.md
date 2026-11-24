# Code Mode Part C (`orca.*`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scripts in `run_js` can call Orca's own runtime actions as `orca.<area>.<method>(params)`, discover them lazily with `orca.areas()` / `orca.describe(...)`, and every call passes the permission gate with a read / write / destructive label.

**Architecture:** An index built at runtime from `ALL_RPC_METHODS` (the live method registry: name, permission, zod params, stream flag) applies an exposure policy and a label to each method. The sandbox gets a chained `orca` Proxy over four host tools; the run host plans each call through the gate and executes it through an in-process `RpcDispatcher` as a local agent caller attached to the chat's session id.

**Tech Stack:** TypeScript, Electron main, zod 4 (`z.toJSONSchema`), Orca runtime RPC (`RpcDispatcher`, `defineMethod`), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-codemode-design.md` §6.1 and the `orca.*` rows of §4.1. Earlier parts: `docs/superpowers/plans/2026-11-24-codemode-part-a.md`, `…-part-b.md`.

## Decisions this plan makes (beyond the spec)

- **Runtime index instead of a build-time generated file:** spec §6.1 says "generated at build time". The live registry `ALL_RPC_METHODS` already carries name, permission, schema and stream flag, so the index is computed once at first use. A generated file would add churn on every upstream merge that adds a method. The spec's guarantee ("every exposed method has a label", "excluded names are refused") becomes a test over the real registry.
- **Exposure policy (deny by rule, then label):** a method is exposed only if ALL hold:
  1. `permission === 'workspace'` (excludes accounts-admin, settings-write, skills-admin, pairing-admin, host-admin, device-self, desktop-control);
  2. not a streaming method;
  3. name does not match `/(auth|token|credential|secret|password|apikey|api-key|oauth|signin|signout|login|logout|pairing|cookie)/i`;
  4. area not in `['codemode', 'accounts', 'orcaAccount', 'pairing', 'pairedServerAsks', 'mobileRelay', 'settings', 'plugins', 'skills', 'updater', 'managedRuntime', 'orcad']`;
  5. not in the explicit denylist `CODEMODE_ORCA_DENIED_METHODS` covering anything that answers or changes the chat's own approvals or permission mode (every `agentSession.*` method whose name contains `respond`, `answer`, `approv`, `permission` or `setOption`), plus `webhooks.secret` and `browser.setCredentials` (already caught by rule 3, listed for clarity).
- **Labels:** an explicit override table first, then the last name segment's verb. Read verbs: `list, get, show, status, read, search, find, describe, current, info, details, diff, log, preview, stats, query, resolve, count, exists, peek, inspect, capture, snapshot, view`. Destructive words anywhere in the last segment: `remove, delete, kill, close, destroy, discard, reset, prune, clean, archive, revoke, uninstall, forget, drop, wipe, purge, terminate, force`. Everything else is `write`. Overrides reuse existing classifications where they exist (`READ_ORCHESTRATION_METHODS` in `src/main/bots/bot-look-around-policy.ts` → read; `ORCHESTRATION_MUTATION_METHODS` → write unless the verb is destructive).
- **Destructive approvals are never remembered:** "Allow for this session" on a destructive call counts as allow-once (spec: destructive always asks).
- **Caller identity:** dispatch as `caller: { kind: 'local-cli' }` (agent caller), owner scope, placeholder `authToken: 'codemode'`, and `orchestrationCompatibilityEvidence: { agentSessionId: sessionId }` so session-aware methods know which chat is calling. `orca.context()` returns `{ sessionId, root, worktreeId?, workspaceId? }` so scripts can pass ids to methods that take them.

## Global Constraints

- Spec §4.1 `orca.*` rows: read → allow in every mode including read-only; write → ask in `ask`/`own`, allow in `accept-edits`/`auto`/`full-access`, refuse in read-only; destructive → ask in every non-read-only mode (including `full-access`), refuse in read-only.
- Methods never exposed: credentials, tokens, account and sign-in methods; settings holding secrets; code mode's own methods (`codemode.*`, including `codemode.connectors.*`); anything that answers or changes the chat's own approvals/permissions. A test fails if any exposed name matches the rule-3 regex.
- `orca.describe(target)` accepts an area (`"worktree"`) or a full method name (`"worktree.create"`); returns `{ method, label, params }[]` with `params` = `z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12', unrepresentable: 'any' })` or `null`.
- Results and errors follow Part A host-call rules: JSON-cloneable values, 4 MiB per result, errors as `{ ok: false, error: <message> }`; inner calls show in the run view as `orca.<method>`.
- Code mode stays Electron-only and gated on `codemodeEnabled === true`; nothing changes when off.
- Personal fork: no edits to upstream RPC method files; all new code under `src/main/codemode/`, plus the minimal wiring line(s) where the runtime is available.
- Repo rules: `AGENTS.md`; files ≤ 300 lines (`codemode-service.ts` is already over in raw lines — extract before adding); no `as` casts; no new sync fs in main; `pnpm check:changed` passes at the end. Commits: Conventional Commits, no `Co-Authored-By`.

## Review Focus

1. A script calling a method that would approve its own pending approval card or switch its own chat to full access must be refused (not exposed) — Task 1 test.
2. A method with no params (`params: null`) called with `undefined`, `{}` or extra fields — must behave like the CLI (null schema accepts no params) — Task 4 test.
3. A destructive call answered "Allow for this session" must still ask next time — Task 3 test.
4. A streaming method name typed by hand (`orca.terminal.subscribe(...)`) must fail with `not available in code mode`, not hang — Task 4 test.
5. `orca.describe('browser')` (≈127 methods with schemas) must not crash the sandbox — Task 2 test asserts it serializes to valid JSON; oversized results are already refused by Part A's 4 MiB per-result limit with a clear error.

---

### Task 1: Method index and exposure policy

**Files:**

- Create: `src/main/codemode/orca/codemode-orca-method-policy.ts`, `src/main/codemode/orca/codemode-orca-method-index.ts`
- Test: `src/main/codemode/orca/codemode-orca-method-index.test.ts`

**Interfaces:**

- Produces: `type OrcaMethodLabel = 'read' | 'write' | 'destructive'`; `type OrcaMethodSource = { name: string; permission: string; params: ZodType | null; stream?: boolean }`; `CODEMODE_ORCA_DENIED_METHODS: ReadonlySet<string>`; `isExposedOrcaMethod(m: OrcaMethodSource): boolean`; `labelOrcaMethod(name: string): OrcaMethodLabel`; `type OrcaMethodEntry = { name: string; area: string; label: OrcaMethodLabel; params: ZodType | null }`; `class OrcaMethodIndex { static from(methods: readonly OrcaMethodSource[]): OrcaMethodIndex; areas(): string[]; inArea(area: string): OrcaMethodEntry[]; get(name: string): OrcaMethodEntry | null }`.

- [ ] **Step 1: Failing tests** — against the real registry (`ALL_RPC_METHODS` from `src/main/runtime/rpc/methods/rpc-method-registry.ts`; if importing it in Vitest is impractical, say why and use a recorded list of `{name, permission, stream}` regenerated by a small script — prefer the real import):
  - no exposed name matches the rule-3 regex; no exposed method is streaming or non-`workspace`; no exposed method's area is in the excluded-areas list; no exposed name is in `CODEMODE_ORCA_DENIED_METHODS`; no exposed `agentSession.*` name contains `respond|answer|approv|permission|setOption`;
  - every exposed method has a label; `labelOrcaMethod`: `worktree.list` read, `worktree.create` write, `worktree.remove` destructive, `repo.remove` destructive, `terminal.kill` destructive if it exists (else pick the real terminal close/kill name and assert destructive), `git.status` read, `files.read` read, `orchestration.runList` read;
  - `codemode.connectors.setToken`, `codemode.connectors.add`, `webhooks.secret`, `browser.setCredentials`, `accounts.*`, `settings.*`, `bots.tools.signIn.start` are not exposed;
  - `OrcaMethodIndex.areas()` is sorted and unique; `get('worktree.create')` returns its entry; `inArea('nope')` is `[]`;
  - log (not assert) the exposed count and per-label counts.
- [ ] **Step 2:** Run `pnpm test src/main/codemode/orca --maxWorkers=2` — FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(codemode): index Orca's RPC methods for scripts`.

### Task 2: Describe with JSON Schema

**Files:**

- Create: `src/main/codemode/orca/codemode-orca-describe.ts`
- Test: `src/main/codemode/orca/codemode-orca-describe.test.ts`

**Interfaces:**

- Consumes: `OrcaMethodIndex` (Task 1).
- Produces: `describeOrca(index: OrcaMethodIndex, target: string): { method: string; label: OrcaMethodLabel; params: unknown }[]` — area or full method name; unknown → throws `unknown Orca area or method: <target>`; schemas converted with the Global Constraints options and cached per method; a schema that fails conversion yields `params: { description: 'schema unavailable' }` instead of throwing.

- [ ] **Step 1: Failing tests:** `describeOrca(real index, 'worktree')` returns only `worktree.*` entries with labels and object-typed `params` or `null`; `'worktree.create'` returns exactly one entry; unknown target throws the exact message; calling twice returns the same params object (cached); `describeOrca(index, 'browser')` serializes with `JSON.stringify` without throwing and is a valid array.
- [ ] **Step 2:** RUN FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(codemode): describe Orca methods with JSON Schema`.

### Task 3: Gate rows and approvals for `orca.*`

**Files:**

- Modify: `src/main/codemode/gate/codemode-gate.ts`, `src/main/codemode/gate/codemode-gate.test.ts`, `src/main/codemode/host/codemode-approvals.ts` (+ its test or the run-host test)

**Interfaces:**

- Produces: `GateCall` gains `{ kind: 'orca'; label: OrcaMethodLabel }`; `decideGate` implements the Global Constraints `orca.*` rows; `GateCheck.allowKey` may be `null`, meaning "never remember" — `CodemodeApprovals.check` treats `allow_session` as `allow_once` when `allowKey === null`.

- [ ] **Step 1: Failing tests:** extend the hardcoded gate matrix with the three orca rows × all six modes exactly as Global Constraints; approvals: a check with `allowKey: null` answered `allow_session` asks again on the next identical check; a check with `allowKey: 'orca:worktree.create'` answered `allow_session` does not.
- [ ] **Step 2:** RUN FAIL. **Step 3:** Implement. **Step 4:** PASS (whole `src/main/codemode` suite still green).
- [ ] **Step 5:** Commit `feat(codemode): gate Orca method calls by label`.

### Task 4: `orca` in the sandbox and the run host

**Files:**

- Modify: `src/main/codemode/sandbox/codemode-prelude.ts`, `src/main/codemode/sandbox/codemode-script-runner.ts` (`HOST_TOOLS`), `src/main/codemode/host/codemode-host-dispatch.ts`, `src/main/codemode/host/codemode-run-host.ts` (`CodemodeSessionOptions`)
- Create: `src/main/codemode/orca/codemode-orca-dispatch.ts`
- Test: `src/main/codemode/orca/codemode-orca-dispatch.test.ts`, additions in `src/main/codemode/sandbox/codemode-script-runner.test.ts`

**Interfaces:**

- Consumes: Tasks 1–3.
- Produces:
  - Host tools `orca.areas` (input none → `string[]`), `orca.describe` (`{ target }`), `orca.call` (`{ method, params }`), `orca.context` (none → context object).
  - Prelude: global `orca` — `orca.areas()`, `orca.describe(target)`, `orca.context()`, `orca.call(method, params)`, and a chained Proxy so `orca.worktree.create(p)` and `orca.bots.tools.list(p)` call `orca.call('worktree.create', p)` / `'bots.tools.list'`. `areas`, `describe`, `context`, `call` are reserved at the top level only.
  - `type OrcaRpcAccess = { index(): OrcaMethodIndex; call(method: string, params: unknown, signal: AbortSignal): Promise<unknown>; context(): { sessionId: string; root: string; worktreeId?: string; workspaceId?: string } }`; `CodemodeSessionOptions.orca?: OrcaRpcAccess` (absent → `orca.*` host calls fail with `Orca actions are not available in this chat`).
  - `createOrcaRpcAccess(deps: { methods: readonly OrcaMethodSource[]; dispatch: (request: { id: string; authToken: string; method: string; params: unknown; orchestrationCompatibilityEvidence?: { agentSessionId: string } }, options: { caller: { kind: 'local-cli' }; signal: AbortSignal }) => Promise<{ ok: boolean; result?: unknown; error?: { message: string } }>; sessionId: string; root: string; context?: () => { worktreeId?: string; workspaceId?: string } }): OrcaRpcAccess` in `codemode-orca-dispatch.ts` — refuses names not in the index with `<name> is not available in code mode`, validates params with the method's zod schema before dispatch (null schema: accepts `undefined`/`null`/`{}` and sends `undefined`; anything else → `<name> takes no params`), maps the dispatcher's error response to a thrown `Error(message)`. Check the real `RpcDispatcher.dispatch` request/response types and match them exactly.
  - Dispatch plan for `orca.call`: gate `{ kind: 'orca', label }`, `allowKey` = `orca:<method>` for read/write and `null` for destructive, prompt title `Orca: <method>` and detail = JSON params (trimmed to 2 KB). `orca.areas`/`describe`/`context` are reads with allowKey `read`. Inner-call label `orca.<method>`.

- [ ] **Step 1: Failing tests** (fake `dispatch` capturing requests + a methods array built from a few `defineMethod`-shaped objects including one streaming, one null-params, one destructive):
  - script `return await orca.worktree.list({})` → dispatch called with `method: 'worktree.list'`, `caller.kind: 'local-cli'`, `orchestrationCompatibilityEvidence.agentSessionId` = the session id; result returned;
  - `orca.bots.tools.list()` chains to `bots.tools.list`;
  - unknown/excluded name → `x.y is not available in code mode` and no dispatch; streaming name → same message;
  - invalid params → zod message, no dispatch; null-schema method with `{}` → dispatched with `undefined`; with `{a:1}` → `<name> takes no params`;
  - dispatcher error response → script catches `Error` with that message;
  - ask mode: write method asks once and `allow_session` covers the next call; destructive method asks every time even after `allow_session`; full-access: write runs without asking, destructive still asks; read-only: read runs, write refused;
  - `orca.context()` returns sessionId and root;
  - no `orca` access configured → the exact unavailable message.
- [ ] **Step 2:** RUN FAIL. **Step 3:** Implement. **Step 4:** PASS (`pnpm test src/main/codemode --maxWorkers=2`).
- [ ] **Step 5:** Commit `feat(codemode): orca.* in scripts`.

### Task 5: Wire the real runtime

**Files:**

- Create: `src/main/codemode/orca/codemode-orca-runtime-wiring.ts`
- Modify: `src/main/codemode/codemode-service.ts` (extract connector wiring first if needed to stay within limits), `src/main/codemode/server/codemode-tool-description.ts`, the composition point that creates the process `CodemodeService` (`structured-agent-session-host-assembly.ts:~55`) or wherever the runtime/`RpcDispatcher` is reachable (see `src/main/core-desktop/desktop-core-composition.ts:~164` and `src/main/plugins/runtime/plugin-runtime-rpc.ts` for how in-process dispatchers are built)

**Interfaces:**

- Consumes: Task 4 `createOrcaRpcAccess`.
- Produces: `CodemodeServiceOptions.orcaRpc?: { methods: readonly OrcaMethodSource[]; dispatch: … }` (same shapes as Task 4); each launched session gets `orca` access built with its sessionId, root, and a `context` that reads the live session record's location (worktree/workspace id) if available. Tool description adds one line: `orca.areas(), orca.describe(area or method), orca.<area>.<method>(params) for Orca's own actions; orca.context() for this chat's ids.` — still ≤ ~150 words with 3 servers.

- [ ] **Step 1: Failing tests:** service-level test (real `CodemodeService`, real HTTP server, SDK client as agent) with injected `orcaRpc` (fake dispatch + small methods list): `return await orca.worktree.list({})` returns the fake result and the dispatch saw the chat's session id; description contains `orca.areas()` and stays within the word budget; with no `orcaRpc` the script gets the unavailable message.
- [ ] **Step 2:** RUN FAIL. **Step 3:** Implement, including production wiring with the real `ALL_RPC_METHODS` and a real `RpcDispatcher` over the runtime (owner scope, `local-cli` caller). **Step 4:** PASS; `pnpm tc:node`.
- [ ] **Step 5:** Commit `feat(codemode): connect orca.* to Orca's runtime`.

### Task 6: Proof

**Files:**

- Create: `src/main/codemode/orca/codemode-orca-end-to-end.test.ts`

- [ ] **Step 1: Tests:** with the REAL `RpcDispatcher` and real `ALL_RPC_METHODS` over the lightest runtime stand-in the dispatcher accepts (find how existing dispatcher tests construct a runtime; reuse that), through a real `CodemodeService` session: `orca.areas()` includes `worktree` and excludes `codemode`, `accounts`, `settings`; `orca.describe('worktree.create')` has a JSON-Schema `params`; a read method that works on the stand-in runtime returns data (pick one whose handler needs the least runtime, e.g. a status/list method — state which); `orca.codemode.connectors.list()` → not available; a destructive method in full-access mode produces an approval request (approver stub records it and denies → script sees `denied by user`).
- [ ] **Step 2:** PASS.
- [ ] **Step 3:** `ORCA_CODE_QUALITY_BASE=$(git merge-base fork HEAD) pnpm check:changed` — no failures.
- [ ] **Step 4:** Commit `test(codemode): end-to-end proof for orca.*`.
