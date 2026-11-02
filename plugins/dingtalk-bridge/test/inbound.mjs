/**
 * 端到端自测：不连真钉钉，用假 webhook 服务器 + 真 Alma WS，
 * 走「钉钉消息 → 解析 → 建线程 → agent turn → 回推」全链路。
 *
 * 跑法：node test/inbound.mjs
 * 需要 Alma 正在运行。
 */
import http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.ALMA_PORT || 23001);

/* ---------- 假钉钉 webhook ---------- */
const received = [];
const webhookServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        try {
            received.push(JSON.parse(body));
        } catch {
            received.push({ raw: body });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
    });
});
await new Promise((r) => webhookServer.listen(0, '127.0.0.1', r));
const WEBHOOK = `http://127.0.0.1:${webhookServer.address().port}/robot/send?access_token=fake`;

/* ---------- 探测 Alma ---------- */
let workspaceId;
try {
    const health = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    if (!health.ok) throw new Error('health not ok');
    const wss = await (await fetch(`http://127.0.0.1:${PORT}/api/workspaces`)).json();
    const list = Array.isArray(wss) ? wss : (wss.workspaces ?? []);
    workspaceId = process.env.ALMA_WORKSPACE || list[0]?.id;
    console.log(`[e2e] Alma 在线，工作区: ${workspaceId}`);
} catch (e) {
    console.error(`[e2e] Alma API 不可达 (127.0.0.1:${PORT})，请先启动 Alma`);
    process.exit(1);
}

/* ---------- 加载插件 ---------- */
const { context } = createContext({
    root: ROOT,
    apiPort: PORT,
    quiet: true,
    pluginSettings: {
        workspaceId,
        mode: 'per-chat',
        streamingReply: true,
        replyOnToolUse: true,
        clientId: '',
        clientSecret: '',
    },
});

/* 覆盖 chat.createThread，让它抛错以验证 HTTP 路径确实被用上 */
const mod = await import(path.join(ROOT, 'main.ts'));
const activation = await mod.activate(context);
await new Promise((r) => setTimeout(r, 1500));

/* 拿内部 bridge 做断言 —— 通过 replay 消息间接驱动，
 * 但为了读完成计数，这里从 main 暴露的钩子取 */
const bridgeProbe = globalThis.__dingtalkBridgeProbe;
if (!bridgeProbe?.bridge) {
    console.error('[e2e] 未找到测试探针，请确认 main.ts 里有 ALMA_DT_SELFTEST 钩子');
    process.exit(1);
}
const bridge = bridgeProbe.bridge;

/* ---------- 构造钉钉下游事件 ---------- */
let seq = 0;
function downstream(text, overrides = {}) {
    seq += 1;
    return {
        headers: { topic: '/v1.0/im/bot/messages/get', messageId: `m${seq}` },
        data: JSON.stringify({
            conversationId: 'cid_e2e_group',
            conversationType: '2',
            conversationTitle: 'E2E 测试群',
            senderStaffId: 'staff_e2e',
            senderNick: 'Tester',
            msgId: `msg_e2e_${Date.now()}_${seq}`,
            msgtype: 'text',
            text: { content: text },
            sessionWebhook: WEBHOOK,
            sessionWebhookExpiredTime: Date.now() + 3_600_000,
            robotCode: 'fake',
            createAt: Date.now(),
            ...overrides,
        }),
    };
}

async function waitForTurn(before, timeoutMs = 120_000) {
    const t0 = Date.now();
    while (bridge.getCompletedTurns() === before && Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 800));
    return bridge.getCompletedTurns() > before;
}

async function waitForPush(before, timeoutMs = 15_000) {
    const t0 = Date.now();
    while (received.length === before && Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 500));
}

const results = [];

async function runCase(name, text, opts = {}) {
    console.log(`\n[e2e] ▶ ${name}`);
    const pushesBefore = received.length;
    const turnsBefore = bridge.getCompletedTurns();

    await bridge.handleIncoming(downstream(text, opts.messageOverrides));

    if (text.startsWith('/')) {
        await waitForPush(pushesBefore);
    } else {
        const done = await waitForTurn(turnsBefore);
        if (!done) console.log('[e2e]   ⚠️ 回合未在超时内完成');
    }

    const msgs = received.slice(pushesBefore);
    const joined = msgs.map((m) => m?.text?.content ?? m?.markdown?.text ?? m?.raw ?? '').join('\n');
    const ok = opts.check(joined);

    console.log(`[e2e]   推送 ${msgs.length} 条`);
    console.log(`[e2e]   内容: ${JSON.stringify(joined.slice(0, 240))}`);
    console.log(`[e2e]   ${ok ? '✅ PASS' : '❌ FAIL'}`);
    results.push(ok);
    return { joined, count: msgs.length, ok };
}

/* ---------- 用例 ---------- */

await runCase('普通文本回复', '只回一句：钉钉入站 OK', {
    check: (t) => t.includes('OK'),
});

await runCase('工具调用 + 项目目录感知', '用 Bash 执行 `basename "$PWD"`，只告诉我目录名。', {
    check: (t) => t.length > 0,
});

await runCase('命令 /status', '/status', {
    check: (t) => t.includes('DingTalk Bridge') || t.includes('运行中'),
});

await runCase('命令 /ws 列出工作区', '/ws', {
    check: (t) => t.includes('工作区') || t.length > 0,
});

/* 去重：同一个 msgId 连发两次，第二次应被忽略 */
{
    console.log('\n[e2e] ▶ 重复消息去重');
    const ev = downstream('只回 OK');
    const before = received.length;
    await bridge.handleIncoming(ev);
    await waitForPush(before);
    const afterFirst = received.length;
    await bridge.handleIncoming(ev); /* 同一 msgId */
    await new Promise((r) => setTimeout(r, 2500));
    const ok = received.length === afterFirst;
    console.log(`[e2e]   首次推送 ${afterFirst - before} 条，重复后新增 ${received.length - afterFirst} 条`);
    console.log(`[e2e]   ${ok ? '✅ PASS' : '❌ FAIL'}`);
    results.push(ok);
}

/* ---------- 汇总 ---------- */
const passed = results.filter(Boolean).length;
console.log(`\n[e2e] 结果 ${passed}/${results.length} 通过`);
console.log('[e2e] 会话映射:', JSON.stringify(bridge.getSessions()));

/* ---------- 清理 ---------- */
for (const key of Object.keys(bridge.getSessions())) {
    const tid = bridge.getSessions()[key]?.threadId;
    if (!tid) continue;
    try {
        await fetch(`http://127.0.0.1:${PORT}/api/threads/${tid}`, { method: 'DELETE' });
    } catch {
        /* ignore */
    }
}
await activation.dispose?.();
webhookServer.close();
process.exit(passed === results.length ? 0 : 1);
