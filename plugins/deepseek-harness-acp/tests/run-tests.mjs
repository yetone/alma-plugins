#!/usr/bin/env node

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..');
const MAIN_URL = pathToFileURL(path.join(ROOT, 'main.js')).href;
const plugin = await import(`${MAIN_URL}?test=${Date.now()}`);
const { activate, __internal: internal } = plugin;

const results = [];
const uncaught = [];
const originalEnv = { ...process.env };
const tempRoots = [];

process.on('uncaughtException', (error) => {
    uncaught.push(error);
});
process.on('unhandledRejection', (error) => {
    uncaught.push(error);
});

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempDir(prefix = 'deepseek-harness-test-') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempRoots.push(directory);
    return directory;
}

function freshConfig() {
    const directory = tempDir();
    process.env.ALMA_PLUGIN_CONFIG_DIR = directory;
    return directory;
}

function writeExecutable(file, source) {
    fs.writeFileSync(file, source, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    return file;
}

function fakeDsh(mode = 'good') {
    const directory = tempDir('deepseek-harness-dsh-');
    const file = path.join(directory, 'dsh');
    if (mode === 'epipe') {
        return writeExecutable(
            file,
            `#!/bin/sh
exec 0<&-
exec /bin/sleep 30
`
        );
    }
    const source = `#!/usr/bin/env node
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
if (mode === 'fail') {
  process.stderr.write('fake dsh failed with sk-fake-dsh-secret');
  setTimeout(() => process.exit(2), 50);
} else {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {});
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\\r?\\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method !== 'initialize') continue;
      if (process.env.DSH_FAKE_DUMP) {
        fs.writeFileSync(process.env.DSH_FAKE_DUMP, JSON.stringify(process.env));
      }
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { agentInfo: { name: 'fake-dsh', version: '0.0.0' } }
      }) + '\\n');
      if (mode === 'crash-after') {
        setTimeout(() => process.exit(7), 200);
      }
      break;
    }
  });
  if (mode === 'no-init') {
    setInterval(() => {}, 1000);
  } else {
    setInterval(() => {}, 1000);
  }
}
`;
    return writeExecutable(file, source);
}

function makeToken() {
    return `p${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

function providerFixture(overrides = {}) {
    return {
        id: makeToken(),
        name: internal.PROVIDER_NAME,
        type: 'acp',
        acpCommand: '/tmp/dsh',
        acpArgs: internal.ACP_ARGS.slice(),
        enabled: true,
        models: [{ id: 'default', name: 'Default' }],
        availableModels: [{ id: 'default', name: 'Default' }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

const realHttpRequest = http.request;
let activeMockApi = null;

function jsonResponse(statusCode, body) {
    return { statusCode, body, text: JSON.stringify(body) };
}

function textResponse(statusCode, text) {
    return { statusCode, body: undefined, text };
}

function fakeHttpRequest(options, callback) {
    const request = new EventEmitter();
    const chunks = [];
    let destroyed = false;
    let timeoutTimer = null;
    let delayTimer = null;
    let delayResolve = null;
    let responseStream = null;

    const clearTimers = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (delayTimer) clearTimeout(delayTimer);
        if (delayResolve) delayResolve();
        timeoutTimer = null;
        delayTimer = null;
        delayResolve = null;
    };
    const fail = (error) => {
        if (destroyed) return;
        destroyed = true;
        clearTimers();
        process.nextTick(() => {
            request.emit('error', error);
            request.emit('close');
        });
    };

    request.write = (chunk) => {
        if (!destroyed) chunks.push(Buffer.from(chunk));
        return true;
    };
    request.end = () => {
        if (destroyed) return;
        process.nextTick(run);
    };
    request.setTimeout = (timeoutMs, onTimeout) => {
        timeoutTimer = setTimeout(() => {
            if (typeof onTimeout === 'function') onTimeout();
            else request.destroy(new Error(`请求超时（${timeoutMs}ms）`));
        }, timeoutMs);
    };
    request.destroy = (error) => {
        if (destroyed) return;
        if (responseStream) {
            responseStream.destroy(error);
        }
        fail(error || new Error('request destroyed'));
    };
    request.abort = () => request.destroy(new Error('request aborted'));

    async function run() {
        if (destroyed) return;
        const mock = activeMockApi;
        if (!mock) {
            fail(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
            return;
        }

        const rawBody = Buffer.concat(chunks).toString('utf8');
        let body = null;
        if (rawBody) {
            try {
                body = JSON.parse(rawBody);
            } catch {
                body = rawBody;
            }
        }
        const method = String(options.method || 'GET').toUpperCase();
        const pathname = String(options.path || '/');

        let result;
        try {
            result = await mock.handle({ method, path: pathname, body });
        } catch (error) {
            fail(error);
            return;
        }
        if (destroyed) return;

        if (result.delayMs) {
            await new Promise((resolve) => {
                delayResolve = resolve;
                delayTimer = setTimeout(resolve, result.delayMs);
            });
            delayTimer = null;
            delayResolve = null;
        }
        if (destroyed) return;
        clearTimers();

        responseStream = new Readable({ read() {} });
        responseStream.statusCode = result.statusCode || 200;
        responseStream.headers = {
            'content-type': result.body === undefined ? 'text/plain' : 'application/json',
            ...(result.headers || {}),
        };
        try {
            callback(responseStream);
        } catch (error) {
            fail(error);
            return;
        }
        const text = result.text ?? JSON.stringify(result.body ?? null);
        responseStream.push(Buffer.from(text, 'utf8'));
        responseStream.push(null);
        request.emit('close');
    }

    return request;
}

http.request = function patchedRequest(...args) {
    if (!activeMockApi) return realHttpRequest.apply(http, args);
    return fakeHttpRequest(args[0], args[1]);
};

async function startMockAlma(initialProviders = [], initialBehavior = {}) {
    const state = {
        providers: structuredClone(initialProviders),
        behavior: { ...initialBehavior },
        requests: [],
        testStartedPromise: Promise.resolve(),
        markTestStarted: null,
    };
    state.testStartedPromise = new Promise((resolve) => {
        state.markTestStarted = resolve;
    });

    const mock = {
        state,
        async handle({ method, path: pathname, body }) {
            const url = new URL(pathname, 'http://127.0.0.1');
            state.requests.push({ method, path: url.pathname, body });

            if (method === 'GET' && url.pathname === '/api/providers') {
                return jsonResponse(200, structuredClone(state.providers));
            }

            if (method === 'POST' && url.pathname === '/api/providers') {
                const mode = state.behavior.createResponse || 'normal';
                if (mode === '500') {
                    return jsonResponse(500, {
                        error: { message: 'create failed sk-create-secret' },
                    });
                }
                if (mode === 'hide') return jsonResponse(201, {});

                const provider = providerFixture({
                    name: body?.name || internal.PROVIDER_NAME,
                    type: body?.type || 'acp',
                    acpCommand: body?.acpCommand,
                    acpArgs: body?.acpArgs,
                    enabled: body?.enabled !== false,
                    models: [],
                    availableModels: [],
                });
                state.providers.push(provider);
                if (mode === 'no-id-json') return jsonResponse(201, { ok: true });
                if (mode === 'non-json') return textResponse(201, '<html>created</html>');
                return jsonResponse(201, structuredClone(provider));
            }

            const testMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/test$/);
            if (method === 'POST' && testMatch) {
                state.markTestStarted();
                if (state.behavior.testResponse === 'fail') {
                    return {
                        ...jsonResponse(200, {
                            success: false,
                            error: 'fake test failed with sk-fake-test-secret',
                        }),
                        delayMs: state.behavior.testDelayMs,
                    };
                }
                if (state.behavior.testResponse === '500') {
                    return {
                        ...jsonResponse(500, { error: { message: 'test exploded' } }),
                        delayMs: state.behavior.testDelayMs,
                    };
                }
                return {
                    ...jsonResponse(200, { success: true, latencyMs: 1 }),
                    delayMs: state.behavior.testDelayMs,
                };
            }

            const modelsFetchMatch = url.pathname.match(
                /^\/api\/providers\/([^/]+)\/models\/fetch$/
            );
            if (method === 'POST' && modelsFetchMatch) {
                if (state.behavior.modelsFetchResponse === '500') {
                    return jsonResponse(500, { error: { message: 'fetch models failed' } });
                }
                return jsonResponse(
                    200,
                    state.behavior.modelsFetchBody || {
                        models: [{ id: 'mock-model', name: 'Mock Model' }],
                    }
                );
            }

            const modelsMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/models$/);
            if (method === 'PUT' && modelsMatch) {
                if (state.behavior.modelsPutResponse === '500') {
                    return jsonResponse(500, { error: { message: 'models put failed' } });
                }
                const provider = state.providers.find(
                    (item) => String(item.id) === decodeURIComponent(modelsMatch[1])
                );
                if (provider) provider.models = structuredClone(body?.models || []);
                return jsonResponse(200, provider || {});
            }

            const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
            if (method === 'DELETE' && providerMatch) {
                const id = decodeURIComponent(providerMatch[1]);
                if (state.behavior.deleteResponse === '500') {
                    return jsonResponse(500, { error: { message: 'delete failed' } });
                }
                state.providers = state.providers.filter(
                    (item) => String(item.id) !== id
                );
                return textResponse(204, '');
            }
            if (method === 'PUT' && providerMatch) {
                const id = decodeURIComponent(providerMatch[1]);
                const provider = state.providers.find(
                    (item) => String(item.id) === id
                );
                if (!provider) {
                    return jsonResponse(404, { error: { message: 'not found' } });
                }
                Object.assign(provider, body || {});
                provider.updatedAt = new Date().toISOString();
                return jsonResponse(200, structuredClone(provider));
            }

            return jsonResponse(404, { error: { message: 'not found' } });
        },
    };

    activeMockApi = mock;
    process.env.ALMA_API_PORT = '23001';
    return {
        state,
        port: 23001,
        async close() {
            if (activeMockApi === mock) activeMockApi = null;
        },
    };
}

async function startNotAlma() {
    const mock = {
        async handle() {
            return jsonResponse(200, { hello: 'not-alma' });
        },
    };
    activeMockApi = mock;
    process.env.ALMA_API_PORT = '23001';
    return {
        async close() {
            if (activeMockApi === mock) activeMockApi = null;
        },
    };
}

async function startUnreachableApi() {
    const mock = {
        unreachable: true,
        async handle() {
            throw Object.assign(new Error('connect ECONNREFUSED'), {
                code: 'ECONNREFUSED',
            });
        },
    };
    activeMockApi = mock;
    process.env.ALMA_API_PORT = '23001';
    return {
        async close() {
            if (activeMockApi === mock) activeMockApi = null;
        },
    };
}

function makeContext() {
    const logs = { info: [], warn: [], error: [], debug: [] };
    const notifications = [];
    const logger = {};
    for (const level of Object.keys(logs)) {
        logger[level] = (...args) => logs[level].push(args.join(' '));
    }
    return {
        logger,
        ui: {
            showNotification(message, options) {
                notifications.push({ message, type: options?.type });
            },
        },
        logs,
        notifications,
    };
}

function configMutations(mock) {
    return mock.state.requests.filter(
        (request) =>
            request.method === 'DELETE' ||
            request.method === 'PUT' ||
            (request.method === 'POST' && request.path === '/api/providers')
    );
}

async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(25);
    }
    return false;
}

function withTimeout(promise, timeoutMs, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error(`${label} 超时（${timeoutMs}ms）`)),
                timeoutMs
            );
        }),
    ]).finally(() => clearTimeout(timer));
}

async function test(name, fn, timeoutMs = 20000) {
    const started = Date.now();
    try {
        await withTimeout(Promise.resolve().then(fn), timeoutMs, name);
        results.push({ name, ok: true, ms: Date.now() - started });
        console.log(`PASS  ${name}`);
    } catch (error) {
        results.push({
            name,
            ok: false,
            ms: Date.now() - started,
            error: error?.stack || String(error),
        });
        console.log(`FAIL  ${name}`);
        console.log(String(error?.stack || error).replace(/^/gm, '      '));
    } finally {
        restoreEnv();
    }
}

function restoreEnv(snapshot = originalEnv) {
    for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) delete process.env[key];
    }
    Object.assign(process.env, snapshot);
}

async function runActivation(context, setup) {
    const handle = await activate(context);
    const result = await handle.ready;
    if (setup?.dispose) await handle.dispose();
    return { handle, result };
}

/* ------------------------------------------------------------------ */
/* 原有 16 类场景                                                       */
/* ------------------------------------------------------------------ */

await test('manifest 合法且字段齐全', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(manifest.id, 'deepseek-harness-acp');
    assert.equal(manifest.version, '0.2.1');
    assert.equal(pkg.version, '0.2.1');
    assert.equal(manifest.type, 'provider');
    assert.equal(manifest.main, 'main.js');
    assert.deepEqual(manifest.permissions, ['notifications', 'filesystem:read']);
    assert.ok(fs.existsSync(path.join(ROOT, 'tests', 'run-tests.mjs')));
});

await test('模块可被 Alma 那样动态 import', async () => {
    assert.equal(typeof activate, 'function');
    assert.equal(typeof plugin.default, 'function');
    assert.equal(internal.PLUGIN_VERSION, '0.2.1');
});

await test('provider 识别规则', async () => {
    assert.equal(
        internal.isDshProvider(
            providerFixture({ name: 'My DeepSeek Harness test', acpCommand: '/x/dsh' })
        ),
        true
    );
    assert.equal(
        internal.isDshProvider(
            providerFixture({ name: 'anything', acpCommand: '/Users/me/bin/dsh' })
        ),
        true
    );
    assert.equal(
        internal.isDshProvider(
            providerFixture({ name: 'Claude Code', acpCommand: '/x/claude-acp' })
        ),
        false
    );
    assert.equal(
        internal.isDshProvider(
            providerFixture({ name: 'Codex', type: 'openai', acpCommand: '/x/dsh' })
        ),
        false
    );
});

await test('API 端口从 api-spec 的 Base URL 读取并拒绝诱饵', async () => {
    const config = freshConfig();
    delete process.env.ALMA_API_PORT;
    fs.writeFileSync(
        path.join(config, 'api-spec.md'),
        '# spec\n\nSome proxy at localhost:11111\n\n**Base URL:** `http://localhost:23456`\n'
    );
    const context = makeContext();
    assert.equal(internal.resolveApiBase(context.logger), 'http://127.0.0.1:23456');
    process.env.ALMA_API_PORT = 'abc';
    assert.equal(internal.resolveApiBase(context.logger), 'http://127.0.0.1:23456');
    assert.match(context.logs.warn.join('\n'), /ALMA_API_PORT 非法/);
});

await test('能跑的 dsh 候选被选中', async () => {
    const good = fakeDsh('good');
    process.env.DSH_PATH = good;
    process.env.ALMA_PLUGIN_CONFIG_DIR = tempDir();
    const context = makeContext();
    const picked = await internal.pickWorkingDsh(context.logger, internal.createRunState());
    assert.equal(picked.ok, true);
    assert.equal(picked.path, fs.realpathSync(good));
});

await test('崩掉的 dsh 会被握手挡掉', async () => {
    const bad = fakeDsh('fail');
    const result = await internal.probeAcp(bad, internal.createRunState());
    assert.equal(result.ok, false);
    assert.match(result.reason, /提前退出/);
    assert.doesNotMatch(result.reason, /sk-fake-dsh-secret/);
});

await test('已注册时幂等（不重复创建、不刷通知）', async () => {
    const config = freshConfig();
    const dsh = fakeDsh();
    process.env.DSH_PATH = dsh;
    const provider = providerFixture({ acpCommand: fs.realpathSync(dsh) });
    const mock = await startMockAlma([provider]);
    const context = makeContext();
    try {
        const { result } = await runActivation(context);
        assert.equal(result.status, 'existing');
        assert.equal(mock.state.providers.length, 1);
        assert.equal(configMutations(mock).length, 0);
        assert.equal(context.notifications.length, 0);
    } finally {
        await mock.close();
    }
});

await test('已有精确名称 provider 指向坏路径时自动修正', async () => {
    freshConfig();
    const dsh = fakeDsh();
    process.env.DSH_PATH = dsh;
    const provider = providerFixture({
        acpCommand: '/definitely/missing/dsh',
        acpArgs: [],
        enabled: false,
        models: [],
    });
    const mock = await startMockAlma([provider]);
    const context = makeContext();
    try {
        const { result } = await runActivation(context);
        assert.equal(result.status, 'existing');
        assert.deepEqual(result.patched.sort(), ['acpArgs', 'acpCommand']);
        const updated = mock.state.providers[0];
        assert.equal(updated.acpCommand, fs.realpathSync(dsh));
        assert.deepEqual(updated.acpArgs, internal.ACP_ARGS);
        assert.equal(updated.enabled, true);
        assert.ok(updated.models.length > 0);
    } finally {
        await mock.close();
    }
});

await test('provider 被删掉后能重建', async () => {
    freshConfig();
    const dsh = fakeDsh();
    process.env.DSH_PATH = dsh;
    const mock = await startMockAlma([]);
    try {
        const first = await runActivation(makeContext());
        assert.equal(first.result.status, 'created');
        assert.equal(mock.state.providers.length, 1);
        mock.state.providers = [];
        const second = await runActivation(makeContext());
        assert.equal(second.result.status, 'created');
        assert.equal(mock.state.providers.length, 1);
        assert.equal(
            mock.state.requests.filter(
                (request) => request.method === 'POST' && request.path === '/api/providers'
            ).length,
            2
        );
    } finally {
        await mock.close();
    }
});

await test('找不到 dsh 时不写任何东西', async () => {
    freshConfig();
    process.env.DSH_PATH = '/definitely/missing/dsh';
    const provider = providerFixture();
    const mock = await startMockAlma([provider]);
    const before = structuredClone(mock.state.providers);
    const context = makeContext();
    try {
        const { result } = await runActivation(context);
        assert.equal(result.status, 'no-dsh');
        assert.equal(mock.state.requests.length, 0);
        assert.deepEqual(mock.state.providers, before);
        assert.equal(context.notifications.length, 1);
    } finally {
        await mock.close();
    }
});

await test('只找到坏 dsh 时拒绝注册并说明原因', async () => {
    freshConfig();
    process.env.DSH_PATH = fakeDsh('fail');
    const mock = await startMockAlma([]);
    const context = makeContext();
    try {
        const { result } = await runActivation(context);
        assert.equal(result.status, 'no-dsh');
        assert.equal(mock.state.providers.length, 0);
        assert.match(context.logs.warn.join('\n'), /提前退出/);
        assert.doesNotMatch(context.logs.warn.join('\n'), /sk-fake-dsh-secret/);
    } finally {
        await mock.close();
    }
});

await test('Alma API 连不上时只报错不抛异常', async () => {
    freshConfig();
    process.env.DSH_PATH = fakeDsh();
    const unreachable = await startUnreachableApi();
    const context = makeContext();
    try {
        const handle = await activate(context);
        const result = await handle.ready;
        assert.equal(result.status, 'error');
        assert.match(context.logs.error.join('\n'), /无法连接 Alma/);
    } finally {
        await unreachable.close();
    }
});

await test('新建后连接测试失败会回滚删除', async () => {
    freshConfig();
    process.env.DSH_PATH = fakeDsh();
    const mock = await startMockAlma([], { testResponse: 'fail' });
    const context = makeContext();
    try {
        const { result } = await runActivation(context);
        assert.equal(result.status, 'error');
        assert.equal(mock.state.providers.length, 0);
        assert.equal(
            mock.state.requests.filter((request) => request.method === 'DELETE').length,
            1
        );
        assert.match(context.notifications.map((item) => item.message).join('\n'), /回滚删除/);
    } finally {
        await mock.close();
    }
});

await test('context 只有最简结构时也不会崩', async () => {
    freshConfig();
    process.env.DSH_PATH = fakeDsh();
    const mock = await startMockAlma([]);
    const originalLog = console.log;
    console.log = () => {};
    try {
        const handle = await activate({});
        const result = await handle.ready;
        assert.equal(result.status, 'created');
    } finally {
        console.log = originalLog;
        await mock.close();
    }
});

await test('models/fetch 返回值的多种包装都能解析', async () => {
    const cases = [
        ['direct', ['a', { id: 'b', name: 'B' }]],
        ['models', { models: ['a'] }],
        ['data', { data: [{ id: 'a', name: 'A' }] }],
        ['availableModels', { availableModels: ['a'] }],
        ['items', { items: ['a'] }],
        ['object-list', { models: [{ id: 'a' }, { id: 'a' }] }],
    ];
    for (const [_name, body] of cases) {
        const models = internal.extractFetchedModels(body);
        assert.ok(models.length >= 1);
        assert.equal(models[0].id, 'a');
    }
});

await test('两个实例并发激活只产生一个 provider', async () => {
    freshConfig();
    process.env.DSH_PATH = fakeDsh();
    const mock = await startMockAlma([], { testDelayMs: 1500 });
    try {
        const firstHandle = await activate(makeContext());
        await waitFor(() => mock.state.requests.some((request) => request.path.endsWith('/test')));
        const secondHandle = await activate(makeContext());
        const [first, second] = await Promise.all([firstHandle.ready, secondHandle.ready]);
        assert.deepEqual(
            new Set([first.status, second.status]),
            new Set(['created', 'existing'])
        );
        assert.equal(mock.state.providers.length, 1);
    } finally {
        await mock.close();
    }
});

/* ------------------------------------------------------------------ */
/* 0.2.1 新增：取消、锁、回滚、探测与兼容性                              */
/* ------------------------------------------------------------------ */

await test('run 中途 dispose：无后续写请求/通知且 5 秒内返回', async () => {
    freshConfig();
    process.env.DSH_PATH = fakeDsh();
    const mock = await startMockAlma([], { testDelayMs: 20000 });
    const context = makeContext();
    const handle = await activate(context);
    try {
        await waitFor(() => mock.state.requests.some((request) => request.path.endsWith('/test')));
        const requestCountAtDispose = mock.state.requests.length;
        const notificationCountAtDispose = context.notifications.length;
        const started = Date.now();
        const completed = await handle.dispose();
        const elapsed = Date.now() - started;
        assert.equal(completed, true);
        assert.ok(elapsed < 5000, `dispose took ${elapsed}ms`);
        await sleep(200);
        assert.equal(mock.state.requests.length, requestCountAtDispose);
        assert.equal(context.notifications.length, notificationCountAtDispose);
        assert.equal((await handle.ready).status, 'cancelled');
        assert.equal(fs.existsSync(internal.lockFilePath()), false);
    } finally {
        await handle.dispose();
        await mock.close();
    }
});

await test('老 mtime 的锁只有持锁 PID 已死才允许接管', async () => {
    freshConfig();
    const file = internal.lockFilePath();
    const logger = makeContext().logger;
    const staleTime = new Date(Date.now() - internal.LOCK_STALE_MS - 5000);

    fs.writeFileSync(
        file,
        JSON.stringify({ pid: 2147483646, nonce: 'dead-owner' }),
        { mode: 0o600 }
    );
    fs.utimesSync(file, staleTime, staleTime);
    const taken = internal.tryLock(logger);
    assert.ok(taken);
    assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).nonce, 'dead-owner');
    assert.equal(internal.releaseLock(taken, logger), true);

    fs.writeFileSync(
        file,
        JSON.stringify({ pid: process.pid, nonce: 'live-owner' }),
        { mode: 0o600 }
    );
    fs.utimesSync(file, staleTime, staleTime);
    assert.equal(internal.tryLock(logger), null);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nonce, 'live-owner');
    fs.unlinkSync(file);
});

if (process.env.SKIP_LONG_LOCK_TEST !== '1') await test('活跃锁超过 120 秒不被另一实例抢走且仍只有一个 provider', async () => {
    const testStarted = Date.now();
    freshConfig();
    process.env.DSH_PATH = fakeDsh();
    const mock = await startMockAlma([], { testDelayMs: 200000 });
    const firstHandle = await activate(makeContext());
    try {
        await waitFor(() => mock.state.requests.some((request) => request.path.endsWith('/test')));
        const lockBefore = fs.statSync(internal.lockFilePath()).mtimeMs;
        await sleep(31000);
        const lockAfter = fs.statSync(internal.lockFilePath()).mtimeMs;
        assert.ok(lockAfter > lockBefore, 'lock heartbeat should refresh mtime');

        const secondHandle = await activate(makeContext());
        const second = await secondHandle.ready;
        assert.equal(second.status, 'locked');
        assert.equal(
            mock.state.requests.filter(
                (request) => request.method === 'POST' && request.path === '/api/providers'
            ).length,
            1
        );

        const elapsed = Date.now() - testStarted;
        if (elapsed < 121000) await sleep(121000 - elapsed);
        assert.equal(mock.state.providers.length, 1);
        assert.equal(fs.existsSync(internal.lockFilePath()), true);
    } finally {
        const started = Date.now();
        await firstHandle.dispose();
        assert.ok(Date.now() - started < 5000);
        await mock.close();
    }
}, 140000);

await test('releaseLock 不删除其他实例的锁', async () => {
    const config = freshConfig();
    const file = internal.lockFilePath();
    const ownNonce = 'nonce-own';
    const otherNonce = 'nonce-other';
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, nonce: otherNonce }), {
        mode: 0o600,
    });
    const logger = makeContext().logger;
    const released = internal.releaseLock(
        {
            file,
            fd: fs.openSync(file, 'r'),
            nonce: ownNonce,
            heartbeat: null,
            closed: false,
        },
        logger
    );
    assert.equal(released, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nonce, otherNonce);
    assert.ok(config);

    fs.unlinkSync(file);
    const handle = internal.tryLock(logger);
    assert.ok(handle);
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(internal.releaseLock(handle, logger), true);
});

await test('dsh 握手后 200ms 崩溃会被稳定性窗口挡掉', async () => {
    const dsh = fakeDsh('crash-after');
    const state = internal.createRunState();
    const result = await internal.probeAcp(dsh, state);
    assert.equal(result.ok, false);
    assert.match(result.reason, /提前退出/);
});

await test('dsh stdin EPIPE 不会产生未捕获异常', async () => {
    const dsh = fakeDsh('epipe');
    const before = uncaught.length;
    const started = Date.now();
    const result = await internal.probeAcp(dsh, internal.createRunState(), {
        writeDelayMs: 1000,
    });
    await sleep(300);
    assert.equal(result.ok, false);
    assert.match(result.reason, /EPIPE|写入/);
    assert.ok(Date.now() - started < 5000, 'EPIPE should fail without waiting for timeout');
    assert.equal(uncaught.length, before);
});

await test('POST 201 无 id 时按名称反查并继续测试', async () => {
    freshConfig();
    process.env.DSH_PATH = fakeDsh();
    const mock = await startMockAlma([], { createResponse: 'no-id-json' });
    const context = makeContext();
    try {
        const { result } = await runActivation(context);
        assert.equal(result.status, 'created');
        assert.ok(result.providerId);
        assert.equal(mock.state.providers.length, 1);
        assert.equal(mock.state.providers[0].models.length, 1);
        assert.equal(mock.state.providers[0].enabled, true);
        assert.match(context.notifications.at(-1).message, /连接测试通过/);
    } finally {
        await mock.close();
    }
});

await test('POST 201 非 JSON 时按名称反查并继续测试', async () => {
    freshConfig();
    process.env.DSH_PATH = fakeDsh();
    const mock = await startMockAlma([], { createResponse: 'non-json' });
    const context = makeContext();
    try {
        const { result } = await runActivation(context);
        assert.equal(result.status, 'created');
        assert.equal(mock.state.providers.length, 1);
        assert.equal(mock.state.providers[0].models.length, 1);
    } finally {
        await mock.close();
    }
});

await test('POST 无 id 且反查不到：新条目保持 disabled 并告警', async () => {
    freshConfig();
    process.env.DSH_PATH = fakeDsh();
    const mock = await startMockAlma([], { createResponse: 'hide' });
    const context = makeContext();
    try {
        const { result } = await runActivation(context);
        assert.equal(result.status, 'created-unknown');
        assert.equal(result.providerId, null);
        const create = mock.state.requests.find(
            (request) => request.method === 'POST' && request.path === '/api/providers'
        );
        assert.equal(create.body.enabled, false);
        assert.equal(
            mock.state.requests.filter(
                (request) => request.method === 'PUT' && request.path.startsWith('/api/providers/')
            ).length,
            0
        );
        assert.match(
            context.notifications.map((item) => item.message).join('\n'),
            /保持禁用/
        );
    } finally {
        await mock.close();
    }
});

await test('DELETE 500：重试后退避，最终 PUT enabled=false 并明确通知', async () => {
    freshConfig();
    process.env.DSH_PATH = fakeDsh();
    const mock = await startMockAlma([], {
        testResponse: 'fail',
        deleteResponse: '500',
    });
    const context = makeContext();
    try {
        const { result } = await runActivation(context);
        assert.equal(result.status, 'error');
        assert.equal(mock.state.providers.length, 1);
        assert.equal(mock.state.providers[0].enabled, false);
        assert.equal(
            mock.state.requests.filter((request) => request.method === 'DELETE').length,
            3
        );
        const message = context.notifications.map((item) => item.message).join('\n');
        assert.match(message, /DELETE 未成功/);
        assert.match(message, new RegExp(mock.state.providers[0].id));
        assert.doesNotMatch(message, /sk-fake-test-secret/);
    } finally {
        await mock.close();
    }
});

await test('PUT /models 500 不把已成功注册判失败，只提示模型为空', async () => {
    freshConfig();
    process.env.DSH_PATH = fakeDsh();
    const mock = await startMockAlma([], { modelsPutResponse: '500' });
    const context = makeContext();
    try {
        const { result } = await runActivation(context);
        assert.equal(result.status, 'created');
        assert.equal(result.modelsEnabled, false);
        assert.equal(context.notifications.at(-1).type, 'warning');
        assert.match(context.notifications.at(-1).message, /模型列表为空/);
        assert.equal(context.logs.error.length, 0);
    } finally {
        await mock.close();
    }
});

await test('端口上是别的服务时安全失败', async () => {
    freshConfig();
    process.env.DSH_PATH = fakeDsh();
    const notAlma = await startNotAlma();
    const context = makeContext();
    try {
        const handle = await activate(context);
        const result = await handle.ready;
        assert.equal(result.status, 'error');
        assert.equal(context.notifications.length, 1);
        assert.match(context.notifications[0].message, /详情见日志/);
    } finally {
        await notAlma.close();
    }
});

await test('精确名称 provider + models 空 + enabled=false 可自愈', async () => {
    freshConfig();
    const dsh = fakeDsh();
    process.env.DSH_PATH = dsh;
    const provider = providerFixture({
        acpCommand: fs.realpathSync(dsh),
        acpArgs: ['--custom', 'manual'],
        enabled: false,
        models: [],
    });
    const mock = await startMockAlma([provider]);
    const context = makeContext();
    try {
        const { result } = await runActivation(context);
        assert.equal(result.status, 'existing');
        assert.equal(mock.state.providers[0].enabled, true);
        assert.ok(mock.state.providers[0].models.length > 0);
        assert.deepEqual(mock.state.providers[0].acpArgs, ['--custom', 'manual']);
        assert.match(context.notifications[0].message, /已自动修正配置/);
    } finally {
        await mock.close();
    }
});

await test('没有 dsh 但已有 provider 时不误删误改', async () => {
    freshConfig();
    process.env.DSH_PATH = '/no/such/dsh';
    const provider = providerFixture({
        acpCommand: '/old/dsh',
        enabled: false,
        models: [],
    });
    const mock = await startMockAlma([provider]);
    const before = structuredClone(mock.state.providers);
    try {
        const { result } = await runActivation(makeContext());
        assert.equal(result.status, 'no-dsh');
        assert.deepEqual(mock.state.providers, before);
        assert.equal(configMutations(mock).length, 0);
    } finally {
        await mock.close();
    }
});

await test('模糊匹配只测试不覆写用户配置', async () => {
    freshConfig();
    const dsh = fakeDsh();
    process.env.DSH_PATH = dsh;
    const provider = providerFixture({
        name: 'My DeepSeek Harness test',
        acpCommand: '/Users/me/bin/dsh-dev',
        acpArgs: ['custom-arg'],
        enabled: false,
        models: [],
    });
    const mock = await startMockAlma([provider]);
    try {
        const { result } = await runActivation(makeContext());
        assert.equal(result.status, 'existing');
        assert.deepEqual(mock.state.providers[0], provider);
        assert.equal(
            mock.state.requests.filter((request) => request.method === 'PUT').length,
            0
        );
        assert.equal(
            mock.state.requests.filter((request) => request.path.endsWith('/models/fetch')).length,
            0
        );
    } finally {
        await mock.close();
    }
});

await test('精确名称但命令可执行时不覆写用户 acpCommand/acpArgs', async () => {
    freshConfig();
    const dsh = fakeDsh();
    const custom = fakeDsh();
    process.env.DSH_PATH = dsh;
    const provider = providerFixture({
        acpCommand: fs.realpathSync(custom),
        acpArgs: ['--manual'],
    });
    const mock = await startMockAlma([provider]);
    try {
        const { result } = await runActivation(makeContext());
        assert.equal(result.status, 'existing');
        assert.equal(mock.state.providers[0].acpCommand, fs.realpathSync(custom));
        assert.deepEqual(mock.state.providers[0].acpArgs, ['--manual']);
        assert.equal(
            mock.state.requests.filter((request) => request.method === 'PUT').length,
            0
        );
    } finally {
        await mock.close();
    }
});

await test('probe 子进程只继承白名单环境', async () => {
    const dump = path.join(tempDir(), 'env.json');
    const dsh = fakeDsh();
    process.env.DSH_FAKE_DUMP = dump;
    process.env.OPENAI_API_KEY = 'injected-provider-key';
    const result = await internal.probeAcp(dsh, internal.createRunState());
    assert.equal(result.ok, true);
    const childEnv = JSON.parse(fs.readFileSync(dump, 'utf8'));
    assert.equal('OPENAI_API_KEY' in childEnv, false);
    assert.equal(childEnv.NO_COLOR, '1');
    assert.ok(childEnv.PATH);
    assert.ok(childEnv.HOME);
    assert.ok('DSH_FAKE_DUMP' in childEnv);
});

await test('ECONNRESET 不再视为可重试连接错误', async () => {
    assert.equal(internal.isConnectError({ code: 'ECONNRESET' }), false);
    assert.equal(internal.isConnectError({ code: 'ECONNREFUSED' }), true);
    assert.equal(
        internal.isConnectError({ code: 'ECONNREFUSED', requestBodyWritten: true }),
        false
    );
});

await test('日志与通知出口脱敏', async () => {
    const text = internal.redactSecrets(
        'sk-abc12345 apiKey=fake-api-value Authorization: Bearer token-value'
    );
    assert.doesNotMatch(text, /abc12345|fake-api-value|token-value/);
    assert.match(text, /\*\*\*/);
    const json = internal.redactSecrets(
        JSON.stringify({
            apiKey: 'json-' + 'api-value',
            access_token: 'json-' + 'token-value',
        })
    );
    assert.match(json, /"apiKey":"\*\*\*"/);
    assert.match(json, /"access_token":"\*\*\*"/);
});

await test('错误路径释放锁且锁文件位于配置目录', async () => {
    const config = freshConfig();
    process.env.DSH_PATH = '/no/such/dsh';
    const mock = await startMockAlma([]);
    try {
        const { result } = await runActivation(makeContext());
        assert.equal(result.status, 'no-dsh');
        assert.equal(path.dirname(internal.lockFilePath()), config);
        assert.equal(fs.existsSync(internal.lockFilePath()), false);
    } finally {
        await mock.close();
    }
});

const failures = results.filter((result) => !result.ok);
const output = {
    version: internal.PLUGIN_VERSION,
    when: new Date().toISOString(),
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    uncaught: uncaught.map((error) => String(error?.stack || error)),
    results,
};
fs.writeFileSync(path.join(TEST_DIR, 'last-run.json'), `${JSON.stringify(output, null, 2)}\n`);

for (const directory of tempRoots) {
    try {
        fs.rmSync(directory, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
}

console.log(
    `\n${output.passed}/${output.total} passed in ${results.reduce(
        (sum, result) => sum + result.ms,
        0
    )}ms`
);
if (uncaught.length > 0) {
    console.error(`\nUncaught exceptions: ${uncaught.length}`);
    for (const error of uncaught) console.error(error);
}

if (failures.length > 0 || uncaught.length > 0) process.exitCode = 1;
