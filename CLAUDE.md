# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

metapi 是一个面向 AI API 的**元聚合网关**（"中转站的中转站"）：把分散在多个上游中转站（New API / One API / OneHub / Veloera / AnyRouter 等）和 OAuth（Codex / Claude / Gemini CLI / Antigravity）上的账号，聚合成**单一入口 + 单一下游 API Key**，对下游工具（Cursor / Claude Code / Codex / Open WebUI）无感提供全部模型。核心能力：统一代理入口、按成本/余额/使用率的智能路由、自动故障转移、自动模型发现、自动签到、集中看板。

TypeScript（ESM，Node ≥25）单仓库产出三端：`src/server`（Fastify 5 + Drizzle ORM，多方言 SQLite/MySQL/Postgres）、`src/web`（React 18 + Vite 6 + Tailwind 4）、`src/desktop`（Electron，包裹 server+web）。

**先读 `AGENTS.md`** —— 它是本仓库的权威工程规则（分层边界、数据库契约、Web 约定）。本文件不重复其全文，只做架构导航与命令补充。

## 常用命令

包管理器统一用 **npm**（尽管仓库里同时存在 `pnpm-lock.yaml`，权威流程与 CI 均为 npm）。Node 版本以 `.nvmrc` / `package.json engines` 的 **25** 为准（README / CONTRIBUTING 里的旧版本号不可信）。

**开发**
- `npm run dev` — 后端(:4000) + 前端(:5173) 并行热更新
- `npm run dev:server` — 仅后端（tsx --watch）
- `npm run dev:desktop` — Electron 开发模式

**构建 / 生产**
- `npm run build` — 三端全量（= build:web + build:server + build:desktop）；也可单端 `build:web` / `build:server` / `build:desktop`
- `npm start` — 生产启动（`node dist/server/index.js`，需先 build）
- `npm run dist:desktop` — electron-builder 打包桌面应用

**测试（Vitest）**
- `npm test` — 全量（`vitest run --root .`）；`npm run test:watch` 监听模式
- **单个测试文件**：`npx vitest run --root . <文件路径>`（如 `src/server/db/schemaContract.test.ts`）
- **按用例名过滤**：`npx vitest run --root . -t "<用例名关键字>"`；单文件 watch：`npx vitest --root . <文件>`
- schema 专项：`test:schema:unit`（离线）、`test:schema:parity` / `test:schema:upgrade` / `test:schema:runtime`（跨 MySQL/Postgres 的 live 测试）
- 数据库冒烟：`npm run smoke:db`（sqlite）/ `smoke:db:mysql` / `smoke:db:postgres`

**代码质量（无 ESLint / Prettier，"lint" 等价于下面两条）**
- `npm run typecheck` — 四端全量 tsc；也可 `typecheck:web` / `typecheck:server` / `typecheck:desktop`
- `npm run repo:drift-check` — **架构边界 / 仓库漂移检查；改动共享架构边界后必须跑**

**数据库 schema**（改动规则见下方"关键约定"）
- `npm run db:generate`（drizzle-kit 生成迁移）、`npm run db:migrate`、`npm run schema:generate`（重新生成已签入的 schema 构件）

**提交前本地闸门**：`npm test && npm run build`；动了架构再加 `npm run repo:drift-check`。CI 会依次跑 test / build / typecheck / repo:drift-check / schema parity+upgrade+runtime / docs:build / Docker。

本地起测试服务器（见 `TEST_ENVIRONMENT_SETUP.md`）：`DATA_DIR="./tmp/test-db" node dist/server/index.js`（:4000，管理 Token `test-admin-token`）。Windows 上重启用 `restart.bat`，拷贝文件用 PowerShell `Copy-Item`（见 `CONTRIBUTING.md`）。

## 架构

### 数据平面：代理请求调用链（最重要的大图景）

一次 `/v1/*` 代理请求的流转：

```
客户端 → /v1/* → routes/proxy/router.ts（proxyAuthMiddleware 鉴权）
  → 路由适配器 chat.ts / responses.ts / gemini.ts（只解析上下文，不拥有协议/重试/计费/持久化）
  → 下游 Key → downstreamRoutingPolicy（限定该 Key 可用的路由/通道）
  → proxy-core/surfaces/*（chat / gemini / openAiResponses；通道与会话簿记统一走 sharedSurface.ts）
  → tokenRouter 选通道 → DefaultProxyConductor 编排"尝试 → 失败分类 → 故障转移"
  → executeEndpointFlow 逐个尝试端点候选（跨协议回退）
  → executors + providers + transformers（协议纯转换）→ 上游站点
  → 回填 tokenRouter.recordSuccess/recordFailure + sharedSurface 计费 / 写 proxy_logs
```

三个核心抽象：
- **tokenRouter（`services/tokenRouter.ts`，路由大脑）**：把"模型名 + 策略"映射到具体**通道**（channel = 站点 + 账号 + token）。据 `token_routes` / `route_channels` 做加权选路（成本 / 余额 / 使用率 / 概率），跳过冷却中的通道，并用 `recordSuccess/recordFailure` 维护健康与冷却。
- **DefaultProxyConductor（`proxy-core/conductor/`）**：每请求的状态机。失败经 `retryPolicy` 分类为 terminal / retry-same-channel / refresh-auth / failover；故障转移时把失败通道加入排除集再 `selectNextChannel`。
- **executeEndpointFlow（`proxy-core/orchestration/endpointFlow.ts`）**：对同一通道的多个端点候选顺序尝试（首字节超时，recover / downgrade / abort 钩子），实现跨协议端点回退。

### 控制平面：路由构建与健康（后台，独立于单次请求）

- 模型发现 `modelAvailabilityProbeService` → 写 `model_availability`
- 路由重建 `routeRefreshWorkflow.rebuildRoutesOnly()` → `modelService.rebuildTokenRoutesFromAvailability()` 构建 `token_routes` + `route_channels`
- 决策快照 `routeDecisionRefreshService` + `routeDecisionSnapshotStore`：预算并缓存"会选哪个通道、为什么"，供前端 TokenRoutes 页展示
- 冷却 / 恢复 `routeCooldownService` + `channelRecoveryProbeService`（后台探测让恢复的通道解冻）

### 主动模型探测（active model probe，与上面的自动发现是两套东西）

`modelProbeDiscoveryService`（发现"有哪些模型"）+ `modelProbeRunService`（预览 / 执行 / 结果 / 取消）。与控制平面其余部分的关键差别：

- **没有调度器**，每次扫描都由操作员显式排队。它打的是**真实付费请求**，所以绝不能变成无人值守的周期流量。两道前置闸门：硬上限 `MAX_ACTIVE_PROBE_RUN_TARGETS`（300）与确认对话框授权的 `authorizedTargetCount`，都在第一次探测前判定，拒绝不花钱。
- `modelProbeDiscoveryService` **只读**（仅 `db.select`）。不得调用 `modelService.refreshModelsForAccount()`（它会重写 `model_availability`、改账号健康、重建路由），也不得用 `runWithSiteApiEndpointPool()`（会写端点冷却状态）——"预览"按钮背后不能有写操作。
- 遍历是三层：**站点 → key → 模型**。站点轴与模型轴各有并发配置（`siteConcurrency` / `modelConcurrency`），**key 轴串行**。取消标志在最内层回调检查，所以取消能落在单次探测的粒度上。
- **key 轴**：站点下优先级最高账号的主 key（`accounts.api_token` / `access_token`）+ 其名下每个 `account_tokens` 行。各 key 分别拉自己的 `/v1/models`，站点目标集 = 各 key 并集（不同 key 常在不同令牌分组，能拉到的模型不同）。主 key 由 `selectProbeKeys` 放在返回数组**首位**，判定主 key 一律按位置，不要拿 `tokenId` 比——哨兵 0 在账号间共享，且主 key 落到托管行时会带真实 `account_tokens.id`。
- **写入分工**：主 key 结果写 `model_probe_results`（站点级，喂路由同步），所有 key 结果写 `model_probe_key_results`（per-key）。`model_availability` **只认主 key 的结论**——附加 key 只是发现轴、不承载代理流量，把各 key 取并集会制造假可用（下游请求该模型时仍用主 key 转发然后失败）。
- 路由同步默认双开关关闭（`PROXY_ROUTING_ENABLED` + 探测配置的 `syncToRouting`），所以默认一次扫描是纯诊断。中途取消会撤回授权：**部分完成**的扫描不落任何路由效果，但判定照旧留在结果表里供查看。

### Monitor 模块

`routes/api/monitor.ts` + `pages/Monitors.tsx` 是独立的可观测面（自有 cookie 鉴权与限流），聚合账号快照并可代理外部监控。注意其"回退数据源"逻辑：主路由 / 健康数据不可用时降级到备用来源（近期 `fix: resolve routing monitor fallback regressions` 即改此处）。

### 核心领域模型（`db/schema.ts`，SQLite 为权威方言）

`sites`（上游站点）→ `accounts` → `account_tokens` → `model_availability` → `token_routes` → `route_channels` —— tokenRouter 最终选中一个通道。下游侧 `downstream_api_keys` 经 downstreamRoutingPolicy 约束可用路由。另有 `checkin_logs`、`proxy_logs` / `proxy_debug_traces`、`*_usage`、`settings`（运行时配置，支持热切换数据库后端）。

主动探测结果两张表：`model_probe_results` 唯一键 `(site_id, model_name)`（站点级，无 token 列）；`model_probe_key_results` 唯一键 `(account_id, token_id, model_name)`，三列均 NOT NULL。后者的 `token_id` 用哨兵 `0` 表示账号级主 key，因此**不能建真外键**——删 `account_tokens` 行时要在应用层顺手清它的结果行（`site_id` / `account_id` 仍是真外键真级联）。唯一键必须带 `account_id`：哨兵 0 在账号之间共享，只按 `(token_id, model_name)` 会让两个账号的主 key 撞成一行。

入口：服务端 `src/server/index.ts`（Fastify 装配 → 注册 `/api/*` 管理路由 + `/v1/*` 代理路由 + 静态 SPA → 启动后台调度器）；Web `src/web/main.tsx` → `App.tsx`；跨端契约在 `src/shared/`（以手写 `.js` + `.d.ts` 免构建共享）。

## 关键约定（详见 AGENTS.md）

- **严格分层**：`routes/**` 只做薄适配，不得拥有协议转换 / 重试 / 流生命周期 / 计费 / 持久化——这些归 `proxy-core/**`；`transformers/**` 必须协议纯净，禁止 import routes / Fastify / OAuth / tokenRouter。
- **两条硬约定**：端点回退必须走 `executeEndpointFlow()`；通道 / 会话簿记必须走 `sharedSurface.ts`；读上游整包响应用 `readRuntimeResponseText()` 而非 `.text()`。
- **DB 以 schema 契约为唯一真源**：Drizzle SQLite schema 权威，MySQL / Postgres 的 bootstrap / upgrade SQL 由 `schema:contract` 生成（禁止手写跨方言 SQL）。改 schema = 三件同步：改 Drizzle schema + 更新 SQLite 迁移 + 重新生成已签入的 artifacts。
- **能力声明驱动**：平台检测 / 端点偏好 / 发现传输统一来自 `proxy-core/capabilities` 与 `services/platforms/*`，不要散落 `if (platform === ...)`；新平台适配器放 `services/platforms/`。
- **Web 约定**：页面之间禁止互相 import；移动端复用共享原语（`ResponsiveFilterPanel` / `MobileCard` / `useIsMobile` / `mobileLayout.ts`）。
- 架构边界由 `*.architecture.test.ts` 守卫，改跨边界模块前跑 `repo:drift-check`；本地计划文件放 `docs/plans/`（git 忽略）。

## 配置要点

- 多 tsconfig 分端编译（`tsconfig.json` 基础 + `tsconfig.{web,web.test,server,desktop}.json`）。路径别名：`@db/*`→`src/server/db/*`、`@services/*`、`@routes/*`、`@middleware/*`。
- `.env.example`（进程启动前的低层配置，其余配置放在数据库 + 前端设置页）：`AUTH_TOKEN`（必填，管理登录）、`PROXY_TOKEN`（可选，保护 `/v1/*`）、`PORT`（默认 4000）、`DATA_DIR`（默认 `./data`）、`DB_TYPE`（sqlite/mysql/postgres）、`DATABASE_URL`。
- `vitest.config.ts` 强制 `NODE_ENV=test` 并排除 `.worktrees/**`。
