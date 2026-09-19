# n8n Telegram 探测机器人

在 Telegram 里选站点、跑模型探测、看结果。机器人本体是 n8n 工作流，探测逻辑全在 MetAPI 的[远程探测 API](./remote-probe-api.md) 里——n8n 只负责 Telegram 交互。

- 工作流文件：[`integrations/telegram-bot-workflow.json`](../integrations/telegram-bot-workflow.json)
- 本地模拟测试：`node integrations/telegram-bot-workflow.simulate.mjs`
- 推送到 n8n：`node integrations/deploy-telegram-bot-workflow.mjs`

## 前置条件

1. **n8n 实例**（本文以 `https://n8n.freetcp.dpdns.org/` 为例）
2. **MetAPI 实例**（本文以 `https://metapi-krj9.onrender.com/` 为例）
3. **Telegram Bot Token**（找 [@BotFather](https://t.me/BotFather) 创建）
4. **MetAPI `AUTH_TOKEN`**：MetAPI 进程的环境变量
5. **你的 Telegram User ID**：向 [@userinfobot](https://t.me/userinfobot) 发任意消息即可拿到

## 部署步骤

### 1. 建两个 Credential

| 名称 | 类型 | 填什么 |
|------|------|--------|
| `MetAPI Auth` | Header Auth | Name = `Authorization`，Value = `Bearer <AUTH_TOKEN>` |

`MetAPI Auth` 被工作流里三个 HTTP Request 节点引用（拉站点列表、查 `/active`、发起探测）。

> **Telegram 的 Token 不走 n8n 凭据**，见下方「为什么不用 n8n 的 Telegram 节点」。

### 2. 导入工作流

n8n 里 **Workflows → ⋯ → Import from File**，选 `integrations/telegram-bot-workflow.json`。

导入后检查三处：

1. 三个 HTTP Request 节点的 credential 是不是 `MetAPI Auth`
2. `预处理` 节点顶部的 `ALLOWED_USERS` 数组填你的 User ID
3. `预处理` 节点顶部的 `METAPI` 常量填你的 MetAPI 地址

### 3. 设置 Bot Token

`预处理` 节点顶部：

```js
let BOT_TOKEN = '<字面量兜底>';
try { if ($env.TELEGRAM_BOT_TOKEN) BOT_TOKEN = $env.TELEGRAM_BOT_TOKEN; } catch (e) { /* 环境变量被禁 */ }
```

**推荐**：在 n8n 的环境变量里设 `TELEGRAM_BOT_TOKEN`，然后把字面量那行改成 `let BOT_TOKEN = '';`。Token 写在节点里等于明文存在 n8n 数据库，任何能看工作流的人都能拿到。

### 4. 激活

打开右上角 **Active** 开关，Telegram Trigger 会自动注册 webhook。

### 5. 设置命令菜单

Telegram 的 `/` 菜单不走 n8n，要用 Bot API 设一次：

```powershell
$token = '<Bot Token>'
$body = @{
  commands = @(
    @{ command = 'targets'; description = '选择要探测的站点' },
    @{ command = 'probe';   description = '探测站点，用法: /probe all 或 /probe 站点ID' },
    @{ command = 'status';  description = '查看最近一次探测结果' },
    @{ command = 'help';    description = '显示帮助信息' }
  )
} | ConvertTo-Json -Depth 3
Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/setMyCommands" `
  -Method Post -ContentType 'application/json' -Body $body
```

命令名只能是 `a-z0-9_`，**不能带空格**——所以菜单里写不了 `/probe all`，用法只能塞进描述。

### 6. 试一下

| 命令 | 作用 |
|------|------|
| `/targets` | 打开站点多选面板 |
| `/probe all` | 探测所有站点 |
| `/probe 180001,180002` | 探测指定站点 |
| `/status` | 最近一次结果 |
| `/status <taskId>` | 指定任务 |
| `/help` | 帮助 |

## 命令说明

### `/targets` —— 站点多选面板

发一条消息，里面是内联键盘：每行 3 个站点按钮，底部一行操作按钮。

```
📋 共 21 个站点

已选 3 个：seekai、咕咕嘎嘎公益站、Tom&Jerry公益站

[▫️KAPI[国…] [▫️魔方公益站] [▫️42api[国…]
[▫️nhh站   ] [▫️烁公益   ] [▫️君の公益 ]
...
[🚀 直接探测] [🔄 刷新] [🧹 清空]
```

- 点站点名切换选中，`✅` / `▫️` 表示状态
- 点「🚀 直接探测」探测选中的站点
- 点「🔄 刷新」重拉站点列表
- 点「🧹 清空」全部取消
- **每次点击只回一个瞬时提示**（如 `➕ seekai · 已选 2 个`），不重绘键盘——重绘要等一次 `editMessageText` 往返，点起来很卡

**站点列表是长期缓存的**，面板顶部标着缓存时间。站点集合变动很慢，按时间过期只会让你白等一次冷启动，所以只有点「🔄 刷新」才重拉。

### `/probe` —— 探测

`/probe all` 或 `/probe 180001,180002`。结果用 Telegram 的富消息表格呈现，超长自动分页。

`/probe` 和 `/status` 的结果**按站点名 → 模型名排序**，不按响应速度——同一个站点的模型聚在一起才好读。

## 工作流架构

```
Telegram Trigger（message + callback_query）
    ↓
预处理（鉴权 / 解析命令 / 从回传键盘还原选中状态）
    ↓
动作路由（Switch，按 action 分 7 路）
    ├─ fetch  → 缓存判断 ─┬─ 命中 → 渲染键盘
    │                     └─ 未命中 → 要调接口吗 → 获取站点列表 → 缓存站点列表 → 渲染键盘
    ├─ render → 渲染键盘（零 IO，状态来自键盘本身）
    ├─ probe  → 探测前置检查 → 查询是否在跑 → 决定是否探测 → 是否发起探测 ─┬─ 是 → 发起探测 ┐
    │                                                                    └─ 否 ──────────┤
    ├─ api    → 查询任务状态 ─────────────────────────────────────────────────────────────┤
    │                                                                                    ↓
    │                                                          格式化结果 → 发送富消息 → 准备兜底文本 → 发送兜底文本
    ├─ answer → 准备按钮回应 → 调用Telegram（answerCallbackQuery）
    └─ send   → 准备文本回复 → 调用Telegram（sendMessage）
```

## 三个关键设计决定

这三处都是踩过坑之后改的，改动前都「看起来更简单」。

### 1. 键盘本身就是状态（无状态设计）

**勾选状态存在 Telegram 回传的键盘里**，服务端不存。

`callback_query.message.reply_markup.inline_keyboard` 会把原消息的键盘一并带回来，所以点一下就知道当前选了什么。

一开始用的是 n8n 静态数据（`$getWorkflowStaticData`），结果是**快速连点几个站点会丢状态**。原因在 n8n 源码里：静态数据在每次执行开始时读一次快照、执行结束时整对象 `UPDATE` 写回，**没有锁、没有字段级合并**。两个执行并发时，后结束的会把先结束的整个覆盖掉（lost update）。而 n8n 默认不串行化执行（`N8N_CONCURRENCY_PRODUCTION_LIMIT` 默认 `-1`）。

键盘即状态则各画各的，不存在覆盖，n8n 重启也不丢。

代价：按钮文字要截断（每行 3 个才放得下），完整站点名塞进 `callback_data`（`t:<id>:<完整名>`），正文和提示里用全名。

### 2. 不用 n8n 的 Telegram 节点，直接调 Bot API

n8n 的 Telegram 节点发不出**动态**内联键盘。

它的 `inlineKeyboard` 是 `fixedCollection` 参数，路由层按 `node.parameters` 的**原始路径**逐层回读子字段（`getParameterValueByPath`）。一旦任何一层是表达式，那条路径在原始参数里就不存在，**整块键盘被静默丢掉**——不报错，就是没有键盘。实测整对象表达式、嵌套表达式都发不出。

所以工作流里所有 Telegram 调用都走 HTTP Request 节点，把 `{url, body}` 当 item 往下传。`预处理` 负责拼 `tgBase`（`https://api.telegram.org/bot<token>`），后面的节点只补 `/sendMessage` 之类的后缀。

### 3. HTTP Request 节点的输出会**替换**输入

这个坑很隐蔽：`发送富消息` 跑完，`$json` 就变成了 Telegram 的响应（`{ok, result}`），**原来的字段全没了**。

最初写成「发富消息 → IF `$json.kind === 'rich'` → 兜底」，结果 `kind` 早就没了，判断恒为假，**兜底每次都触发**——用户看到的就是「一条 HTML 表格 + 一条代码格式」，两条内容相似的消息。

现在判断挪到了 HTTP **之前**：`准备兜底文本` 读自己的 `$input.first()`（也就是 `格式化结果` 的原始输出），再通过 `$('发送富消息')` 去看那次调用的结果，失败才发兜底。

### 附带的一条：Code 节点不能联网

n8n 的 Code 节点沙箱里 `fetch`、`$http`、`require('http')` 全都不可用。所有网络调用必须落在 HTTP Request 节点上，Code 节点只能做纯数据变换。

## 故障排查

| 现象 | 原因 |
|------|------|
| 收不到消息 | Trigger 没激活；Bot Token 错；没先给 Bot 发过 `/start` |
| `401 / 403 Invalid token` | `MetAPI Auth` 凭据里的 `AUTH_TOKEN` 不对 |
| `404` | MetAPI 地址写错；Render 实例休眠了 |
| `/targets` 说「没有可用的站点」 | MetAPI 挂了或鉴权失败。面板会带出失败原因，点「🔄 刷新」重试 |
| 点站点没反应 | 消息太老，Telegram 不再回传键盘——重发 `/targets` |
| 探测超时 | 缩小范围；或确认 `发起探测` 节点的 timeout 够大（当前 300s） |

看日志：n8n 的 **Executions** 页面有每次执行的完整节点输入输出。

## 改这个工作流

改完必须做两件事，缺一不可：

```powershell
# 1. 跑模拟测试（在仿造的 n8n 沙箱里执行每个 Code 节点）
node integrations/telegram-bot-workflow.simulate.mjs
node integrations/telegram-bot-workflow.render.test.mjs

# 2. 推送到 n8n
node integrations/deploy-telegram-bot-workflow.mjs
```

模拟测试直接 `new Function('$input', '$', '$getWorkflowStaticData', ...)` 跑 `jsCode`，覆盖：点击切换、全名还原、名字含冒号、旧键盘向后兼容、缓存命中/未命中/强制刷新、按钮布局与截断、缓存时间显示、兜底触发条件、渲染路径。

> ⚠️ 在 n8n 编辑器里打开工作流并保存，会用编辑器里的版本覆盖线上版本。改之前先确认编辑器里没有未保存的改动。

## 注意事项

1. 所有 `/api/remote-probe/*` 都要 `Authorization: Bearer <AUTH_TOKEN>`
2. **探测花的是真实配额**，别乱点
3. `发起探测` 节点用 `waitForCompletion: false`，立刻拿 taskId 就返回；进度靠 `/status` 查
4. 探测前会先查 `/active`：已有探测在跑就拒绝新的。不同范围的扫描是可以并存的，连点两下就是两份钱，所以这道闸门必须留
