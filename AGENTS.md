# Metapi Engineering Rules

These rules apply to the whole repository unless a deeper `AGENTS.md` overrides
them. They are intentionally opinionated and mechanical so humans and agents can
make small, consistent changes without re-learning the codebase each time.

## Golden Principles

- Prefer one source of truth. If a helper, contract, or workflow already owns
  an invariant, extend it instead of creating a parallel implementation.
- Fix the family, not just the symptom. When a bug comes from a repeated
  pattern, sweep adjacent paths in the same subsystem before calling the work
  done.
- Keep changes narrow and reviewable. Land one coherent slice at a time and
  avoid bundling unrelated cleanup into the same patch.

## Server Layers

- `src/server/routes/**` are adapters, not owners. Route files may register
  Fastify endpoints, parse request context, and delegate. They must not own
  protocol conversion, retry policy, stream lifecycle, billing, or
  persistence.
- If a helper is imported by anything outside one route file, it does not
  belong under `src/server/routes/proxy/`.
- `src/server/proxy-core/**` owns proxy orchestration. Endpoint fallback should
  flow through `executeEndpointFlow()`. Channel/session bookkeeping should flow
  through `sharedSurface.ts`.
- `src/server/transformers/**` are protocol-pure. Do not import from
  `src/server/routes/**`, Fastify, OAuth services, token router, or runtime
  dispatch modules. If a transformer needs a shared contract, move it to a
  neutral module first.
- Whole-body upstream reads in proxy orchestration should use
  `readRuntimeResponseText()` instead of direct `.text()` reads.

## Platform And Routing Rules

- Platform behavior must be explicit. Detection, endpoint preference, discovery
  transport, and management capability should come from one declared capability
  story, not scattered `if platform === ...` branches.
- Thin adapters must stay honest. Do not let a platform look feature-complete
  through inherited defaults if the underlying upstream does not support the
  feature.
- Retry classification and routing health classification should share the same
  failure vocabulary whenever possible.

## Database Rules

- One schema change requires three synchronized outputs: update the Drizzle
  schema, update SQLite migration history, and regenerate checked-in schema
  artifacts together.
- Cross-dialect bootstrap and upgrade SQL must be generated from the schema
  contract. Do not hand-write new MySQL/Postgres schema patches in feature
  code.
- Legacy schema compatibility is temporary and spec-owned. Additive startup
  shims should stay narrow and trace back to a feature compatibility spec.
- Migration files under `drizzle/` are hand-maintained with semantic names
  (`0028_model_probe_results.sql`), not drizzle-kit's generated word pairs. The
  `drizzle/meta/` snapshots are incomplete, so `db:generate` can decide an
  already-landed migration is unlanded and regenerate it under a colliding
  index. Always read what it produced before keeping it.
- `schemaContract.ts` replays every `.sql` file it finds in the migrations
  folder and never consults `_journal.json`. Deleting a journal entry therefore
  does not retire a migration — the file has to go too, or it keeps executing
  and the next `schema:generate` fails on an already-existing object.
- Generated upgrade SQL is additive-only, enforced by
  `assertAdditiveSchemaDiff`: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN`,
  `CREATE INDEX`. Dropping or redefining an existing index is not expressible,
  so widening a table's unique key means introducing a new table rather than
  altering the old one.
- Adding a table is not finished when the schema compiles. Backup
  export/parse/wipe/restore, `databaseMigrationService`'s ordered table lists
  and its explicitly-enumerated-column insert, and that service's test table
  gate all need the new table by name. The insert and the backup table set fail
  SILENTLY when a table or column is missed — nothing throws, data just stops
  arriving.

## Web Rules

- Pages are orchestration surfaces, not shared utility libraries. Do not import
  one top-level page from another top-level page.
- Mobile behavior should reuse existing shared primitives first:
  `ResponsiveFilterPanel`, `ResponsiveBatchActionBar`, `MobileCard`,
  `useIsMobile`, and `mobileLayout.ts`.
- When a page grows a second complex modal, drawer, or panel family, extract it
  into a domain subfolder before adding more inline state and rendering logic.

## Guardrails

- Run `npm run repo:drift-check` before finishing changes that touch shared
  architecture boundaries.
- If you add a new boundary-heavy module, add or extend an architecture test in
  the same area so the rule becomes executable.
- Keep local planning files under `docs/plans/`. They are intentionally ignored
  by git and should not be treated as published documentation.

---

# 项目交接（Handoff）

> 以下为 metapi 代码库的详尽交接说明，供接手的人 / agent 快速掌握全局。上文英文章节是**规则约束**；本节补充"是什么、怎么跑、架构大图景、配置与坑"。规则与交接如有冲突，以上文规则为准。

## 一、项目概览

- **定位**：metapi（v1.3.0，MIT）是面向 AI API 的**元聚合网关**——"中转站的中转站"。把用户在多个上游中转站（New API / One API / OneHub / DoneHub / Veloera / AnyRouter / Sub2API 等）以及官方预设、OAuth（Codex / Claude / Gemini CLI / Antigravity）上分散注册的账号，聚合成**单一入口 + 单一下游 API Key**，让下游工具（Cursor / Claude Code / Codex / Open WebUI）无感接入全部模型。
- **核心能力**：统一代理入口；智能路由（按成本 / 余额 / 使用率 / 概率选路）；自动故障转移；自动模型发现；自动签到领额度；集中看板 / 监控。
- **技术栈**：TypeScript（ESM，`"type": "module"`）。一仓三端：
  - **Server** `src/server`：Fastify 5 + Drizzle ORM（SQLite / MySQL / Postgres 三方言）+ Zod + undici + node-cron
  - **Web** `src/web`：React 18 + React Router 7 + Vite 6 + Tailwind 4 + VChart
  - **Desktop** `src/desktop`：Electron 42（包裹 server + web）
  - 另有独立 update-helper 进程（`start:deploy-helper`）用于自更新 / 部署
- **文档站**：`docs/`（VitePress），在线文档 metapi.cita777.me。

## 二、开发环境与命令

### 运行时前置
- **包管理器：统一 npm**。仓库里虽同时存在 `pnpm-lock.yaml` 和 `package-lock.json`，但 CI（`npm ci` + `npm run *`）与权威流程都是 npm，不要用 pnpm。
- **Node 版本：以 `.nvmrc` / `package.json engines` 的 25 为准**。README badge（22.15+）、CONTRIBUTING（20+）里的旧版本号不可信。

### 命令全集（均来自 package.json scripts，真实）

**开发**
- `npm run dev` — 后端(:4000) + 前端(:5173) 并行热更新
- `npm run dev:server` — 仅后端（`tsx scripts/dev/run-server.ts --watch`）
- `npm run dev:desktop` — Electron 开发模式

**构建**
- `npm run build` — 三端全量（build:web + build:server + build:desktop）
- `npm run build:web` / `build:server` / `build:desktop` — 分端构建
- `npm run dist:desktop` — electron-builder 打包桌面应用

**生产启动**
- `npm start` — `node dist/server/index.js`（需先 build）
- `npm run start:desktop` — `electron dist/desktop/main.js`

**测试（Vitest）**
- `npm test` — 全量 `vitest run --root .`
- `npm run test:watch` — 监听 `vitest --root .`
- 单文件：`npx vitest run --root . src/server/db/schemaContract.test.ts`
- 多文件：`npx vitest run --root . 文件A 文件B`
- 按用例名过滤：`npx vitest run --root . -t "用例名关键字"`
- 单文件 watch：`npx vitest --root . <文件>`
- 分组脚本：`test:schema:unit`（离线）、`test:schema:parity` / `test:schema:upgrade` / `test:schema:runtime`（跨 MySQL / Postgres 的 live 测试）
- 数据库冒烟：`smoke:db`（sqlite）/ `smoke:db:mysql` / `smoke:db:postgres`

**类型检查 & 架构检查（无 ESLint / Prettier，"lint" 即这些）**
- `npm run typecheck` — 四端全量 tsc；也可 `typecheck:web` / `typecheck:server` / `typecheck:desktop`
- `npm run repo:drift-check` — 架构边界 / 漂移检查（改共享边界后必跑，见上文 Guardrails）

**数据库 schema**
- `npm run db:generate`（drizzle-kit 生成迁移）、`db:migrate`、`schema:generate`（重新生成已签入 schema 构件）

**文档**
- `npm run docs:dev` / `docs:build` / `docs:preview`（VitePress）

### 提交前本地闸门
`npm test && npm run build`；动了架构再加 `npm run repo:drift-check`。
CI（`.github/workflows/ci.yml`）顺序：`npm ci` → test / build:web / build:server / build:desktop / typecheck / repo:drift-check / schema parity+upgrade+runtime / docs:build / Docker。

### 本地测试服务器（`TEST_ENVIRONMENT_SETUP.md`）
`DATA_DIR="./tmp/test-db" node dist/server/index.js`（:4000，管理 Token `test-admin-token`，测试库 `./tmp/test-db/hub.db`）。
Windows：重启用 `restart.bat`，拷贝文件用 PowerShell `Copy-Item`（见 `CONTRIBUTING.md`）。

## 三、架构大图景

系统分为**数据平面**（单次代理请求的处理）与**控制平面**（后台的路由构建与健康维护）两条平面。

### A. 数据平面 —— 代理请求调用链（最重要）

```
客户端 → /v1/*（OpenAI / Claude / Gemini 兼容）
  → routes/proxy/router.ts（proxyAuthMiddleware 鉴权）
  → 路由适配器 chat.ts / responses.ts / gemini.ts …（只解析上下文，不拥有协议 / 重试 / 计费 / 持久化）
  → 解析下游 Key → downstreamRoutingPolicy（决定该 Key 允许的路由 / 通道）
  → proxy-core/surfaces/*（chatSurface / geminiSurface / openAiResponsesSurface；通道与会话簿记统一走 sharedSurface.ts）
  → tokenRouter 选通道（路由大脑）
  → DefaultProxyConductor 编排"尝试 → 失败分类 → 故障转移"循环
  → executeEndpointFlow 逐个尝试端点候选（跨协议回退）
  → executors（claude / codex / gemini-cli / antigravity）+ providers + cliProfiles
  → transformers（协议纯转换）→ 上游站点
  → 回填：tokenRouter.recordSuccess/recordFailure + sharedSurface 计费 / 写 proxy_logs
```

**三个核心抽象及其协作**：
- **tokenRouter（`services/tokenRouter.ts`，路由大脑）**：把"模型名 + 策略"映射到可服务它的**通道**（channel = 站点 + 账号 + token）。主要接口（从消费者反推）：`selectChannel(model, policy)`、`selectNextChannel(model, excludeIds, policy)`（故障转移）、`selectPreferredChannel(...)`（强制 / 首选）、`recordSuccess/recordFailure`（写健康 & 触发冷却）、`explainSelection*`（解释选路，供 UI / 监控预览）、`getAvailableModels`、`clearChannelFailureState`。内部据 `token_routes` / `route_channels` 做加权（成本 / 余额 / 使用率 / 概率），并跳过冷却中的通道。
  - ⚠️ 该文件在当前环境有 Claude Code 权限 **deny 规则**（无法直读），以上职责由其消费者（`sharedSurface`、`channelSelection`、`geminiSurface`、`routeCooldownService` 等）与大量 `tokenRouter.*.test.ts` 反推得出，可信度高；细节以实际代码为准。
- **DefaultProxyConductor（`proxy-core/conductor/`）**：每请求的状态机。`selectChannel → attempt →` 成功记 success；失败由 `retryPolicy.failureActionOf` 分类为 terminal / retry-same-channel / refresh-auth / failover。故障转移时把失败通道加入 `excludeChannelIds` 再 `selectNextChannel`，实现"一个通道挂了自动冷却切下一个"。
- **executeEndpointFlow（`proxy-core/orchestration/endpointFlow.ts`）**：比 conductor 更底层——对**同一通道的多个端点候选**顺序尝试，带首字节超时、`tryRecover` / `shouldDowngrade` / `shouldAbortRemainingEndpoints` 钩子，实现跨协议端点回退。

### B. 控制平面 —— 路由构建与健康（后台，独立于单次请求）
- **模型发现**：`modelAvailabilityProbeService` 探测上游 → 写 `model_availability`。
- **路由重建**：`routeRefreshWorkflow.rebuildRoutesOnly()` → `modelService.rebuildTokenRoutesFromAvailability()`，据可用性构建 `token_routes` + `route_channels`（启动时与刷新时调用）。
- **决策快照**：`routeDecisionRefreshService` + `routeDecisionSnapshotStore` 预算并缓存 `explainSelection*` 结果，供前端 TokenRoutes 页展示"会选哪个通道、为什么"。
- **冷却与恢复**：`routeCooldownService`（冷却状态）+ `channelRecoveryProbeService`（后台探测让恢复的通道解冻）。
- **策略**：`routeRoutingStrategy`（概率 / 成本 / 优先级）+ `downstreamRoutingPolicy`（按下游 Key 限定策略）。

### C. Monitor 模块
`routes/api/monitor.ts` + `pages/Monitors.tsx` 是**独立的监控 / 可观测面**，有自己的 cookie 鉴权与限流，聚合账号快照（`getAccountsSnapshot`），可代理到外部监控服务（ldoh）。近期提交 `fix: resolve routing monitor fallback regressions` 修的是**监控 / 健康总览的回退数据源**（health refresh 运行态、today-reward 回退等）：主路由 / 健康数据不可用时降级到备用来源。

### D. 核心领域模型（`db/schema.ts`，SQLite 为权威方言）
主链条：
`sites`（上游站点）→ `accounts`（账号 / 凭据）→ `account_tokens`（密钥）→ `model_availability`（发现的模型可用性）→ `token_routes`（路由）→ `route_channels`（候选通道）—— 最终由 tokenRouter 选中一个通道。
下游侧：`downstream_api_keys` → downstreamRoutingPolicy 约束可用路由。
其余：`checkin_logs`（签到）、`proxy_logs` / `proxy_debug_traces`（日志 / 调试）、`*_usage`（用量投影）、`oauth_route_units`（OAuth 路由单元）、`settings`（运行时配置，支持热切换数据库后端 `switchRuntimeDatabase`）。

### E. 入口与关键文件
- 服务端入口 `src/server/index.ts`：Fastify 装配（DB 引导 → 运行时设置水合 → 注册 `/api/*` 管理路由 + `/v1/*` 代理路由 + 静态 SPA → 启动一批后台调度器）
- 代理路由表 `src/server/routes/proxy/router.ts`
- 代理编排 `proxy-core/conductor/DefaultProxyConductor.ts`、`orchestration/endpointFlow.ts`、`surfaces/sharedSurface.ts`
- 配置 `src/server/config.ts`
- Web 入口 `src/web/main.tsx` → `src/web/App.tsx`（侧边栏壳 + 路由），API 客户端 `src/web/api.ts`
- 跨端契约 `src/shared/tokenRouteContract.*`、`tokenRoutePatterns.*`（以手写 `.js` + `.d.ts` 免构建共享）

## 四、配置要点
- **多 tsconfig 分端编译**：`tsconfig.json`（基础，strict / ESNext / target ES2022，含路径别名）+ `tsconfig.web.json` / `tsconfig.web.test.json` / `tsconfig.server.json` / `tsconfig.desktop.json`。
  - 路径别名：`@db/*`→`src/server/db/*`、`@services/*`、`@routes/*`、`@middleware/*`
- **`vitest.config.ts`**：排除 `.worktrees/**`；强制 `NODE_ENV=test`（避免 React 生产构建导致 `act()` 失效）。
- **`vite.config.ts`**（前端）、**`drizzle.config.ts`**（ORM 迁移）、**`electron-builder.yml`**（桌面打包）。
- **`.env.example`**（进程启动前必需的低层配置，其余配置已迁移到"数据库 + 前端设置页"）：
  - `AUTH_TOKEN`（必填，管理后台 / 管理 API 登录令牌）
  - `PROXY_TOKEN`（可选，保护 `/v1/*` 代理端点）
  - `PORT`（默认 4000；桌面版忽略，用动态端口）
  - `DATA_DIR`（默认 `./data`，存 SQLite / 日志；Docker 挂载为 volume）
  - `DB_TYPE`（sqlite / mysql / postgres，默认 sqlite）、`DATABASE_URL`（mysql / postgres 用）
- **部署相关**：`docker/`、`Dockerfile` / `.dockerignore`、`render.yaml`、`zeabur-template.yaml`、`update-and-restart.sh`、`restart.bat`（Windows）。

## 五、仓库文档地图
- `AGENTS.md`（本文件）— 工程规则（上文）+ 交接说明（本节）
- `README.md` / `README_EN.md` — 中英项目介绍、部署（Docker / Zeabur / Render）
- `CONTRIBUTING.md` — 开发命令表、约定式提交（feat / fix / docs / refactor / test / chore）、平台适配器放 `src/server/services/platforms/`、Windows 注意
- `TEST_ENVIRONMENT_SETUP.md` — 本地测试服务器与测试库
- `PR_PREPARATION.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`優化清單.md`（繁中优化清单）
- `CLAUDE.md` — 给 Claude Code 的精简向导（内容与本节有重叠，以本文件为权威）
- 本地计划文件在 `docs/plans/`（git 忽略）

## 六、易踩坑速查
1. 用 **npm**，别用 pnpm（尽管有 pnpm-lock.yaml）；Node **25**。
2. **没有 ESLint / Prettier** —— "lint" = `npm run typecheck` + `npm run repo:drift-check`。
3. 跑单测：`npx vitest run --root . <文件>` 或 `-t "<用例名>"`。
4. 改数据库 schema 必须"三件套同步"（Drizzle schema + SQLite 迁移 + 重新生成 artifacts），跨方言 SQL 由 schema contract 生成、禁止手写（见上文 Database Rules）。
5. 改架构边界必跑 `repo:drift-check`；架构以 `*.architecture.test.ts` 守卫。
6. 分层铁律：routes 只做适配、transformers 保持协议纯净、Web 页面间不互相 import（见上文规则）。
7. `tokenRouter.ts` 在本环境有权限 deny，读不了就看它的消费者与测试。
