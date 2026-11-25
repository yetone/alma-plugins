# NOTES — 0.2.1 实现、测试与限制

版本 0.2.1，Alma 0.4.x，dsh 0.2.2-rc.1。

## 本版修复

| 编号 | 修复 |
|------|------|
| B1 | `dispose()` 设置取消状态，销毁在途 HTTP 请求并 kill 探测子进程；后台流程在每个 await 后检查取消。`dispose()` 最多等 3 秒，取消后不再 POST/PUT/notify。 |
| B2 | 锁移到 `~/.config/alma/`，持锁每 30 秒心跳；30 分钟 stale 阈值仍要求持锁 PID 不存在才接管；创建前再次读 provider 列表。 |
| B3 | 锁内容为 `{pid, nonce, at}`，释放前校验 nonce；接管通过 rename 原子移走旧锁。 |
| M1 | 可重试错误仅 `ECONNREFUSED/ENOTFOUND/EAI_AGAIN/EHOSTUNREACH/ENETUNREACH`；body 写出后不重试，`ECONNRESET` 不再重试。 |
| M2 | DELETE 回滚 3 次退避重试；仍失败则 PUT `enabled:false`，通知含 provider id。 |
| M3 | 新建先 `enabled:false`；POST 无 id / 非 JSON 时按精确名称反查最新一条，找不到时保持禁用并明确告警。 |
| M4 | `ensureModels` 内部吸收失败，返回 `{ok:false}`；只提示手动添加模型，不影响注册状态。 |
| M5 | 只对精确名称条目做自动修正；命令可执行时不覆盖命令/参数；模糊匹配只发现和测试。 |
| M6 | probe 监听 stdin/stdout/stderr error，输出限长，写入/稳定性 timer 在 finish 清理；300ms 稳定性窗口排除握手后崩溃。 |
| m1 | manifest 权限改为 `notifications` + `filesystem:read`。 |
| m2 | probe 环境改为白名单，不继承完整 `process.env`。 |
| m3 | 日志、stderr 尾巴、errorDetail、通知统一脱敏；通知只保留固定话术和 provider id。 |
| m5 | 端口只认锚定 `Base URL` 行；`ALMA_API_PORT` 非法时 warn。 |
| m6 | 只在首次创建或实际修正配置时发通知；普通幂等启动静默。 |
| m7 | README/NOTES 与实现对齐，tests 补回包内。 |
| m8 | 锁文件在 Alma 配置目录、`0600`；获取失败通知“另一实例正在注册，本次跳过”。 |

## 测试结果

`node tests/run-tests.mjs`：见本目录 `tests/last-run.json` 和最后一次终端输出。

- 默认测试使用 **in-memory mock `http.request`** + **fake dsh 可执行文件**。
  不访问真实 Alma，不修改真实 provider 数据库。
- mock 只替换传输层；`main.js` 的 URL/请求构造、重试、JSON 解析、锁和状态机
  都走真实代码。
- 120 秒长锁测试默认包含；`SKIP_LONG_LOCK_TEST=1` 可跳过它做快速回归。

真实链路用：

```bash
DSH_PATH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  node tests/integration-real.mjs
```

它会验证精确名称 provider 唯一、真实 `/test`，再对 provider 实际的
`acpCommand` / `acpArgs` 直连执行 `initialize → session/new → session/prompt`。prompt 的
文本来自 `session/update.agent_message_chunk`，必须包含 `ACP-LIVE-OK`。结果会
单独记录，不能由 mock 测试代替。注册和 `/test` 需要 Alma 本地 API；直连
prompt 本身不经过 loopback。

### 0.2.1 发布前验证记录

- 2026-11-20：`node tests/run-tests.mjs` 为 **36/36 PASS**，总耗时 142.8 秒；
  120 秒长锁用例实际 121.475 秒通过；stdin EPIPE 用例 1.3 秒内命中真实 EPIPE
  且无未捕获异常。机器可读结果见 `tests/last-run.json`。
- `tests/acp-direct.mjs` 对临时 ACP stub 的协议冒烟通过：正确完成
  `initialize → session/new → session/prompt`，从 `agent_message_chunk` 得到
  `ACP-LIVE-OK` 和 `end_turn`。
- 沙箱外实机预验证（用户执行，`DSH_PATH` 指向 app 内 dsh）：注册成功；
  `DeepSeek Harness (ACP)` 精确名唯一 1 条、`enabled=true`、
  `models=["default"]`；两次 `/test` 分别通过（643ms / 590ms），插件日志确认
  使用 `DSH_PATH` 指向的 app 内 dsh。
- 完整实机验收（`2026-11-19T17:21:18.266Z`，用户执行；结果见
  `tests/real-last-run.json`）：provider id 为 `mwmsystjt29tfz9r4zk`、
  `status="existing"`，精确名称仍唯一 1 条且 `enabled=true`、
  `models=["default"]`；插件注册流程和脚本重测的两次 `/test` 分别通过
  （662ms / 597ms）；直连 ACP 完成 `initialize`（agent
  `deepseek-harness-acp 0.0.1`、protocol 1）和
  `session/new`（session id `15d1a24b-a1a7-4a25-b76f-1ce82f546668`），
  `session/prompt` 返回 `stopReason="end_turn"`，文本为 `ACP-LIVE-OK`，
  整体 `summary.ok=true`。
- 同一实机的 `POST /api/chat/completions` 不能作为 ACP prompt 验收：
  - 不带 `threadId`：500 `Thread ID is required for ACP provider`；
  - 带 `threadId`：400 `Invalid prompt: messages must not be empty`，AI SDK
    校验前 `messages` 已被转换清空；
  - `stream:true` + `threadId` + system/user 两条消息：200，约 0.6 秒结束，
    delta 为空，没有真实模型输出。
  - 对照 `codex-acp:default` 使用同一 endpoint/body 会等待真实 agent（60 秒
    超时），说明该 endpoint 对 ACP provider 的行为不一致。
- 因此 0.2.1 的真机 prompt 验收改为直连 ACP（`tests/acp-direct.mjs`），并已按
  上述完整实机结果通过；`tests/real-last-run.json` 是本次验收的机器可读记录。
- 只读检查 Alma 数据库时，精确名称 provider 仍只有 1 条且为 enabled；
  `plugins` 表仍记录旧版本 `0.1.0`，Alma 需要 Refresh 才会刷新插件元数据。

## 设计说明

### 取消

每次 `activate` 创建独立状态，包含：

- `cancelled`
- 在途 HTTP request 的 `destroy` 集合
- probe 子进程的 cancel 集合
- 当前锁 handle

`dispose()` 先同步置取消并清理资源，再 `Promise.race` 后台 promise 与 3 秒定时器。
后台流程若在取消后拿到错误，只返回 `{status:'cancelled'}`，不发通知。取消发生
在新建 provider 与测试之间时，不回滚（避免 dispose 后继续写 API）；下一次激活
会把该条目作为已有 provider 自愈。

### 锁

锁格式：

```json
{"pid":12345,"nonce":"uuid","at":1760000000000}
```

- 创建：`open(..., "wx", 0600)`。
- 心跳：对持锁 fd 做 `futimes`，并校验 fd 与路径 inode 一致。
- stale：先读锁内 PID；`kill(pid,0)` 活着就绝不抢；PID 不存在且 mtime 超过
  30 分钟才接管。
- 接管：rename 到 quarantine，校验 nonce 未变化，再创建新锁。
- 释放：重读路径内容，nonce 相同才 unlink。

30 分钟阈值是“明显大于常规最坏耗时”的兜底；正常长任务依靠 30 秒心跳，不靠
超时抢锁。

### 创建结果不确定

如果 POST 返回 201 但 body 不是 JSON 或没有 id，会最多 3 次按精确名称读取列表，
选 `createdAt/updatedAt` 最新的一条继续。新建请求本身使用 `enabled:false`，
只有连接测试及模型步骤收尾后才 `PUT enabled:true`。因此若 Alma 完全反查不到，
新条目仍保持禁用，插件只发固定告警，要求用户到设置检查。

### 自动修正边界

- 精确名称：`DeepSeek Harness (ACP)`。
- 模糊发现：名称含 `deepseek harness`，或 `acpCommand` 像 dsh。
- 精确名称且 `acpCommand` 不存在/不可执行：改到本次探测成功的 dsh，并补齐参数。
- 精确名称且命令可执行：不覆盖命令和参数；仅在连接测试通过后自动启用。
- 模糊条目：只做 `/test`，不 PUT、不 fetch/PUT models、不删除。

## 已知限制

1. ACP 只暴露一个 `default` 模型；具体底层模型由 dsh 决定。
2. 每次激活会 spawn dsh 握手，当前 300ms 稳定性窗口至少增加约 0.3 秒。
3. 如果 `dsh` 在握手 300ms 之后、实际对话前崩溃，只能由 `/test` 或真实请求发现。
4. Alma 若创建成功但既不给 id、又无法从列表反查，插件无法继续测试或启用，
   但新条目仍是 disabled，只能告警。
5. 插件不会清理已有或额外的匹配 provider；这是有意的数据保护。
6. Alma 0.4.x 对 `fs` / `child_process` 没有权限门禁，manifest `permissions`
   只是提示；`activationEvents` 也是装饰字段。
7. 锁以 PID 判活。PID 被系统复用且 mtime 又超过 30 分钟时理论上可能误判为活锁
   而继续等待；nonce 保证不会误删/覆盖别人的锁。

## 测试怎么跑

```bash
cd ~/.config/alma/plugins/deepseek-harness-acp
node tests/run-tests.mjs

# 快速回归，跳过 120 秒长锁测试
SKIP_LONG_LOCK_TEST=1 node tests/run-tests.mjs

# 真实 Alma + dsh + prompt
node tests/integration-real.mjs
```

`tests/last-run.json` 保存最近一次 mock 测试结果。真实测试会输出 JSON 摘要，但
不写 snapshot、不删除已有 provider。
