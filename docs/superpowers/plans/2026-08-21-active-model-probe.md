# 主动模型可用性检测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `PROXY_ROUTING_ENABLED=false` 下也能由用户主动拉取站点模型、按正则筛选、以每站点指定的 chat/messages/responses 接口和 User-Agent 发起真实嗅探，并持久化最新结果供筛选排序展示。

**Architecture:** 扩展现有 `runtimeModelProbe()` 作为单模型探测内核；新增只读发现层、配置层与主动运行编排层；复用现有 Sites 页 SSE 探测交互，并新增跨站点聚合页面。结果采用站点级语义，每个 `(site_id, model_name)` 只保存最新一次，绝不依赖 `token_routes` / `route_channels`。

**Tech Stack:** TypeScript ESM、Fastify 5、Drizzle ORM（SQLite/MySQL/Postgres）、Zod、React 18、React Router 7、Vitest。

**Spec:** `docs/plans/2026-08-21-active-model-probe.md`

## Global Constraints

- `PROXY_ROUTING_ENABLED=false` 时 preview/run/results 仍必须完整可用，不启动、不读取、不写入路由维护表。
- 用户显式选择 `chat` / `messages` / `responses` 时只探测该端点，不允许跨协议回退；`auto` 才使用现有候选推导与回退。
- 每站点 `probeUserAgent` 非空时覆盖全局 UA；否则使用全局 UA；均为空时不主动设置 UA。
- 所有真实探测前必须先支持 preview；空正则列表匹配 0 个模型；超过 50 个目标要求二次确认。
- 2xx 响应不能仅凭状态码判可用；必须读取响应体、拒绝错误体和空内容。
- 上游整包响应必须使用 `readRuntimeResponseText()`，禁止直接 `.text()`。
- `inconclusive` 代表网络、认证、限流或超时等非确定失败，不得自动禁用模型。
- Routes 只做 Zod 解析与 service 委派；协议请求/响应判定不得放入 route。
- Schema 改动必须同步 Drizzle schema、SQLite migration、generated contract artifacts；禁止手写 MySQL/Postgres schema patch。
- 新增站点字段和结果表必须同步 backup/export、restore、database migration 与 Postgres sequence reset。
- Web 页面之间禁止互相 import；移动端复用 `ResponsiveFilterPanel`、`MobileCard`、`useIsMobile`。
- 默认并发 1、单次超时 15000ms；测试词使用 `crypto.randomInt()` 随机选择。

---

## File Structure Map

### New server files

- `src/server/services/modelProbeResponseClassifier.ts` — 解析 chat/messages/responses 响应体并给出 supported/unsupported/failureKind；协议纯判定，无 DB/Fastify。
- `src/server/services/modelInterestFilter.ts` — 正则编译、ReDoS 防护和模型匹配。
- `src/server/services/modelProbeConfigService.ts` — 从 settings 读取/保存全局主动探测配置并归一化默认值。
- `src/server/services/modelProbeDiscoveryService.ts` — 只读选择站点主探测账号、实时 `getModels()`、代理与超时；preview/run 共用，不写 availability/health/routing。
- `src/server/services/modelProbeRunService.ts` — 跨站点 preview、队列任务、并发探测、结果 upsert、任务日志。
- `src/server/contracts/modelProbePayloads.ts` — config/site/preview/run/results 的 Zod 契约。
- `src/server/routes/api/modelProbe.ts` — 薄 Fastify 路由。

### New web files

- `src/web/pages/ModelProbe.tsx` — 页面编排与数据加载。
- `src/web/pages/modelProbe/ModelProbeConfigPanel.tsx` — 全局正则、测试词、UA、关键词、并发、超时。
- `src/web/pages/modelProbe/ModelProbeSitesPanel.tsx` — 每站点 endpoint/UA 配置。
- `src/web/pages/modelProbe/ModelProbeRunPanel.tsx` — preview、二次确认、运行进度与日志。
- `src/web/pages/modelProbe/ModelProbeResultsPanel.tsx` — 桌面表格、移动卡片、筛选排序。
- `src/web/pages/modelProbe/modelProbeTypes.ts` — 页面内部类型；不能被别的 top-level page 导入。

### Existing files that must change

- Probe core: `src/server/services/runtimeModelProbe.ts`, `src/server/services/runtimeModelProbe.test.ts`.
- Existing site probe: `src/server/services/modelService.ts`, focused tests around `probeSiteModels`; `src/server/routes/api/sites.ts`; `src/web/pages/Sites.tsx`.
- Schema: `src/server/db/schema.ts`, `drizzle/0027_*.sql`, `drizzle/meta/*`, `src/server/db/generated/*`.
- Site contracts/UI propagation: `src/server/contracts/siteRoutePayloads.ts`, `src/server/routes/api/sites.ts`, `src/web/pages/helpers/sitesEditor.ts`, tests.
- Persistence portability: `src/server/services/backupService.ts`, `src/server/services/databaseMigrationService.ts`, their tests.
- API registration/client/navigation: `src/server/index.ts`, `src/web/api.ts`, `src/web/App.tsx`.

---

## Phase 1 — Probe correctness (independently shippable)

### Task 1: Protocol-aware response classifier

**Files:**
- Create: `src/server/services/modelProbeResponseClassifier.ts`
- Create: `src/server/services/modelProbeResponseClassifier.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ModelProbeFailureKind =
    | 'model_missing' | 'error_body' | 'empty_content'
    | 'timeout' | 'network' | 'auth' | 'rate_limit' | 'upstream';
  export type ModelProbeResponseClassification = {
    status: 'supported' | 'unsupported' | 'inconclusive';
    failureKind: ModelProbeFailureKind | null;
    reason: string;
  };
  export function classifySuccessfulProbeResponse(input: {
    endpoint: 'chat' | 'messages' | 'responses';
    rawBody: string;
    errorKeywords?: string[];
  }): ModelProbeResponseClassification;
  ```

- [ ] **Step 1: Write failing classifier tests**

Cover exact payloads:

```ts
expect(classifySuccessfulProbeResponse({
  endpoint: 'chat',
  rawBody: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
})).toMatchObject({ status: 'supported', failureKind: null });

expect(classifySuccessfulProbeResponse({
  endpoint: 'messages',
  rawBody: JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }),
})).toMatchObject({ status: 'supported' });

expect(classifySuccessfulProbeResponse({
  endpoint: 'responses',
  rawBody: JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }),
})).toMatchObject({ status: 'supported' });

expect(classifySuccessfulProbeResponse({
  endpoint: 'chat',
  rawBody: JSON.stringify({ error: { message: 'no available channel' } }),
  errorKeywords: ['no available channel'],
})).toMatchObject({ status: 'unsupported', failureKind: 'error_body' });

expect(classifySuccessfulProbeResponse({
  endpoint: 'chat',
  rawBody: JSON.stringify({ choices: [{ message: { content: '' } }] }),
})).toMatchObject({ status: 'inconclusive', failureKind: 'empty_content' });
```

Also assert malformed/HTML body is inconclusive/empty_content unless it matches a configured error keyword; a top-level `message` matching an error keyword is unsupported/error_body; normal answer text containing a generic word not in the configured keyword list remains supported.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npx vitest run --root . src/server/services/modelProbeResponseClassifier.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement minimal protocol-aware extraction**

Implementation rules:
- Parse JSON once; malformed/non-protocol body returns `inconclusive/empty_content` with reason `invalid or non-JSON probe response`, unless a configured error keyword matches it.
- Reject top-level `error` object/string before extracting content.
- Chat extraction: concatenate `choices[*].message.content` strings; support content arrays with `{text}`.
- Messages extraction: concatenate `content[*].text` where type is text-like.
- Responses extraction: concatenate `output_text` and nested `output[*].content[*].text`.
- Compare configured keywords case-insensitively against the raw body.
- Cap persisted/displayed reason at 1000 UTF-16 code units.

- [ ] **Step 4: Run test and verify pass**

Run: same command.
Expected: all classifier tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/modelProbeResponseClassifier.ts src/server/services/modelProbeResponseClassifier.test.ts
git commit -m "fix: classify successful model probe response bodies"
```

### Task 2: Extend `probeRuntimeModel()` without breaking callers

**Files:**
- Modify: `src/server/services/runtimeModelProbe.ts`
- Modify: `src/server/services/runtimeModelProbe.test.ts`

**Interfaces:**
- Consumes classifier from Task 1.
- Produces:
  ```ts
  export type RuntimeModelProbeResult = {
    status: RuntimeModelProbeStatus;
    latencyMs: number | null;
    reason: string;
    httpStatus: number | null;
    failureKind: ModelProbeFailureKind | null;
    endpointUsed: UpstreamEndpoint | null;
  };
  export type RuntimeModelProbeOptions = {
    prompt?: string;
    userAgent?: string;
    forcedEndpoint?: UpstreamEndpoint;
    errorKeywords?: string[];
  };
  ```
  Add those optional fields directly to the existing `probeRuntimeModel(input)` object type.

- [ ] **Step 1: Add failing tests for six result branches**

Extend existing mocks so `dispatchRuntimeRequestMock` returns real `Response` objects. Add tests for:
- chat 200 + non-empty content → supported, endpointUsed chat, httpStatus 200;
- 200 + error body → unsupported/error_body;
- 200 + empty/unparseable content → inconclusive/empty_content;
- 404 `no such model` → unsupported/model_missing;
- 401 → inconclusive/auth;
- 429 → inconclusive/rate_limit;
- thrown/aborted request → inconclusive timeout or network.

Mock `readRuntimeResponseText` only if needed; prefer exercising the real helper with `Response`.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run --root . src/server/services/runtimeModelProbe.test.ts`
Expected: FAIL on missing metadata and 2xx body classification.

- [ ] **Step 3: Implement request/result changes**

Exact behavior:
- Track the successful/failed endpoint using `buildRequest` and `onAttemptSuccess`; do not infer from URL strings.
- Use `readRuntimeResponseText(result.upstream)` in the 2xx path.
- Build `openaiBody` with `input.prompt?.trim() || 'Reply with OK.'`.
- Build `downstreamHeaders` as `{ 'user-agent': input.userAgent.trim() }` only when non-empty; pass the same object to both endpoint resolution/build request.
- If `forcedEndpoint` exists, set `endpointCandidates = [forcedEndpoint]`; otherwise resolve normally. A one-item candidate array is verified by `endpointFlow.ts:115` loop and cannot cross-protocol fallback.
- Keep `inconclusive` for empty/unparseable 2xx bodies, 401/403, 429, 5xx, timeout/network. Only definite model absence and explicit 2xx error bodies/keywords are unsupported.
- Ensure every early return supplies the new metadata fields.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run --root . src/server/services/runtimeModelProbe.test.ts src/server/services/modelAvailabilityProbeService.test.ts`
Expected: PASS; existing caller behavior remains compatible.

- [ ] **Step 5: Run architecture drift check**

Run: `npm run repo:drift-check`
Expected: zero violations; whole-body read now follows the mandated helper.

- [ ] **Step 6: Commit**

```bash
git add src/server/services/runtimeModelProbe.ts src/server/services/runtimeModelProbe.test.ts
git commit -m "feat: expose endpoint metadata in runtime model probes"
```

---

## Phase 2 — Configuration and site-specific request shape

### Task 3: Regex interest filter and safe random prompt selection

**Files:**
- Create: `src/server/services/modelInterestFilter.ts`
- Create: `src/server/services/modelInterestFilter.test.ts`
- Create: `src/server/services/modelProbePrompts.ts`
- Create: `src/server/services/modelProbePrompts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MODEL_PROBE_MAX_PATTERN_COUNT = 50;
  export const MODEL_PROBE_MAX_PATTERN_LENGTH = 200;
  export function compileInterestPatterns(raw: unknown): {
    patterns: RegExp[];
    invalid: Array<{ source: string; reason: string }>;
  };
  export function matchesInterest(modelName: string, patterns: RegExp[]): boolean;
  export function chooseModelProbePrompt(prompts: string[], randomInt?: (max: number) => number): string;
  ```

- [ ] **Step 1: Write failing tests**

Assert:
- empty pattern list matches no model;
- `/opus-(4\\.(8|9)|[5-9])|opus-([5-9]|[1-9]\\d)/i` examples match expected names;
- `glm-5\\.([2-9]|[1-9]\\d)` matches 5.2+ but not 5.1;
- malformed `[` is returned in `invalid` without throwing;
- overlong and >50 entries are invalid;
- deterministic injected `randomInt` selects each prompt; empty/blank prompt list falls back to `Reply with a single short word.`.

- [ ] **Step 2: Run and verify failure**

Run both new test files; expect missing modules.

- [ ] **Step 3: Implement minimal helpers**

Use case-insensitive `RegExp`. Trim/dedupe prompts. Default random function is `(max) => randomInt(max)` from `node:crypto`.

- [ ] **Step 4: Run and verify pass**

Run: `npx vitest run --root . src/server/services/modelInterestFilter.test.ts src/server/services/modelProbePrompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/modelInterestFilter* src/server/services/modelProbePrompts*
git commit -m "feat: add safe model interest filtering"
```

### Task 4: Persist and validate global probe configuration

**Files:**
- Create: `src/server/services/modelProbeConfigService.ts`
- Create: `src/server/services/modelProbeConfigService.test.ts`
- Create: `src/server/contracts/modelProbePayloads.ts`
- Create: `src/server/contracts/modelProbePayloads.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ModelProbeUserAgentPreset = { id: string; label: string; value: string };
  export type ModelProbeConfig = {
    interestPatterns: string[];
    prompts: string[];
    userAgents: ModelProbeUserAgentPreset[];
    defaultUserAgentId: string;
    errorKeywords: string[];
    concurrency: number;
    timeoutMs: number;
    syncToRouting: boolean;
  };
  export const MODEL_PROBE_CONFIG_SETTING_KEY = 'model_probe_config_v1';
  export function getDefaultModelProbeConfig(): ModelProbeConfig;
  export function normalizeModelProbeConfig(input: unknown): ModelProbeConfig;
  export async function loadModelProbeConfig(): Promise<ModelProbeConfig>;
  export async function saveModelProbeConfig(input: unknown): Promise<ModelProbeConfig>;
  export function resolveModelProbeUserAgent(config: ModelProbeConfig, siteOverride?: string | null): string;
  ```

- [ ] **Step 1: Write failing normalization/service tests**

Assert default config exactly:
- patterns `[]`;
- six non-trivial prompts from spec;
- presets include stable IDs `claude-code`, `codex-cli`, `custom`;
- concurrency 1 (clamp 1..8), timeout 15000 (clamp 3000..60000);
- syncToRouting false;
- invalid regex causes `saveModelProbeConfig()` to reject with a message naming the pattern;
- duplicate preset IDs are normalized/deduped;
- site UA override wins over selected global preset.

Use a test SQLite database and assert a single JSON settings row is upserted under `model_probe_config_v1`.

- [ ] **Step 2: Run and verify failure**

Run the two new test files; expect missing modules.

- [ ] **Step 3: Implement config service and Zod contracts**

`modelProbePayloads.ts` exports parse functions for config, site config, preview/run/results query. Do not embed persistence in contracts. `saveModelProbeConfig` calls `compileInterestPatterns` and rejects any invalid pattern.

- [ ] **Step 4: Run and verify pass**

Run both focused files.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/modelProbeConfigService* src/server/contracts/modelProbePayloads*
git commit -m "feat: persist active model probe configuration"
```

### Task 5: Add per-site endpoint and User-Agent fields end-to-end

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/contracts/siteRoutePayloads.ts`
- Modify: `src/server/routes/api/sites.ts`
- Modify: `src/web/pages/helpers/sitesEditor.ts`
- Modify tests: `src/server/contracts/siteRoutePayloads.test.ts`, closest sites route tests, `src/web/pages/helpers/sitesEditor.test.ts`
- Generated later in Task 9 with the result table, to keep one schema migration.

**Interfaces:**
- Adds to sites row/API/form:
  ```ts
  probeEndpointType: 'auto' | 'chat' | 'messages' | 'responses';
  probeUserAgent: string;
  ```

- [ ] **Step 1: Write failing contract and editor tests**

Assert create/update accepts four endpoint values, rejects `response` (singular) and arbitrary strings, trims UA to max 512 chars, and `siteFormFromSite` / `buildSiteSaveAction` round-trip the values.

- [ ] **Step 2: Run and verify failure**

Run focused contract/editor tests.

- [ ] **Step 3: Add schema fields and payload propagation**

- `sites.probeEndpointType` default `auto`, not null.
- `sites.probeUserAgent` default empty string, not null.
- Add typed fields to `siteCreatePayloadSchema` / `siteUpdatePayloadSchema` rather than relying on `.passthrough()`.
- In `sites.ts` normalize once and persist on create/update.
- Extend `SiteForm` and `SiteSavePayload` in `sitesEditor.ts`.

- [ ] **Step 4: Run focused tests**

Expected: PASS (schema artifacts are intentionally deferred to Task 9).

- [ ] **Step 5: Commit**

```bash
git add src/server/db/schema.ts src/server/contracts/siteRoutePayloads* src/server/routes/api/sites.ts src/web/pages/helpers/sitesEditor*
git commit -m "feat: store per-site model probe request profiles"
```

---

## Phase 3 — Discovery, orchestration, schema, API, portability

### Task 6: Read-only model discovery for preview/run

**Files:**
- Create: `src/server/services/modelProbeDiscoveryService.ts`
- Create: `src/server/services/modelProbeDiscoveryService.test.ts`
- Optional small refactor: export/reuse normalization from `src/server/services/modelService.ts` only if it does not broaden coupling.

**Interfaces:**
- Produces:
  ```ts
  export type ModelProbeDiscoveryTarget = {
    site: typeof schema.sites.$inferSelect;
    account: typeof schema.accounts.$inferSelect;
    credential: string;
    models: string[];
    source: 'live' | 'cached';
  };
  export async function discoverModelsForActiveProbe(input: {
    siteId: number;
    timeoutMs: number;
  }): Promise<ModelProbeDiscoveryTarget>;
  ```

- [ ] **Step 1: Write failing discovery tests**

Mock adapter, DB and proxy helpers. Assert:
- deterministically selects active account by `isPinned desc, sortOrder asc, id asc` with usable `apiToken`, then falls back to `accessToken`/managed ready token;
- calls `requireSiteApiBaseUrl(site)` and `adapter.getModels(baseUrl, credential, platformUserId)` inside `withAccountProxyOverride(resolveChannelProxyUrl(...))`;
- trims/dedupes model names case-insensitively;
- live empty result falls back to cached `model_availability` for that account with source cached;
- no credential / no models returns explicit error;
- no writes occur (spy on DB insert/update/delete).

- [ ] **Step 2: Run and verify failure**

Run the new test; expect missing module.

- [ ] **Step 3: Implement read-only discovery**

Do not call `refreshModelsForAccount()` because it writes availability, health, post-refresh probes, and routes. Keep OAuth-specific cloud discovery out of scope for v1 unless the selected adapter returns no models; report that limitation explicitly.

- [ ] **Step 4: Run and verify pass**

Run focused test.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/modelProbeDiscoveryService*
git commit -m "feat: add read-only model discovery for active probes"
```

### Task 7: Refactor existing site probe onto safe shared semantics

**Files:**
- Modify: `src/server/services/modelService.ts:384-510`
- Modify/add focused tests for `probeSiteModels`
- Modify: `src/server/routes/api/sites.ts:903-961` only if event metadata expands
- Modify: `src/web/pages/Sites.tsx:609-740,1731-1852`

**Interfaces:**
- `probeSiteModels()` consumes discovery/config/probe core and returns details including `httpStatus`, `failureKind`, `endpointUsed`.

- [ ] **Step 1: Write failing regression tests**

Assert:
- model list comes from `discoverModelsForActiveProbe`, not stale `model_availability`;
- interest regex filters before any runtime probe call;
- `inconclusive` does **not** insert into `site_disabled_models` and does not mark availability false;
- with `PROXY_ROUTING_ENABLED=false`, no `rebuildTokenRoutesFromAvailability`, no availability update, no account runtime health write;
- supported/unsupported still emit SSE model events with endpoint/failure metadata;
- site endpoint/UA overrides are passed to `probeRuntimeModel`.

- [ ] **Step 2: Run and verify failure**

Run the focused modelService/sites route tests; expect current stale-list and disabling behavior to fail.

- [ ] **Step 3: Extract or replace `probeSiteModels` implementation**

Keep its public signature/SSE route for `Sites.tsx`. Change behavior:
- scope `single` remains exact model; scope `all` means all **interest-matched** live models;
- do not auto-disable inconclusive;
- route writes/rebuild only when `config.proxyRoutingEnabled && config.syncToRouting`;
- return explicit `unsupported` count separately from inconclusive;
- use per-site endpoint/UA and global prompt/keywords.

- [ ] **Step 4: Update Sites UI request/result rendering**

Add endpoint type and UA fields in the existing “刷新后自动测试请求” card. Rename card to “模型主动探测”; keep automatic post-refresh toggle separate and default off. Show endpointUsed/failureKind in SSE log. Do not add a second site-probe UI.

- [ ] **Step 5: Run focused tests**

Run modelService probe tests, sites API probe tests, and Sites web tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/services/modelService.ts src/server/routes/api/sites.ts src/web/pages/Sites.tsx <focused-tests>
git commit -m "refactor: make site model probes routing-independent"
```

### Task 8: Active probe run service and preview

**Files:**
- Create: `src/server/services/modelProbeRunService.ts`
- Create: `src/server/services/modelProbeRunService.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ModelProbePreview = {
    sites: Array<{ siteId: number; siteName: string; source: 'live'|'cached'; models: string[] }>;
    totalModels: number;
    invalidPatterns: Array<{ source: string; reason: string }>;
  };
  export async function previewActiveModelProbe(input?: { siteIds?: number[] }): Promise<ModelProbePreview>;
  export function queueActiveModelProbe(input?: { siteIds?: number[] }): { task: BackgroundTask; reused: boolean };
  export async function listActiveModelProbeResults(query: ModelProbeResultsQuery): Promise<{ items: ModelProbeResultView[]; total: number }>;
  ```

- [ ] **Step 1: Write failing service tests**

Assert:
- preview invokes discovery + regex filter and never calls `probeRuntimeModel` nor DB writes;
- empty patterns return totalModels 0;
- queue uses dedupe key `active-model-probe:<sorted site ids|all>`;
- prompt is chosen per target; concurrency never exceeds configured number (deferred promises counter);
- each result upserts by siteId/modelName;
- `PROXY_ROUTING_ENABLED=false` produces no writes to model availability/routes;
- task logs contain discovery count, each model result, and final supported/unsupported/inconclusive summary;
- results query supports model text, siteId, status, sortBy latency/balance/checkedAt, order asc/desc, limit/offset.

- [ ] **Step 2: Run and verify failure**

Run new test; expect missing module.

- [ ] **Step 3: Implement orchestration**

Use `appendBackgroundTaskLog`; cap persisted reason at 1000 chars. Upsert helper must branch by dialect like `upsertSetting` or use Drizzle conflict APIs supported by project helpers. Never insert one history row per run.

- [ ] **Step 4: Run and verify pass**

Run focused service test.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/modelProbeRunService*
git commit -m "feat: orchestrate active model probe runs"
```

### Task 9: Schema migration and data portability

**Files:**
- Modify: `src/server/db/schema.ts`
- Generate: `drizzle/0027_*.sql`, `drizzle/meta/0027_snapshot.json`, `drizzle/meta/_journal.json`
- Regenerate: `src/server/db/generated/schemaContract.json`, `mysql.bootstrap.sql`, `mysql.upgrade.sql`, `postgres.bootstrap.sql`, `postgres.upgrade.sql`
- Modify: `src/server/services/backupService.ts`, `backupService.test.ts`
- Modify: `src/server/services/databaseMigrationService.ts`, `databaseMigrationService.test.ts`
- Modify schema tests if generated filenames/snapshots require it.

**Interfaces:**
- Final `model_probe_results` schema uses unique `(site_id, model_name)` and nullable accountId.

- [ ] **Step 1: Write failing portability tests**

Before generation, extend tests to require:
- backup snapshot/export/restore includes site `probeEndpointType`, `probeUserAgent` automatically through SiteRow and explicitly includes `modelProbeResults`;
- database migration snapshot/buildStatements/clearTargetData includes `model_probe_results`;
- Postgres sequence reset list includes `model_probe_results`;
- generated MySQL/Postgres upgrades contain two site columns, result table, unique/indexes.

- [ ] **Step 2: Run tests and verify failure**

Run backup/database migration/schema artifact focused tests.

- [ ] **Step 3: Finalize schema and generate artifacts**

Run:
```bash
npm run db:generate
npm run schema:contract
```
Verify the new migration number is 0027 and inspect generated SQL; do not hand-edit MySQL/Postgres SQL.

- [ ] **Step 4: Update backup and database migration services**

- Add result rows to snapshot types/export/restore/delete order.
- Add insert statement columns exactly matching schema.
- Add table to Postgres sequence reset.
- Preserve backward compatibility: old backup files without `modelProbeResults` restore as empty.

- [ ] **Step 5: Run schema and portability gates**

Run:
```bash
npm run test:schema:unit
npx vitest run --root . src/server/services/backupService.test.ts src/server/services/databaseMigrationService.test.ts
npm run repo:drift-check
```
Expected: PASS, zero drift violations.

- [ ] **Step 6: Commit**

```bash
git add src/server/db/schema.ts drizzle src/server/db/generated src/server/services/backupService* src/server/services/databaseMigrationService*
git commit -m "feat: persist active model probe profiles and results"
```

### Task 10: Thin API routes and registration

**Files:**
- Create: `src/server/routes/api/modelProbe.ts`
- Create: `src/server/routes/api/modelProbe.test.ts`
- Modify: `src/server/index.ts`
- Modify: `src/web/api.ts`

**Interfaces:**
- GET/PUT config, GET/PUT sites, POST preview/run, GET results exactly as spec.
- POST run accepts `{ siteIds?: number[], confirmedTargetCount?: number }`; if preview count >50 and confirmation count differs, return 409 with preview summary.

- [ ] **Step 1: Write failing route tests**

Mock services and assert:
- invalid bodies/queries return 400;
- bad regex config returns 400;
- unknown site returns 404;
- preview returns 200 and never queues;
- run returns 202 `{taskId,reused}`;
- >50 without matching confirmation returns 409;
- results query forwards normalized sort/filter values;
- all endpoints work when `config.proxyRoutingEnabled=false`.

- [ ] **Step 2: Run and verify failure**

Run route test; expect module missing.

- [ ] **Step 3: Implement routes, register, and add typed API client methods**

Register after `siteAnnouncementsRoutes` and before generic tasks. Add TypeScript types in `src/web/api.ts`; avoid `any` for new contracts.

- [ ] **Step 4: Run route/client typecheck**

```bash
npx vitest run --root . src/server/routes/api/modelProbe.test.ts
npm run typecheck:web
npm run typecheck:server
```

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/api/modelProbe* src/server/index.ts src/web/api.ts
git commit -m "feat: expose active model probe API"
```

---

## Phase 4 — Web UI

### Task 11: Page shell, navigation, and configuration/site panels

**Files:**
- Create: `src/web/pages/ModelProbe.tsx`
- Create: `src/web/pages/modelProbe/modelProbeTypes.ts`
- Create: `src/web/pages/modelProbe/ModelProbeConfigPanel.tsx`
- Create: `src/web/pages/modelProbe/ModelProbeSitesPanel.tsx`
- Create tests: `src/web/pages/modelProbe.config.test.tsx`, `modelProbe.mobile-layout.test.tsx`
- Modify: `src/web/App.tsx`

**Interfaces:**
- Route `/model-probe`, sidebar label `模型可用性` placed near `站点管理`/`Models`.

- [ ] **Step 1: Write failing web tests**

Assert:
- route is lazy-loaded and sidebar entry present;
- empty patterns show warning “未配置匹配规则，不会探测任何模型”;
- invalid regex is visibly marked before save;
- per-site endpoint options are exactly 自动/chat/messages/responses;
- per-site UA offers inherit global, Claude Code, Codex CLI, custom;
- mobile architecture uses shared primitives and no top-level page import.

- [ ] **Step 2: Run and verify failure**

Run focused web tests; expect missing page/components.

- [ ] **Step 3: Implement shell/config/site panels**

Use controlled forms, `ModernSelect`, toast feedback. Keep complex panels under `pages/modelProbe/` per AGENTS rule. Save global and per-site configs independently.

- [ ] **Step 4: Run focused tests and web typecheck**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/App.tsx src/web/pages/ModelProbe.tsx src/web/pages/modelProbe src/web/pages/modelProbe*.test.tsx
git commit -m "feat: add active model probe configuration UI"
```

### Task 12: Preview, run progress, and results UI

**Files:**
- Create: `src/web/pages/modelProbe/ModelProbeRunPanel.tsx`
- Create: `src/web/pages/modelProbe/ModelProbeResultsPanel.tsx`
- Create tests: `src/web/pages/modelProbe.run.test.tsx`, `modelProbe.results.test.tsx`
- Modify: `src/web/pages/ModelProbe.tsx`

**Interfaces:**
- Uses existing `api.getTask(taskId)` polling every 1s while pending/running; stops on terminal status or unmount. Task logs are already returned in `BackgroundTask.logs`, so no new SSE route is required for cross-site page.

- [ ] **Step 1: Write failing UI tests**

Assert:
- preview button shows site/model counts and no run call;
- count >50 opens confirmation modal and sends confirmedTargetCount only after explicit confirm;
- task polling displays appended logs and stops when succeeded/failed;
- result filters invoke API with model/site/status/sort/order;
- desktop table and mobile `MobileCard` show endpoint, latency, balance, reason and checkedAt;
- no polling after unmount.

- [ ] **Step 2: Run and verify failure**

Run the two tests; expect missing components.

- [ ] **Step 3: Implement run and result panels**

Reuse `ModelAvailabilityProbeConfirmModal` behavior by extracting a neutral confirmation component if direct import would create page coupling. Use `ResponsiveFilterPanel` and `MobileCard`; tables live in an overflow-x container.

- [ ] **Step 4: Run web test/typecheck gate**

```bash
npx vitest run --root . src/web/pages/modelProbe.run.test.tsx src/web/pages/modelProbe.results.test.tsx src/web/pages/modelProbe.mobile-layout.test.tsx
npm run typecheck:web
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/pages/ModelProbe.tsx src/web/pages/modelProbe src/web/pages/modelProbe*.test.tsx
git commit -m "feat: show active model probe progress and results"
```

---

## Task 13: End-to-end verification and deployment guard

**Files:**
- Modify only failures attributable to this feature; do not fold unrelated cleanup.

- [ ] **Step 1: Run focused feature suite**

```bash
npx vitest run --root . \
  src/server/services/modelProbeResponseClassifier.test.ts \
  src/server/services/runtimeModelProbe.test.ts \
  src/server/services/modelInterestFilter.test.ts \
  src/server/services/modelProbePrompts.test.ts \
  src/server/services/modelProbeConfigService.test.ts \
  src/server/services/modelProbeDiscoveryService.test.ts \
  src/server/services/modelProbeRunService.test.ts \
  src/server/routes/api/modelProbe.test.ts \
  src/web/pages/modelProbe.config.test.tsx \
  src/web/pages/modelProbe.run.test.tsx \
  src/web/pages/modelProbe.results.test.tsx
```
Expected: PASS.

- [ ] **Step 2: Run repository gates**

```bash
npm run typecheck
npm run test:schema:unit
npm run repo:drift-check
npm run build
npm test
```
Expected: all gates PASS. If the known Windows Vitest timeout/file-lock flake appears, rerun failing files individually and report both full-suite and isolated evidence; do not claim a clean full suite if it was not clean.

- [ ] **Step 3: Manual smoke test with routing disabled**

Start with:
```bash
PROXY_ROUTING_ENABLED=false DATA_DIR=./tmp/model-probe-smoke AUTH_TOKEN=test-admin-token npm start
```
Verify:
1. config save persists across restart;
2. one site forced to messages sends only `/v1/messages` with chosen UA and configured proxy;
3. preview lists only regex-matched models and makes no chat request;
4. run rejects 200 error body and accepts real non-empty response;
5. results sort by latency and balance;
6. no writes to `token_routes`, `route_channels`, `model_availability` while routing is disabled.

- [ ] **Step 4: Commit any test-only fixes**

```bash
git add <feature-related-files>
git commit -m "test: verify active model probes with routing disabled"
```

- [ ] **Step 5: Final review**

Invoke `superpowers:requesting-code-review`, address confirmed findings, rerun affected gates, then follow `superpowers:verification-before-completion` before claiming success or pushing.
