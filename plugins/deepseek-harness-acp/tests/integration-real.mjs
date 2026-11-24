#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runAcpPrompt } from './acp-direct.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..');
const plugin = await import(
    `${pathToFileURL(path.join(ROOT, 'main.js')).href}?real=${Date.now()}`
);
const { activate, __internal: internal } = plugin;

const logs = [];
const notifications = [];
const logger = {};
for (const level of ['info', 'warn', 'error', 'debug']) {
    logger[level] = (...args) => {
        const line = args.join(' ');
        logs.push(`${level.toUpperCase()} ${line}`);
        console.log(line);
    };
}
const context = {
    logger,
    ui: {
        showNotification(message, options) {
            notifications.push({ message, type: options?.type });
        },
    },
};

const state = internal.createRunState();
let handle = null;
const summary = {
    when: new Date().toISOString(),
    ok: false,
    providerId: null,
    status: null,
    test: null,
    dshPath: null,
    models: null,
    prompt: null,
};

try {
    const health = await internal.request(
        'GET',
        '/api/health',
        undefined,
        5000,
        state,
        logger
    );
    if (health.statusCode !== 200) {
        throw new Error(`Alma /api/health 返回 HTTP ${health.statusCode}`);
    }

    handle = await activate(context);
    const result = await handle.ready;
    summary.status = result.status;
    if (!['created', 'existing'].includes(result.status)) {
        throw new Error(
            `注册/对齐失败：${JSON.stringify({
                status: result.status,
                error: result.error,
                notifications,
            })}`
        );
    }

    const providers = await internal.listProviders(state, logger);
    const exact = providers.filter(
        (provider) =>
            provider?.type === 'acp' && provider?.name === internal.PROVIDER_NAME
    );
    assert.equal(
        exact.length,
        1,
        `精确名称 provider 应唯一，实际 ${exact.length} 个`
    );
    const provider = exact[0];
    summary.providerId = String(provider.id);
    summary.dshPath = provider.acpCommand || null;

    const tested = await internal.testProvider(String(provider.id), logger, state);
    summary.test = tested;
    assert.equal(tested.ok, true, `真实 /test 失败：${tested.reason || 'unknown'}`);

    const refreshed = await internal.listProviders(state, logger);
    const current = refreshed.find((item) => String(item.id) === String(provider.id));
    assert.ok(current, 'provider 在测试后从列表中消失');
    assert.equal(current.enabled, true, 'provider 未启用');
    const modelIds = internal.normalizeModelIds(current.models);
    assert.ok(modelIds.length > 0, 'provider 模型列表为空');
    summary.models = modelIds;

    const promptCommand = current.acpCommand;
    const promptArgs = Array.isArray(current.acpArgs)
        ? current.acpArgs
        : internal.ACP_ARGS;
    assert.ok(
        internal.commandIsUsable(promptCommand),
        `provider 的 acpCommand 不可执行：${promptCommand}`
    );
    if (process.env.DSH_PATH) {
        const requestedDsh = fs.realpathSync(process.env.DSH_PATH);
        if (requestedDsh !== promptCommand) {
            logger.warn(
                `[integration-real] DSH_PATH=${requestedDsh} 与 provider.acpCommand=${promptCommand} 不同；ACP prompt 使用 provider 实际命令。`
            );
        }
    }

    const promptTimeoutMs = Number(process.env.ACP_PROMPT_TIMEOUT_MS || 180000);
    if (!Number.isFinite(promptTimeoutMs) || promptTimeoutMs <= 0) {
        throw new Error('ACP_PROMPT_TIMEOUT_MS 必须是正整数');
    }
    const live = await runAcpPrompt({
        command: promptCommand,
        args: promptArgs,
        cwd: ROOT,
        env: internal.buildProbeEnv(),
        prompt: 'Reply with exactly ACP-LIVE-OK and nothing else.',
        timeoutMs: promptTimeoutMs,
        logger,
    });
    summary.prompt = live;
    assert.match(
        live.content,
        /ACP-LIVE-OK/,
        `ACP prompt 回复不含 ACP-LIVE-OK：${live.content}`
    );

    summary.ok = true;
    console.log(JSON.stringify(summary, null, 2));
} catch (error) {
    summary.error = internal.redactSecrets(error?.stack || String(error));
    console.error(summary.error);
    process.exitCode = 1;
} finally {
    if (handle) await handle.dispose();
    fs.writeFileSync(
        path.join(TEST_DIR, 'real-last-run.json'),
        `${JSON.stringify(summary, null, 2)}\n`
    );
}
