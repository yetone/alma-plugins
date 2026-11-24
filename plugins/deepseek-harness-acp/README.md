# DeepSeek Harness (ACP) — Alma 插件

把本机 **DeepSeek Harness（`dsh`）** 注册成 Alma 的 **ACP provider**。安装后可在
模型选择器里选 `DeepSeek Harness (ACP) : default`。

插件不是“看到文件就写配置”，而是：

1. 找到 `dsh` 候选；
2. 真跑 `dsh --profile acp` 并完成 ACP `initialize` 握手；
3. 不存在时创建；仅对插件精确命名的已有条目自动对齐；
4. 调 Alma `/test` 做真实连接测试；
5. 保证模型列表非空。

## 0.2.1 重点

- 插件停用/Refresh 会取消后台流程、销毁进行中的 HTTP 请求并杀掉 probe 子进程；
  `dispose()` 最多等待约 3 秒。
- 跨实例锁带 PID + nonce，持锁期间每 30 秒刷新 mtime；PID 活着时绝不接管。
- `DELETE` 回滚失败会重试，仍失败则 `PUT enabled:false`，不再谎报“已回滚”。
- POST 成功但响应没有 id/不是 JSON 时，按名称反查 provider 继续验证。
- 模型设置失败不再把已成功的注册判失败，只提示手动添加模型。
- 不再覆写用户手工配置的 `acpCommand` / `acpArgs`，模糊匹配条目只识别不修改。
- `ECONNRESET` 不再重试；请求 body 写出后一律不重试，避免重复创建。

## 插件结构

```text
deepseek-harness-acp/
├── manifest.json
├── main.js
├── package.json
├── README.md
├── NOTES.md
├── LICENSE
└── tests/
    ├── run-tests.mjs          # mock Alma + fake dsh，36 条
    ├── acp-direct.mjs         # 无第三方依赖的 ACP 客户端
    └── integration-real.mjs   # 真实 Alma / dsh / prompt
```

## 安装

```bash
mkdir -p ~/.config/alma/plugins/deepseek-harness-acp
cp -R manifest.json main.js package.json README.md NOTES.md LICENSE tests \
  ~/.config/alma/plugins/deepseek-harness-acp/
```

然后重启 Alma，或打开 **设置 → 插件** 点 **Refresh**。

`main.js` 是 ESM，目录里必须有 `package.json`（`"type": "module"`）。

### 权限

| 权限 | 用途 |
|------|------|
| `notifications` | 注册成功、需要处理或锁冲突时提示 |
| `filesystem:read` | 读取 `~/.config/alma/api-spec.md` 与检查 dsh 可执行文件 |

`fs` / `child_process` 在 Alma 0.4.x 没有权限门禁。`permissions` 目前只是提示，
不会限制插件实际能力；插件也不需要浏览器式的 `network:fetch`。
`activationEvents` 在 Alma 0.4.x 是装饰字段，provider 插件加载后仍由 Alma 调用
`activate`。

## 工作方式

1. **找候选**：
   1. `DSH_PATH`（显式指定，只认它，不静默回退）；
   2. macOS 应用内置 dsh；
   3. `which -a dsh` 的全部 PATH 版本。
2. **握手验证**：每个候选 spawn 一次，15 秒超时；收到 `initialize.result` 后
   再观察 300ms，排除握手后立即崩溃的二进制。子进程只继承
   `PATH/HOME/LANG/TERM/NO_COLOR/DSH_*`，不会拿到其他 provider 的 API key。
3. **锁**：`~/.config/alma/deepseek-harness-acp.lock`，文件模式 `0600`。
   内容为 `{pid, nonce}`，30 秒心跳。只有 mtime 超过 30 分钟且 PID 已不存在时
   才通过 rename 接管；释放前校验 nonce，绝不删其他实例的锁。
4. **创建/对齐**：
   - 没有匹配 → 创建前再次 `GET /api/providers` 复查，然后 POST；
   - 新建时先 `enabled:false`，连接测试和模型步骤收尾后才 `PUT enabled:true`；
     即使 POST 响应不可解析且反查失败，也不会留下 enabled 的僵尸条目；
   - 精确名称 `DeepSeek Harness (ACP)` → 仅在命令文件不存在/不可执行时纠正命令，
     并在连接测试通过后自动启用；
   - 模糊名称或手工命名条目 → 只识别和测试，不改命令、参数、启用状态或模型。
5. **连接测试**：新建的失败先 DELETE（3 次退避重试）；仍失败则禁用并通知。
   已有 provider 测试失败不会删除。
6. **模型**：空列表时尝试 `/models/fetch`，再 PUT 兜底 `default`。这一步失败只
   警告“provider 已就绪但模型列表为空”，不会把注册整体判失败。

## 配置项

| 变量 | 作用 |
|------|------|
| `DSH_PATH` | 指定 dsh，跳过自动候选 |
| `ALMA_API_PORT` | 覆盖 Alma 本地 API 端口；非法值会 warn 并回退到 api-spec/23001 |
| `ACP_PROMPT_TIMEOUT_MS` | 集成脚本直连 ACP prompt 的超时，默认 `180000` |

API 端口只从 `~/.config/alma/api-spec.md` 的 `Base URL` 行读取，不会误抓文档里
其他 `localhost:端口`。

## 测试

默认测试不碰真实 Alma/dsh：

```bash
node tests/run-tests.mjs
# 或
npm test
```

覆盖 36 条场景：16 条原有场景 + dispose 取消、活跃锁超过 120 秒、锁归属、
握手后崩溃、stdin EPIPE、POST 无 id/非 JSON、DELETE 500、模型 PUT 500、
创建结果彻底不可查时保持 disabled、非 Alma 服务、自愈、无 dsh 不误删等。mock 只替换 Node `http.request`，
请求构造、状态机、重试和响应解析仍走 `main.js` 的真实代码；dsh 使用临时 fake
可执行文件。

仅跳过 120 秒长锁测试：

```bash
SKIP_LONG_LOCK_TEST=1 node tests/run-tests.mjs
```

### 真实链路

先启动 Alma，再运行：

```bash
DSH_PATH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  node tests/integration-real.mjs
```

脚本会：

1. 调插件完成真实注册/对齐；
2. 断言精确名称条目唯一；
3. 调真实 `POST /api/providers/:id/test`；
4. 用 provider 实际的 `acpCommand` / `acpArgs` 直连 ACP：
   `initialize → session/new → session/prompt`，累积
   `session/update.agent_message_chunk`，要求回复包含 `ACP-LIVE-OK`。

前三步需要 Alma 本地 API；第 4 步的 prompt 验证不经过 loopback，也不依赖
`/api/chat/completions`。
脚本不会删除已有 provider。

成功时会在 stdout 输出 `summary.ok=true`，其中 `prompt.transport="acp-direct"`、
`prompt.stopReason="end_turn"`，且 `prompt.content` 包含 `ACP-LIVE-OK`；同时写入
`tests/real-last-run.json`。

### Alma REST prompt 限制

Alma 0.4.x 的 `POST /api/chat/completions` 当前不能作为 ACP provider 的 prompt
验收口径，实测：

| 请求 | 实际结果 |
|------|----------|
| 不带 `threadId` | HTTP 500：`Thread ID is required for ACP provider` |
| 带 `threadId` | HTTP 400：`Invalid prompt: messages must not be empty`；AI SDK 校验前 `messages` 已被转换清空 |
| `stream:true` + `threadId` + system/user 两条消息 | HTTP 200，约 0.6 秒结束，但 delta 为空，没有真实模型输出 |

作为对照，`codex-acp:default` 使用同一 endpoint/body 会等待真实 agent（60 秒超时）。
这说明该 endpoint 对 ACP provider 的行为并不一致，因此本插件的真机 prompt 验收改为
上面的直连 ACP；这不改变 `/api/providers/:id/test` 的真实连接测试。

## 手动验证

```bash
# 精确名称的 provider 应只有一个
curl -s http://127.0.0.1:23001/api/providers \
  | jq '[.[] | select(.type=="acp" and .name=="DeepSeek Harness (ACP)")] | length'

# 连接测试
ID=$(curl -s http://127.0.0.1:23001/api/providers \
  | jq -r '.[] | select(.type=="acp" and .name=="DeepSeek Harness (ACP)") | .id')
curl -s -X POST http://127.0.0.1:23001/api/providers/$ID/test

# 真发 prompt：绕过 /api/chat/completions，直连 provider 的 acpCommand
DSH_PATH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  node tests/integration-real.mjs

# 插件日志
grep "Plugin:deepseek-harness-acp" \
  "$HOME/Library/Application Support/Alma/logs/native.log" | tail -20
```

## 常见问题

| 现象 | 处理 |
|------|------|
| 未检测到可用的 dsh | 安装 DeepSeek Harness，确认 `which dsh`，或用 `DSH_PATH` |
| 某候选“进程提前退出” | 该二进制本身不可用（常见于缺原生绑定的 npm 全局版） |
| 另一个实例正在注册 | Refresh 时旧实例还在收尾；插件会在锁释放后重试，超时则本次跳过 |
| 连接测试失败，DELETE 未成功 | provider 已被禁用，按通知里的 id 到设置手动删除 |
| provider 已就绪但模型为空 | 手动添加模型；连接本身已通过 |
| 模糊匹配条目没被修改 | 这是有意行为；要自动管理请使用精确名称 |
| Refresh 后无反馈但 provider 已创建 | 0.2.1 起 dispose 会取消旧流程；若仍复现请附日志 |

## 卸载

```bash
rm -rf ~/.config/alma/plugins/deepseek-harness-acp
```

卸载不会删除 provider。插件只会在**本次新建且连接测试失败**时删除或禁用该
新条目；已有 provider 和额外匹配项都不会被删除。
