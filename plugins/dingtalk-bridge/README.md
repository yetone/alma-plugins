# DingTalk Bridge for Alma

把钉钉机器人接成 Alma 的聊天渠道。消息进来后驱动**完整 agent**（工具、技能、项目工作区、记忆），回复推回钉钉。

> 遵循 [alma-plugins](https://github.com/yetone/alma-plugins) 官方约定：`main.js` 预打包自包含，安装时**不需要 `npm install`**（同 `cursor-auth` / `openai-codex-auth`）。

## 为什么是这套方案

Alma 的渠道是硬编码的（`telegram` / `discord` / `feishu` / `lark` / `weixin`），插件没有 `channels.register()`。所以本插件走替代路径：

```
钉钉群 / 单聊
   │  机器人消息
   ▼
钉钉 Stream 网关（WebSocket 长连，无需公网 IP / 内网穿透）
   │  dingtalk-stream SDK
   ▼
dingtalk-bridge（本插件）
   ├─ 去重（msgId 缓冲 5 分钟）
   ├─ 授权校验（allowedStaffIds）
   ├─ 会话 → 线程映射（storage.local 持久化）
   ├─ 群内命令
   ▼  ws://127.0.0.1:<port>/ws/threads
      { type:"generate_response", data:{ threadId, model, userMessage, ephemeralContext, source:"dingtalk" } }
   ▼
Alma Agent
   ├─ 完整工具循环（Bash / Read / Write / 技能 …）
   ├─ 绑定本地项目工作区 ← 与项目交互在这里
   ▼  message_delta(deltas[]) → generation_completed
   ▼
回推 sessionWebhook（流式分段）
```

**关键点**：`POST /api/chat/completions` 只是裸 LLM 代理，不跑工具循环；只有 WebSocket 的 `generate_response` 才触发完整 agent turn。

## 安装

```bash
mkdir -p ~/.config/alma/plugins/dingtalk-bridge
cp -R manifest.json main.js lib cmd README.md ~/.config/alma/plugins/dingtalk-bridge/
```

重启 Alma，或到 **设置 → 插件** 点刷新。

`main.js` 已内联全部依赖（约 640 KB，仅依赖 Node 内置模块），无需 `npm install`。

### 从源码构建

```bash
npm install
npm run build     # bun build main.ts --outfile main.js --target node --format esm
```

## 钉钉侧准备

1. [钉钉开放平台](https://open-dev.dingtalk.com/) 创建**企业内部应用**
2. 添加**机器人**能力，消息接收模式选 **Stream 模式**（不要选 HTTP 回调）
3. 记下 `AppKey` / `AppSecret` / `RobotCode`
4. 申请权限：`机器人发送消息`、`机器人接收消息`
5. 发布应用，把机器人拉进群或开启单聊

Stream 模式不需要公网地址，这点对本地运行的 Alma 很关键。

## 配置

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `clientId` | — | 钉钉 AppKey |
| `clientSecret` | — | 钉钉 AppSecret |
| `robotCode` | 空 | 留空则沿用 clientId |
| `almaApiPort` | 23001 | Alma 本地 API 端口 |
| `defaultModel` | 空 | `providerId:modelId`，留空跟随 Alma 默认模型 |
| `workspaceId` | 空 | 绑定哪个本地项目，留空跟随默认工作区 |
| `mode` | `per-chat` | `per-chat` / `per-sender` / `single` |
| `allowedStaffIds` | 空 | 白名单，逗号分隔，留空不限制 |
| `streamingReply` | `true` | 边生成边分段推送 |
| `replyOnToolUse` | `true` | 用工具时先推「正在使用 xxx…」 |

## 群内命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 帮助 |
| `/new [标题]` | 开新会话 |
| `/stop` | 停止当前生成 |
| `/status` | 桥接状态 |
| `/ws` | 列出可绑定工作区 |
| `/use <id>` | 给当前会话换绑工作区并新建线程 |

## 会话模式

- `per-chat`（默认）：一个群/单聊一个线程，群内共享上下文
- `per-sender`：群里每人各自一条线程
- `single`：全部共用一个线程

映射存在 `storage.local` 的 `dingtalkSessions` 键下，重启不丢。改 `mode` 后旧映射不自动迁移，用 `/new` 重置。

## 插件接口

除了钉钉命令，还注册了：

**命令面板**
- `钉钉桥接：查看状态`
- `钉钉桥接：重连`
- `钉钉桥接：清空会话映射`
- `钉钉桥接：连通性自检`

**状态栏**：右侧显示 `● 钉钉 N`（● 已连 / ○ 未连 / $(plug) 未启动），tooltip 含启动时间、最近消息、会话数。

**AI 工具**：`dingtalk_notify(staffId, message)` — 让 AI 主动给指定钉钉用户发消息（需要 AppKey/AppSecret）。

## 命令行发送

```bash
node cmd/send.mjs <staffId> "消息内容"
```

复用插件已配置的凭据。

---

## 测试

### 纯逻辑单测（无需 Alma）

```bash
bun test/unit.mjs
```

覆盖消息分段与流式截取的边界情况。

### 端到端（需要 Alma 运行）

```bash
ALMA_DT_SELFTEST=1 bun test/inbound.mjs
```

起一个假钉钉 webhook 服务器，构造伪造下游消息喂给插件内部处理函数，验证全链路。

实测输出：

```
[e2e] ▶ 普通文本回复           → "钉钉入站 OK"                      ✅
[e2e] ▶ 工具调用 + 项目目录感知  → "🔧 正在使用 Bash…\ndocker"        ✅
[e2e] ▶ 命令 /status           → "📊 DingTalk Bridge 状态 …"        ✅
[e2e] ▶ 命令 /ws 列出工作区     → "📁 可用工作区 …"                  ✅
[e2e] ▶ 重复消息去重            → 首次 1 条，重复后新增 0 条          ✅
结果 5/5 通过
```

第二个用例证明 agent 确实在**绑定的项目目录**里执行了命令。

## 已知限制

| 限制 | 说明 |
| --- | --- |
| **依赖内部 WS 协议** | `generate_response` / `stop_generation` / `message_delta` 均无公开文档，Alma 升级可能改。官方若开放 `channels.register()` 应尽快迁移。 |
| **图片不支持** | 钉钉图片消息只回提示，未接 `media/download`。 |
| **文件不回传** | agent 生成的文件只在回复里给路径，未走钉钉 `media/upload`。 |
| **端口需手填** | 插件拿不到 Alma 端口，只能靠配置。 |
| **串行处理** | 同一时刻只处理一条入站消息，避免并发写同一线程。多群之间靠队列自然排队。 |

## 迁移到官方渠道 API 的成本

若 Alma 后续开放渠道 API，只需改两处：

- `lib/alma-socket.ts` 的 `submit()` → `context.channels.submit()`
- 建线程/映射 → 交给运行时 `resolveThread()`

`lib/bridge.ts` 里的钉钉解析、命令、分段推送可原样保留。
