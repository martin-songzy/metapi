# 远程探测 API 文档

远程探测 API 为 Telegram 机器人和其他外部集成提供简化的模型可用性探测接口。

## 基础信息

**Base URL**: `http://your-domain:4000`

**鉴权方式**: 所有接口需在请求头携带 Token：

```http
Authorization: Bearer <AUTH_TOKEN>
```

如果设置了 `PROXY_TOKEN`，则两种 Token 都可以使用。

**限流**: 每个 Token 5 分钟内只能发起 1 次探测（防止滥用）

---

## 接口列表

### 1. GET `/api/remote-probe/targets` - 获取可探测目标

获取可用的站点和模型列表，用于构建探测范围选择器。

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| siteIds | string | 否 | 逗号分隔的站点ID，如 `1,2,3`。不传则返回所有启用站点 |
| summary | string | 否 | `true`（默认）仅返回统计，`false` 包含模型列表 |

#### 请求示例

```bash
# 获取所有站点的统计信息
curl -H "Authorization: Bearer your-token" \
  "http://localhost:4000/api/remote-probe/targets"

# 获取特定站点的详细模型列表
curl -H "Authorization: Bearer your-token" \
  "http://localhost:4000/api/remote-probe/targets?siteIds=1,2,3&summary=false"
```

#### 响应示例

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
      "models": ["gpt-4", "gpt-3.5-turbo"]  // summary=false 时才有
    },
    {
      "siteId": 2,
      "siteName": "Anthropic",
      "platform": "claude",
      "status": "active",
      "modelCount": 8
    }
  ],
  "summary": {
    "totalSites": 10,
    "totalModels": 150,
    "estimatedTargets": 180
  }
}
```

#### 响应字段说明

- `sites[]`: 站点列表
  - `siteId`: 站点ID
  - `siteName`: 站点名称
  - `platform`: 平台类型（openai / claude / gemini 等）
  - `status`: 站点状态（active 表示启用）
  - `modelCount`: 该站点的模型数量
  - `models`: 模型名称数组（仅当 `summary=false`）
- `summary`: 汇总统计
  - `totalSites`: 总站点数
  - `totalModels`: 总模型数（去重后）
  - `estimatedTargets`: 预估探测目标数（考虑多 Key，会大于 totalModels）

---

### 2. POST `/api/remote-probe/run` - 触发探测

立即触发一次模型可用性探测。

**行为说明**：
- **小范围探测**（≤50 个目标）：同步等待完成，直接返回结果
- **大范围探测**（>50 个目标）：异步执行，返回 `taskId` 用于轮询

#### 请求体

```json
{
  "siteIds": "all" | [1, 2, 3],   // 必填："all" 或站点ID数组
  "waitForCompletion": true,       // 可选：是否等待完成（默认 true）
  "timeout": 300000                // 可选：等待超时ms（默认 300000，最大 600000）
}
```

#### 请求示例

```bash
# 探测所有站点（自动等待）
curl -X POST \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"siteIds": "all"}' \
  http://localhost:4000/api/remote-probe/run

# 探测指定站点
curl -X POST \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"siteIds": [1, 2, 3], "waitForCompletion": true, "timeout": 120000}' \
  http://localhost:4000/api/remote-probe/run
```

#### 响应示例（同步完成）

**HTTP 200 OK**

```json
{
  "success": true,
  "status": "completed",
  "taskId": "task_abc123",
  "summary": {
    "totalProbed": 50,
    "supported": 45,
    "unsupported": 3,
    "inconclusive": 2,
    "durationMs": 12500
  },
  "available": [
    {
      "siteId": 1,
      "siteName": "OpenAI Official",
      "modelName": "gpt-4",
      "latencyMs": 1200,
      "balance": 100.5,
      "keyName": "主 Key",
      "isPrimary": true,
      "checkedAt": "2026-09-18T10:30:15Z"
    },
    {
      "siteId": 2,
      "siteName": "Anthropic",
      "modelName": "claude-3-opus",
      "latencyMs": 1500,
      "balance": 50.2,
      "keyName": "主 Key",
      "isPrimary": true,
      "checkedAt": "2026-09-18T10:30:18Z"
    }
  ]
}
```

#### 响应示例（异步执行）

**HTTP 202 Accepted**

```json
{
  "success": true,
  "status": "running",
  "taskId": "task_xyz789",
  "message": "探测范围过大（180 个目标），已在后台执行，请稍后查询结果"
}
```

#### 响应字段说明

**同步完成时**：
- `status`: `"completed"` 表示已完成
- `taskId`: 任务ID
- `summary`: 探测统计
  - `totalProbed`: 探测总数
  - `supported`: 可用数量
  - `unsupported`: 不可用数量
  - `inconclusive`: 不确定数量（超时/网络错误）
  - `durationMs`: 总耗时（毫秒）
- `available[]`: **仅返回可用的模型**
  - `siteId`: 站点ID
  - `siteName`: 站点名称
  - `modelName`: 模型名称
  - `latencyMs`: 响应延迟（毫秒）
  - `balance`: 账号余额（可能为 null）
  - `keyName`: Key 名称（"主 Key" 或自定义名称）
  - `isPrimary`: 是否为主 Key
  - `checkedAt`: 探测时间（ISO 8601）

**异步执行时**：
- `status`: `"running"` 表示后台运行中
- `taskId`: 任务ID，用于后续查询
- `message`: 提示信息

---

### 3. GET `/api/remote-probe/status/:taskId` - 查询任务状态

查询异步探测任务的执行状态和结果。

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| taskId | string | 是 | 路径参数，任务ID |

#### 请求示例

```bash
curl -H "Authorization: Bearer your-token" \
  "http://localhost:4000/api/remote-probe/status/task_xyz789"
```

#### 响应示例（运行中）

**HTTP 200 OK**

```json
{
  "success": true,
  "taskId": "task_xyz789",
  "status": "running",
  "progress": {
    "current": 30,
    "total": 180
  }
}
```

#### 响应示例（已完成）

**HTTP 200 OK**

```json
{
  "success": true,
  "taskId": "task_xyz789",
  "status": "completed",
  "summary": {
    "totalProbed": 180,
    "supported": 165,
    "unsupported": 10,
    "inconclusive": 5
  },
  "available": [
    {
      "siteId": 1,
      "siteName": "OpenAI Official",
      "modelName": "gpt-4",
      "latencyMs": 1200,
      "balance": 100.5,
      "keyName": "主 Key",
      "isPrimary": true,
      "checkedAt": "2026-09-18T10:30:15Z"
    }
  ]
}
```

#### 响应示例（任务不存在）

**HTTP 404 Not Found**

```json
{
  "success": false,
  "message": "任务不存在或已过期"
}
```

#### 响应字段说明

- `status`: 任务状态
  - `pending`: 排队中
  - `running`: 执行中
  - `completed`: 已完成
  - `failed`: 失败
  - `cancelled`: 已取消
- `progress`: 进度信息（仅 running 状态）
  - `current`: 当前完成数
  - `total`: 总目标数
- `summary`: 探测统计（仅 completed 状态）
- `available[]`: 可用模型列表（仅 completed 状态）

---

## 错误响应

所有接口在出错时返回统一格式：

```json
{
  "success": false,
  "message": "错误描述"
}
```

常见 HTTP 状态码：

| 状态码 | 说明 |
|--------|------|
| 200 | 请求成功 |
| 202 | 已接受（异步任务已排队） |
| 400 | 请求参数错误 |
| 401 | 未授权（Token 无效或缺失） |
| 404 | 资源不存在（如任务ID不存在） |
| 409 | 冲突（如超过探测上限） |
| 500 | 服务器内部错误 |

---

## Telegram Bot 集成示例

### 示例 1: 简单探测

```python
import requests
import time

API_BASE = "http://your-domain:4000"
TOKEN = "your-auth-token"
headers = {"Authorization": f"Bearer {TOKEN}"}

# 1. 触发探测
response = requests.post(
    f"{API_BASE}/api/remote-probe/run",
    json={"siteIds": "all"},
    headers=headers
)

data = response.json()

if data["status"] == "completed":
    # 小范围探测，已同步完成
    summary = data["summary"]
    available = data["available"]
    
    message = f"""✅ 探测完成
支持: {summary['supported']} 个
不支持: {summary['unsupported']} 个
耗时: {summary['durationMs']/1000:.1f}秒

最快响应:
"""
    for model in available[:5]:  # 只显示前5个
        message += f"• {model['siteName']} {model['modelName']}: {model['latencyMs']}ms\n"
    
    send_telegram_message(message)

elif data["status"] == "running":
    # 大范围探测，异步执行
    task_id = data["taskId"]
    send_telegram_message("⏳ 探测范围较大，正在后台执行...")
    
    # 轮询结果
    while True:
        time.sleep(5)
        status_response = requests.get(
            f"{API_BASE}/api/remote-probe/status/{task_id}",
            headers=headers
        )
        status_data = status_response.json()
        
        if status_data["status"] == "completed":
            summary = status_data["summary"]
            send_telegram_message(f"✅ 探测完成：支持 {summary['supported']} 个模型")
            break
```

### 示例 2: 查看目标列表

```python
# 获取可探测的站点
response = requests.get(
    f"{API_BASE}/api/remote-probe/targets",
    headers=headers
)

data = response.json()
summary = data["summary"]

message = f"""可探测范围：
站点数: {summary['totalSites']}
模型数: {summary['totalModels']}
预估目标: {summary['estimatedTargets']}

选择探测范围：
"""

for i, site in enumerate(data["sites"][:10], 1):
    message += f"{i}. {site['siteName']} ({site['modelCount']}个模型)\n"

send_telegram_message(message)
```

---

## 注意事项

1. **探测消耗真实配额**：每次探测都会向上游站点发起真实的 API 请求，会消耗账号余额。请谨慎使用。

2. **默认只返回可用结果**：`available[]` 数组只包含 `status='supported'` 的模型，不包含失败或超时的结果。如需完整结果，请使用前端管理界面或直接调用 `/api/model-probe/results`。

3. **模型过滤规则**：探测范围由后端的"模型兴趣正则"配置决定。如果某些模型没有出现在结果中，请检查后端配置（`/api/model-probe/config`）。

4. **并发限制**：同一时间只允许一个探测任务运行。如果已有任务在执行，新请求会自动加入该任务（通过 `dedupeKey` 机制）。

5. **任务过期**：后台任务结果保留时间有限。如果 `/status/:taskId` 返回 404，说明任务已过期，需要重新发起探测。

6. **OAuth 站点默认禁用**：4 个 OAuth 厂商站点（Codex / Claude / Gemini CLI / Antigravity）默认为禁用状态，不会出现在探测范围中。如需探测，请先在前端管理界面启用。

---

## 与前端 API 的关系

远程探测 API（`/api/remote-probe/*`）是对现有模型探测 API（`/api/model-probe/*`）的简化封装：

| 远程 API | 对应的前端 API | 主要差异 |
|---------|---------------|---------|
| `GET /remote-probe/targets` | `POST /model-probe/preview` | 轻量化输出，不包含 Key 详情 |
| `POST /remote-probe/run` | `POST /model-probe/run` | 自动等待小任务，只返回可用结果 |
| `GET /remote-probe/status/:id` | `GET /api/tasks/:id` + `/model-probe/results` | 合并任务状态和探测结果 |

如需完整功能（如查看所有状态、按 Key 过滤、导出结果等），请使用前端管理界面或直接调用 `/api/model-probe/*` 接口。

---

## 更新日志

**v1.0.0** (2026-09-18)
- 初始版本
- 支持目标查询、探测触发、状态轮询
- 小范围探测自动同步等待
- 只返回可用模型，减少 Telegram 消息长度
