# n8n Telegram Bot 部署指南

本指南介绍如何在 n8n 中部署 MetAPI 模型探测 Telegram Bot。

## 前置条件

1. **n8n 实例**：https://n8n.freetcp.dpdns.org/
2. **MetAPI 实例**：https://metapi-krj9.onrender.com/
3. **Telegram Bot Token**：已创建的 Bot（MM_OClaw_bot）
4. **MetAPI AUTH_TOKEN**：从 MetAPI 环境变量获取

## 配置步骤

### 1. 创建 Credentials

#### 1.1 Telegram API Credential
- 名称：`MM_OClaw_bot`
- 类型：`Telegram API`
- Bot Token：`<你的 Telegram Bot Token>`

#### 1.2 MetAPI Auth Credential
- 名称：`MetAPI Auth`
- 类型：`Header Auth`
- Name：`Authorization`
- Value：`Bearer <你的 MetAPI AUTH_TOKEN>`

### 2. 导入 Workflow

1. 打开 n8n：https://n8n.freetcp.dpdns.org/
2. 点击左上角 **"+"** 创建新 workflow
3. 点击右上角 **"..."** → **Import from File**
4. 选择 `docs/telegram-bot-workflow.json`
5. 导入后，检查所有节点的 credential 是否正确关联

### 3. 配置权限检查

在 **"预处理"** 节点的 `ALLOWED_USERS` 数组里填你的 Telegram User ID。

获取 User ID 方法：
- 向 [@userinfobot](https://t.me/userinfobot) 发送任意消息
- 它会返回你的 User ID

### 4. 激活 Workflow

1. 点击右上角 **"Active"** 开关，激活 workflow
2. Telegram Trigger 会自动注册 webhook

### 5. 设置命令菜单

见下方「页面按钮设置」一节——**必须手动设置一次**，否则 Telegram 里看不到命令提示。

### 6. 测试命令

在 Telegram 中向你的 Bot 发送以下命令测试：

- `/help` - 查看帮助信息
- `/targets` - 打开站点多选按钮面板
- `/probe all` - 探测所有站点
- `/probe 1,2,3` - 探测指定站点（用站点 ID）
- `/status` - 查看最近一次探测结果
- `/status <taskId>` - 查询指定任务

## API 说明

### GET /api/remote-probe/targets

获取可探测的站点和模型列表。

**Query Parameters:**
- `siteIds`（可选）：逗号分隔的站点 ID，默认返回所有活动站点
- `summary`（可选）：`true`（默认）仅返回统计数据，`false` 包含模型列表

**Response:**
```json
{
  "success": true,
  "sites": [
    {
      "siteId": 1,
      "siteName": "OpenAI Official",
      "platform": "openai",
      "status": "active",
      "modelCount": 15,
      "models": ["gpt-4", "gpt-4-turbo", ...]
    }
  ],
  "summary": {
    "totalSites": 5,
    "totalModels": 42
  }
}
```

### POST /api/remote-probe/run

启动模型探测任务。

**Request Body:**
```json
{
  "siteIds": "all",  // 或 [1, 2, 3]
  "waitForCompletion": true,  // 小批量自动等待
  "timeout": 300000  // 最大等待时间（毫秒）
}
```

**Response（小批量完成）:**
```json
{
  "success": true,
  "status": "completed",
  "taskId": "probe_xyz123",
  "summary": {
    "totalProbed": 10,
    "supported": 8,
    "unsupported": 1,
    "inconclusive": 1,
    "durationMs": 5000
  },
  "available": [
    {
      "siteId": 1,
      "siteName": "OpenAI",
      "modelName": "gpt-4",
      "latencyMs": 200,
      "balance": "5.00"
    }
  ]
}
```

`available` 按**站点名 → 模型名**排序（不是按响应速度）。统计与列表都是**本次任务范围内**的完整结果，不受网页端分页限制。

**Response（大批量异步）:**
```json
{
  "success": true,
  "status": "running",
  "taskId": "probe_xyz123",
  "message": "探测范围较大，已在后台执行"
}
```

### GET /api/remote-probe/status/:taskId

查询指定探测任务状态。

### GET /api/remote-probe/status

不传任务 ID，查询**最近一次**探测任务。Telegram 里的 `/status`（不带参数）走这个。

**Response（运行中）:**
```json
{
  "success": true,
  "taskId": "probe_xyz123",
  "status": "running",
  "progress": { "current": 5, "total": 20 }
}
```

**Response（已完成）:**
同 `/run` 接口的完成响应，且 `taskId` 一定会返回（便于用户知道查的是哪一次）。

### GET /api/remote-probe/active

当前是否有探测在运行——只看 `pending` / `running`。

```json
{ "success": true, "running": false }
```

存在的意义：Telegram 机器人要判断"现在能不能点开始探测"，用这个接口不会产生副作用。如果去调 `/run` 来判断，那本身就是一次真实探测。

## Workflow 架构

```
Telegram Trigger（监听 message + callback_query）
    ↓
预处理（权限检查 / 解析命令 / 解析按钮点击）
    ↓
动作路由（Switch）
    ├─ render  → 拼装站点按钮（拉 /targets）→ 发送站点选择（inline keyboard）
    ├─ probe   → 探测前置检查（/active）→ 调用MetAPI → 决定是否探测 → 是否发起探测
    │                                                    ├─ 是 → 发起探测 → 格式化结果 → 发送回复
    │                                                    └─ 否 → 格式化结果 →（忙碌提示）→ 发送回复
    ├─ api     → 调用MetAPI（/status）→ 决定是否探测 → 是否发起探测 → 格式化结果 → 发送回复
    └─ answer  → 准备按钮回应 → 回应按钮点击（answerCallbackQuery）
```

### /targets 的按钮交互

`/targets` 发出的是一个 **inline keyboard**，每个站点一个按钮，底部是「🚀 开始探测 (n)」和「🧹 清空」。

- 按钮文字用 `✅` / `▫️` 前缀表示选中状态——**Telegram 的按钮本身没有勾选框**，只能靠文字表示
- 按钮上携带的 `callback_data`：`t:<站点ID>` 切换选中，`go` 开始探测，`clr` 清空
- 选中状态存在 workflow 静态数据（`$getWorkflowStaticData('global')`），**按 chatId 分开记**；n8n 重启会清空，这是有意的
- 每次点击都会**编辑原消息**（不是新发一条），所以按钮上的选中标记是实时变化的
- 每行放 2 个站点，站点多的时候消息会很长但可滚动

### 探测前的并发保护

点「开始探测」时，workflow 先调 `/api/remote-probe/active`：

- 已有探测在跑 → 回「⏳ 已有一次探测在进行中」，**不发起新的**
- 没有在跑 → 调 `/run` 真正开始（`waitForCompletion: false`，立即返回 taskId）

这一步很关键：探测花的是真实配额。后台任务虽然会用 dedupeKey 拒绝同范围的并发扫描，但**不同范围**的扫描是可以并存的，用户连点两下就会花两份钱。`/active` 是只读的，用它来判断不会产生任何副作用。

## 页面按钮设置（Bot 菜单）

Telegram 的命令菜单用 Bot API 设置（n8n 不管这个）：

```powershell
$token = '<你的 Bot Token>'
$body = @{
  commands = @(
    @{ command = 'targets'; description = '选择要探测的站点' },
    @{ command = 'probe';   description = '探测站点，用法: /probe all 或 /probe 站点ID' },
    @{ command = 'status';  description = '查看最近一次探测结果' },
    @{ command = 'help';    description = '显示帮助信息' }
  )
} | ConvertTo-Json -Depth 3
Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/setMyCommands" -Method Post -ContentType 'application/json' -Body $body
```

注意：命令名只能是 `a-z0-9_`，**不能带空格**，所以菜单里不能写 `/probe all`，用法只能写在描述里。

## 注意事项

1. **授权认证**：所有 `/api/remote-probe/*` 端点都需要 `Authorization: Bearer <AUTH_TOKEN>`
2. **速率限制**：避免频繁调用探测 API，每次探测都会消耗真实配额
3. **超时设置**：HTTP Request 节点的超时要与探测 API 的 `timeout` 参数匹配（默认 300 秒）
4. **错误处理**：workflow 已包含基本错误处理，但可根据需要增强
5. **日志监控**：在 n8n 的 Executions 页面可以查看每次执行的详细日志

## 故障排查

### 问题：收不到 Bot 消息
- 检查 Telegram Trigger 是否激活
- 检查 Bot Token 是否正确
- 确认已向 Bot 发送过 `/start` 命令

### 问题：API 调用失败（401 Unauthorized）
- 检查 MetAPI Auth credential 的 Token 是否正确
- 确认 Header 格式为 `Authorization: Bearer <token>`

### 问题：API 调用失败（404 Not Found）
- 确认 MetAPI URL 正确：`https://metapi-krj9.onrender.com`
- 检查 MetAPI 实例是否在线（Render 可能休眠）

### 问题：探测超时
- 增加 HTTP Request 节点的 timeout 设置
- 减少探测范围（指定少量站点 ID）
- 对大批量探测使用异步模式（不等待完成）

## 扩展建议

1. **添加结果筛选**：只返回可用的模型，隐藏不可用的
2. **定时探测**：使用 n8n 的 Schedule Trigger 定期自动探测
3. **告警通知**：当某个重要站点不可用时主动推送消息
4. **多用户支持**：扩展权限检查节点，支持多个授权用户
5. **结果持久化**：将探测结果存储到数据库或文件
