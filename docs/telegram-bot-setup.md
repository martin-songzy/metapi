# Telegram Bot 配置指南

本指南说明如何在 n8n 中配置 MetAPI 探测机器人。

---

## 前置条件

- ✅ n8n 实例可访问（你的：https://n8n.freetcp.dpdns.org）
- ✅ MetAPI 服务已部署（https://metapi-krj9.onrender.com）
- ✅ Telegram Bot Token（@MM_OClaw_bot）
- ✅ 管理员 Telegram User ID（493325033）

---

## 步骤 1：在 n8n 中配置凭据

### 1.1 添加 Telegram Bot 凭据

1. 打开 n8n，点击右上角 **齿轮图标** → **Credentials**
2. 点击 **New** → 搜索 **Telegram**
3. 选择 **Telegram API**
4. 填入以下信息：
   - **Credential Name**: `MM_OClaw_bot`
   - **Access Token**: `8680016700:AAE2DwDZQWiRl6nsr74YSD_n9PzDIc2FRGI`
5. 点击 **Save**

### 1.2 添加 MetAPI HTTP 认证凭据

1. 在 Credentials 页面点击 **New**
2. 搜索并选择 **Header Auth**
3. 填入以下信息：
   - **Credential Name**: `MetAPI Auth`
   - **Name**: `Authorization`
   - **Value**: `Bearer <你的AUTH_TOKEN>`
     - 从 MetAPI 的 `.env` 文件获取 `AUTH_TOKEN` 值
     - 格式：`Bearer test-admin-token`（如果你用的是默认 token）
4. 点击 **Save**

---

## 步骤 2：导入 Workflow

### 方法 A：导入 JSON 文件（推荐）

1. 下载 `docs/telegram-bot-workflow.json`
2. 在 n8n 中点击 **Workflows** → **Import from File**
3. 选择下载的 JSON 文件
4. 点击 **Import**

### 方法 B：手动创建（如果导入失败）

1. 创建新 Workflow
2. 按照下方的"节点配置详解"逐个添加节点
3. 连接各节点

---

## 步骤 3：配置节点凭据

导入后，需要为每个节点关联凭据：

### 3.1 Telegram Trigger 节点

- 点击节点
- **Credential to connect with** 选择 `MM_OClaw_bot`
- **Updates** 选择 `message`

### 3.2 所有 Telegram 发送消息节点

以下节点都需要选择 `MM_OClaw_bot` 凭据：
- "未授权回复"
- "探测开始提示"
- "发送探测结果"
- "发送站点列表"
- "发送状态"
- "帮助信息"
- "未知命令回复"

### 3.3 所有 HTTP Request 节点

以下节点都需要选择 `MetAPI Auth` 凭据：
- "调用探测API"
- "获取站点列表"
- "查询任务状态"

---

## 步骤 4：激活 Workflow

1. 确认所有节点都已配置凭据
2. 点击右上角的开关，激活 Workflow
3. n8n 会自动向 Telegram 注册 Webhook

---

## 步骤 5：测试机器人

打开 Telegram，搜索 `@MM_OClaw_bot`，发送以下命令测试：

### 测试命令

```
/start
```
应该收到欢迎信息和命令列表

```
/targets
```
应该收到可探测的站点列表

```
/probe all
```
触发全站点探测（**会消耗真实配额！**）

```
/probe 1,2,3
```
探测指定站点（将 1,2,3 替换为实际站点 ID）

---

## 命令说明

| 命令 | 功能 | 示例 |
|------|------|------|
| `/start` | 显示欢迎信息和帮助 | `/start` |
| `/help` | 显示帮助信息 | `/help` |
| `/targets` | 查看可探测的站点列表 | `/targets` |
| `/probe all` | 探测所有站点 | `/probe all` |
| `/probe <ids>` | 探测指定站点 | `/probe 1,2,3` |
| `/status <taskId>` | 查询异步任务状态 | `/status task_abc123` |

---

## Workflow 结构说明

```
Telegram 消息
  ↓
权限检查（只允许 User ID 493325033）
  ↓ 通过
提取命令（解析命令和参数）
  ↓
命令路由（Switch 节点）
  ├─ /probe → 调用探测 API → 格式化结果 → 回复
  ├─ /targets → 获取站点列表 → 格式化 → 回复
  ├─ /status → 查询任务状态 → 格式化 → 回复
  ├─ /start 或 /help → 发送帮助信息
  └─ 其他 → 发送"未知命令"提示
```

---

## 节点配置详解

### 1. Telegram Trigger（入口）

**类型**: `n8n-nodes-base.telegramTrigger`

**配置**:
- Updates: `message`
- Credential: `MM_OClaw_bot`

**输出**: Telegram 消息对象（包含 `message.text`, `message.chat.id`, `message.from.id` 等）

---

### 2. 权限检查（IF 节点）

**类型**: `n8n-nodes-base.if`

**配置**:
- Condition: `{{ $json.message.from.id }}` equals `493325033`
- True 输出 → 继续执行
- False 输出 → "未授权回复"节点

**目的**: 只允许你自己使用机器人

---

### 3. 提取命令（Set 节点）

**类型**: `n8n-nodes-base.set`

**配置**:
提取三个字段：
- `command`: `{{ $json.message.text.split(' ')[0] }}`（如 `/probe`）
- `args`: `{{ $json.message.text.split(' ').slice(1).join(' ') }}`（如 `all` 或 `1,2,3`）
- `chatId`: `{{ $json.message.chat.id }}`

**目的**: 简化后续节点的数据访问

---

### 4. 命令路由（Switch 节点）

**类型**: `n8n-nodes-base.switch`

**配置**:
根据 `{{ $json.command }}` 路由到不同分支：
- 输出 0: `/probe` → 探测分支
- 输出 1: `/targets` → 站点列表分支
- 输出 2: `/status` → 状态查询分支
- 输出 3: `/start` → 帮助信息
- 输出 4: `/help` → 帮助信息
- Fallback: 其他 → 未知命令

---

### 5. 探测分支（/probe）

#### 5.1 探测开始提示
发送 "⏳ 正在探测，请稍候..."

#### 5.2 调用探测API（HTTP Request）
**配置**:
- Method: `POST`
- URL: `https://metapi-krj9.onrender.com/api/remote-probe/run`
- Authentication: `Header Auth` → `MetAPI Auth`
- Body:
  ```json
  {
    "siteIds": "{{ $json.args || 'all' }}",
    "waitForCompletion": true,
    "timeout": 300000
  }
  ```

#### 5.3 格式化探测结果（Code 节点）
将 API 响应转换为 Telegram 消息格式：
- 同步完成：显示统计 + 前 10 个可用模型
- 异步执行：显示任务 ID 和查询提示
- 失败：显示错误信息

#### 5.4 发送探测结果
回复格式化的消息

---

### 6. 站点列表分支（/targets）

#### 6.1 获取站点列表（HTTP Request）
**配置**:
- Method: `GET`
- URL: `https://metapi-krj9.onrender.com/api/remote-probe/targets?summary=false`
- Authentication: `Header Auth` → `MetAPI Auth`

#### 6.2 格式化站点列表（Code 节点）
将站点数组转换为可读的列表格式

#### 6.3 发送站点列表
回复格式化的站点列表

---

### 7. 状态查询分支（/status）

#### 7.1 提取任务ID（Code 节点）
从 `args` 提取任务 ID，验证是否为空

#### 7.2 查询任务状态（HTTP Request）
**配置**:
- Method: `GET`
- URL: `https://metapi-krj9.onrender.com/api/remote-probe/status/{{ $json.taskId }}`
- Authentication: `Header Auth` → `MetAPI Auth`

#### 7.3 格式化状态（Code 节点）
根据任务状态格式化消息：
- running: 显示进度
- completed: 显示完整结果
- failed: 显示错误

#### 7.4 发送状态
回复格式化的状态信息

---

## 常见问题

### Q1: 导入 JSON 后节点显示错误

**A**: 凭据未关联。逐个点击红色节点，选择对应的凭据。

---

### Q2: 激活 Workflow 后机器人不响应

**A**: 检查以下几点：
1. Telegram Trigger 是否已激活（开关打开）
2. n8n 能否访问公网（Webhook 需要 Telegram 能回调）
3. Bot Token 是否正确
4. 用其他 User ID 测试是否收到"未授权访问"提示

---

### Q3: HTTP Request 节点报 401 错误

**A**: `MetAPI Auth` 凭据的 Token 不正确。检查：
1. 是否包含 `Bearer ` 前缀（注意空格）
2. Token 是否与 MetAPI 的 `.env` 文件中的 `AUTH_TOKEN` 一致

---

### Q4: 探测命令超时

**A**: 
1. 检查 MetAPI 服务是否在线（访问 https://metapi-krj9.onrender.com/health）
2. Render 免费版冷启动需要时间，第一次请求可能慢
3. 大范围探测会返回任务 ID，不会同步等待

---

### Q5: 如何添加更多授权用户

**A**: 修改"权限检查"节点：
1. 点击"权限检查"节点
2. 将 `493325033` 改为逗号分隔的多个 ID：`493325033,123456789`
3. 或者改用 Code 节点，从环境变量读取白名单

---

### Q6: 如何自定义消息格式

**A**: 修改对应的 Code 节点（如"格式化探测结果"），调整 `message` 字符串的内容和格式。

---

## 安全注意事项

1. **不要公开 Bot Token**：泄露后任何人都可以冒充你的机器人
2. **不要公开 AUTH_TOKEN**：它能调用 MetAPI 的所有管理接口
3. **权限检查必须保留**：删除权限检查节点会让任何人都能使用
4. **谨慎使用探测命令**：每次探测都会消耗上游账号的真实配额

---

## 扩展功能建议

### 添加探测结果通知

在"发送探测结果"后添加：
- 写入 Google Sheets（记录探测历史）
- 发送邮件通知（大范围探测完成时）
- 调用 Webhook（触发其他自动化）

### 添加定时探测

创建新 Workflow：
- Trigger: Cron（如每天 9:00）
- 调用 MetAPI 探测 API
- 发送结果到指定 Telegram Chat

### 添加交互式按钮

使用 Telegram 的 Inline Keyboard：
- 在"发送站点列表"后添加按钮
- 用户点击按钮直接触发探测
- 需要处理 `callback_query` 类型的消息

---

## 维护建议

1. **定期检查 Workflow 状态**：在 n8n 的 Executions 页面查看执行历史
2. **监控 MetAPI 服务**：确保 Render 服务在线
3. **备份 Workflow**：定期导出 JSON 文件保存
4. **测试新功能**：在测试环境先验证再上生产

---

## 更新日志

**v1.0.0** (2026-09-18)
- 初始版本
- 支持 `/probe`、`/targets`、`/status`、`/help` 命令
- 单用户权限控制
- 自动路由同步/异步探测
