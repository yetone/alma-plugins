/**
 * Alma 插件：把本机 DeepSeek Harness（dsh）自动注册为 ACP provider。
 *
 * 设计要点（0.2.1）：
 *   1. dsh 候选不只检查“文件存在”，而是真跑一次 ACP initialize 握手；
 *      本机同时存在 npm 全局版（缺原生绑定、一启动就崩）和桌面版时，
 *      只有能真正启动的才会被选中。
 *   2. 只自动修正插件精确命名的 provider，且命令仅在不可执行时才纠正；
 *      用户自己命名的模糊匹配条目只识别、不覆写。
 *   3. 新建 provider 后调用 Alma 的 /test 做真实连接测试；测试失败先重试 DELETE，
 *      仍失败则禁用，避免留下 enabled、无模型、不可用的僵尸条目。
 *   4. activate 立刻返回，注册流程在后台跑，绝不阻塞 Alma 启动。
 *
 * 只用 Node 内置模块，ESM 写法：目录里的 package.json 声明了 "type": "module"。
 * Alma 用 `import(url + "?t=" + Date.now())` 加载插件，ESM 的 URL 带时间戳，
 * 刷新插件时会真正读到新文件（CommonJS 会被 Node 的模块缓存卡住，必须重启 Alma）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const PLUGIN_VERSION = '0.2.1';
const PLUGIN_NAME = 'alma-plugin-deepseek-harness';
const PROVIDER_NAME = 'DeepSeek Harness (ACP)';
const PROVIDER_NAME_HINT = 'deepseek harness';
const MAC_DSH_PATH =
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const ACP_ARGS = ['--profile', 'acp'];

const DEFAULT_API_PORT = 23001;
const HTTP_TIMEOUT_MS = 10000;
const PROBE_TIMEOUT_MS = 15000;
const MODELS_FETCH_TIMEOUT_MS = 60000;
const PROVIDER_TEST_TIMEOUT_MS = 120000;
const CONNECT_RETRIES = 3;
const RETRY_DELAY_MS = 400;
const DELETE_RETRIES = 3;
const DELETE_RETRY_DELAY_MS = 500;
const DISPOSE_WAIT_MS = 3000;
const PROBE_WRITE_DELAY_MS = 150;
const PROBE_STABILITY_MS = 300;
const MAX_PROBE_BUFFER = 8192;
const LOCK_HEARTBEAT_MS = 30000;
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_WAIT_MS = 30000;
const LOCK_RETRY_MS = 300;

const FALLBACK_MODEL = { id: 'default', name: 'Default' };

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(message = '操作已取消') {
    const error = new Error(message);
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

function isAbortError(error) {
    return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
}

function errText(error) {
    return error instanceof Error ? error.message : String(error);
}

/** 所有日志/通知出口统一脱敏，避免把环境里的 key 带进界面或日志。 */
function redactSecrets(value) {
    return String(value)
        .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/gi, '***')
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
        .replace(
            /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)["']?\s*[:=]\s*["']?)[^\s,"'}\]]+/gi,
            '$1***'
        );
}

function sanitizeArgs(args) {
    return args.map((arg) => (typeof arg === 'string' ? redactSecrets(arg) : arg));
}

/** 兼容 context.logger 缺失 / 方法缺失的情况，永远不要把日志变成崩溃源。 */
function createLogger(context) {
    const fallback = (method, args) => {
        try {
            // eslint-disable-next-line no-console
            console[method]?.('[deepseek-harness-acp]', ...args);
        } catch {
            /* ignore */
        }
    };
    const make = (method, fallbackMethod) => (...args) => {
        const safeArgs = sanitizeArgs(args);
        try {
            const logger = context && context.logger;
            if (logger && typeof logger[method] === 'function') {
                logger[method](...safeArgs);
                return;
            }
        } catch {
            /* ignore */
        }
        fallback(fallbackMethod, safeArgs);
    };
    return {
        info: make('info', 'log'),
        warn: make('warn', 'warn'),
        error: make('error', 'error'),
        debug: make('debug', 'log'),
    };
}

function notify(context, message, type, state) {
    if (state?.cancelled) return;
    if (!context || !context.ui || typeof context.ui.showNotification !== 'function') {
        return;
    }
    try {
        context.ui.showNotification(redactSecrets(message), { type });
    } catch (error) {
        try {
            context.logger?.warn?.(
                `[deepseek-harness-acp] 通知发送失败：${redactSecrets(errText(error))}`
            );
        } catch {
            /* ignore */
        }
    }
}

function createRunState() {
    return {
        cancelled: false,
        probes: new Set(),
        requests: new Set(),
        lock: null,
    };
}

function throwIfCancelled(state) {
    if (state?.cancelled) throw abortError();
}

function cancelRunState(state) {
    if (!state || state.cancelled) return;
    state.cancelled = true;
    for (const destroy of [...state.requests]) {
        try {
            destroy();
        } catch {
            /* ignore */
        }
    }
    for (const cancel of [...state.probes]) {
        try {
            cancel();
        } catch {
            /* ignore */
        }
    }
}

function almaConfigDir() {
    return process.env.ALMA_PLUGIN_CONFIG_DIR
        ? path.resolve(process.env.ALMA_PLUGIN_CONFIG_DIR)
        : path.join(os.homedir(), '.config', 'alma');
}

/** 从 ~/.config/alma/api-spec.md 里读 Alma 的 API 端口，端口不是写死的。 */
function resolveApiBase(logger) {
    let port = 0;
    const rawEnvPort = process.env.ALMA_API_PORT;
    if (rawEnvPort !== undefined && rawEnvPort !== '') {
        const envPort = Number(rawEnvPort);
        if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536) {
            port = envPort;
        } else {
            logger?.warn?.(
                `[deepseek-harness-acp] ALMA_API_PORT 非法：${redactSecrets(rawEnvPort)}；忽略并使用 api-spec / 默认端口。`
            );
        }
    }

    if (!port) {
        try {
            const spec = fs.readFileSync(
                path.join(almaConfigDir(), 'api-spec.md'),
                'utf8'
            );
            const match = spec.match(
                /^[ \t]*\*{0,2}[ \t]*Base URL:\*{0,2}[ \t]*`?https?:\/\/(?:localhost|127\.0\.0\.1):(\d{1,5})(?:\D|$)/im
            );
            if (match) {
                const specPort = Number(match[1]);
                if (Number.isInteger(specPort) && specPort > 0 && specPort < 65536) {
                    port = specPort;
                } else {
                    logger?.warn?.(
                        `[deepseek-harness-acp] api-spec.md 的 Base URL 端口非法：${match[1]}；使用默认端口。`
                    );
                }
            }
        } catch {
            /* 没读到就用默认值 */
        }
    }

    return `http://127.0.0.1:${port || DEFAULT_API_PORT}`;
}

/* ------------------------------------------------------------------ */
/* Alma 本地 API                                                       */
/* ------------------------------------------------------------------ */

function isConnectError(error) {
    return Boolean(
        error &&
            !error.requestBodyWritten &&
            [
                'ECONNREFUSED',
                'EHOSTUNREACH',
                'ENETUNREACH',
                'ENOTFOUND',
                'EAI_AGAIN',
            ].includes(error.code)
    );
}

function rawRequest(host, port, method, pathname, payload, timeoutMs, state) {
    return new Promise((resolve, reject) => {
        if (state?.cancelled) {
            reject(abortError());
            return;
        }

        const body =
            payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf8');
        const headers = { Accept: 'application/json' };
        if (body) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = body.length;
        }

        let req;
        let bodyWritten = false;
        try {
            req = http.request(
                { host, port, path: pathname, method, headers },
                (res) => {
                    const chunks = [];
                    res.on('data', (chunk) => chunks.push(chunk));
                    res.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        let json;
                        try {
                            json = text ? JSON.parse(text) : null;
                        } catch {
                            json = undefined;
                        }
                        resolve({
                            statusCode: res.statusCode || 0,
                            headers: res.headers,
                            json,
                            text,
                        });
                    });
                    res.on('error', reject);
                }
            );
        } catch (error) {
            reject(error);
            return;
        }

        const untrack = () => state?.requests.delete(destroy);
        const destroy = () => {
            try {
                req.destroy(abortError());
            } catch {
                /* ignore */
            }
        };
        state?.requests.add(destroy);
        req.once('close', untrack);

        req.setTimeout(timeoutMs || HTTP_TIMEOUT_MS, () => {
            req.destroy(new Error(`请求超时（${timeoutMs || HTTP_TIMEOUT_MS}ms）`));
        });
        req.on('error', (error) => {
            if (bodyWritten) error.requestBodyWritten = true;
            reject(error);
        });

        if (body) {
            bodyWritten = true;
            req.write(body);
        }
        req.end();
    });
}

/**
 * 发起请求。连接根本没建立时（Alma 刚启动 / 端口还没起）在
 * 127.0.0.1 与 localhost 之间重试；请求已发出则绝不重试，避免重复创建。
 */
async function request(method, pathname, payload, timeoutMs, state, logger) {
    throwIfCancelled(state);
    const url = new URL(resolveApiBase(logger));
    const port = Number(url.port) || DEFAULT_API_PORT;
    const hosts = [url.hostname === 'localhost' ? '127.0.0.1' : url.hostname, 'localhost'];
    let lastError;

    for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt += 1) {
        for (const host of hosts) {
            throwIfCancelled(state);
            try {
                const response = await rawRequest(
                    host,
                    port,
                    method,
                    pathname,
                    payload,
                    timeoutMs,
                    state
                );
                throwIfCancelled(state);
                return response;
            } catch (error) {
                lastError = error;
                if (isAbortError(error) || state?.cancelled) throw abortError();
                if (!isConnectError(error)) throw error;
            }
        }
        if (attempt < CONNECT_RETRIES) {
            await sleep(RETRY_DELAY_MS * attempt);
            throwIfCancelled(state);
        }
    }

    throw new Error(
        `无法连接 Alma 本地 API（http://127.0.0.1:${port}）：${errText(lastError)}`
    );
}

function errorDetail(response) {
    const body = response && response.json;
    let detail;
    if (body && typeof body === 'object') {
        if (body.error && typeof body.error === 'object') detail = body.error.message;
        if (!detail) detail = body.error;
        if (!detail) detail = body.message;
    } else if (typeof body === 'string') {
        detail = body;
    }
    if (typeof detail !== 'string' || !detail.trim()) {
        detail = typeof response?.text === 'string' ? response.text : '';
    }
    return redactSecrets(String(detail).trim()).slice(0, 300);
}

function assert2xx(response, action) {
    if (response.statusCode >= 200 && response.statusCode < 300) return response;
    const detail = errorDetail(response);
    throw new Error(`${action}失败：HTTP ${response.statusCode}${detail ? `（${detail}）` : ''}`);
}

function normalizeProviders(body) {
    if (Array.isArray(body)) return body;
    if (body && typeof body === 'object') {
        for (const key of ['providers', 'data', 'items']) {
            if (Array.isArray(body[key])) return body[key];
        }
    }
    return null;
}

async function listProviders(state, logger) {
    const response = assert2xx(
        await request('GET', '/api/providers', undefined, undefined, state, logger),
        '读取 provider 列表'
    );
    const providers = normalizeProviders(response.json);
    if (!providers) throw new Error('GET /api/providers 返回了无法识别的数据格式');
    return providers;
}

function normalizeModelIds(models) {
    if (!Array.isArray(models)) return [];
    return models
        .map((model) =>
            typeof model === 'string' ? model : model && typeof model === 'object' ? model.id : null
        )
        .filter((id) => typeof id === 'string' && id.length > 0);
}

/** 从 models/fetch 的返回值里提取模型列表（兼容几种常见包装）。 */
function extractFetchedModels(body) {
    const raw = Array.isArray(body)
        ? body
        : body && typeof body === 'object'
          ? body.models || body.data || body.availableModels || body.items || []
          : [];
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const models = [];
    for (const item of raw) {
        const id = typeof item === 'string' ? item : item && item.id;
        if (typeof id !== 'string' || !id || seen.has(id)) continue;
        seen.add(id);
        models.push({
            id,
            name: typeof item === 'string' ? item : item.name || id,
        });
    }
    return models;
}

function providerIdFromResponse(response) {
    const body = response && response.json;
    if (body && typeof body === 'object') {
        if (typeof body.id === 'string' || typeof body.id === 'number') {
            return String(body.id);
        }
        if (body.provider && (typeof body.provider.id === 'string' || typeof body.provider.id === 'number')) {
            return String(body.provider.id);
        }
    }
    const location = response?.headers?.location;
    if (typeof location === 'string') {
        const match = location.match(/\/api\/providers\/([^/?#]+)/);
        if (match) return decodeURIComponent(match[1]);
    }
    return null;
}

function providerTimestamp(provider) {
    for (const value of [provider?.createdAt, provider?.created_at, provider?.updatedAt, provider?.updated_at]) {
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        const time = new Date(value).getTime();
        if (Number.isFinite(time)) return time;
    }
    return 0;
}

function findLatestProviderByName(providers, name) {
    return providers
        .map((provider, index) => ({ provider, index }))
        .filter(({ provider }) => provider && provider.name === name)
        .sort((a, b) => {
            const timeDiff = providerTimestamp(b.provider) - providerTimestamp(a.provider);
            return timeDiff || b.index - a.index;
        })[0]?.provider;
}

async function resolveCreatedProvider(response, state, logger) {
    const directId = providerIdFromResponse(response);
    if (directId) return { id: directId, provider: null };

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const provider = findLatestProviderByName(
                await listProviders(state, logger),
                PROVIDER_NAME
            );
            if (provider && (typeof provider.id === 'string' || typeof provider.id === 'number')) {
                return { id: String(provider.id), provider };
            }
        } catch (error) {
            if (isAbortError(error) || state?.cancelled) throw abortError();
            lastError = error;
        }
        if (attempt < 3) {
            await sleep(300 * attempt);
            throwIfCancelled(state);
        }
    }
    if (lastError) {
        logger.warn(
            `[deepseek-harness-acp] 创建成功但反查 provider 失败：${redactSecrets(errText(lastError))}`
        );
    }
    return null;
}

function commandUrl(command) {
    if (typeof command !== 'string' || !command) return '';
    if (command === '~') return os.homedir();
    if (command.startsWith('~/')) return path.join(os.homedir(), command.slice(2));
    return command;
}

function commandIsUsable(command) {
    const expanded = commandUrl(command);
    if (!expanded) return false;
    if (expanded.includes('/')) return isExecutableFile(expanded);

    const searchPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
    return searchPath
        .split(path.delimiter)
        .filter(Boolean)
        .some((directory) => isExecutableFile(path.join(directory, expanded)));
}

/* ------------------------------------------------------------------ */
/* dsh 检测：候选 + 真实 ACP 握手                                       */
/* ------------------------------------------------------------------ */

function isExecutableFile(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return false;
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function pushCandidate(list, seen, candidatePath, source) {
    if (typeof candidatePath !== 'string' || !candidatePath) return;
    let resolved = candidatePath;
    try {
        resolved = fs.realpathSync(candidatePath);
    } catch {
        /* 保留原路径，后面 isExecutableFile 会判定 */
    }
    if (!isExecutableFile(resolved)) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    list.push({ path: resolved, source });
}

/**
 * 候选顺序：
 *   1. 环境变量 DSH_PATH（显式指定，只认它，不静默回退）
 *   2. macOS 应用内置 dsh
 *   3. PATH 里所有 dsh（which -a）
 */
function collectCandidates() {
    const list = [];
    const seen = new Set();

    if (process.env.DSH_PATH) {
        pushCandidate(list, seen, process.env.DSH_PATH, 'DSH_PATH');
        return list;
    }

    pushCandidate(list, seen, MAC_DSH_PATH, 'app');

    try {
        const output = execFileSync('which', ['-a', 'dsh'], {
            encoding: 'utf8',
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        for (const line of output.split(/\r?\n/)) {
            pushCandidate(list, seen, line.trim(), 'PATH');
        }
    } catch {
        /* PATH 里没有 dsh */
    }

    return list;
}

function stderrTail(buffer) {
    const lines = buffer
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    return redactSecrets(lines.slice(-2).join(' | ')).slice(0, 300);
}

/** 子进程绝不继承 provider key；只给 dsh 运行所需的最小环境。 */
function buildProbeEnv(source = process.env) {
    const env = {};
    for (const key of ['PATH', 'HOME', 'LANG', 'TERM']) {
        if (typeof source[key] === 'string') env[key] = source[key];
    }
    for (const [key, value] of Object.entries(source)) {
        if (key.startsWith('DSH_') && typeof value === 'string') env[key] = value;
    }
    env.NO_COLOR = '1';
    return env;
}

/**
 * 真正跑一次 `dsh --profile acp`，发 ACP initialize，能收到 result 才算可用。
 * 这一步能把“文件存在但一启动就崩”的 dsh 挡在门外。
 */
function probeAcp(command, state, options = {}) {
    return new Promise((resolve) => {
        if (state?.cancelled) {
            resolve({ ok: false, aborted: true, reason: '操作已取消' });
            return;
        }

        let settled = false;
        let timer = null;
        let writeTimer = null;
        let stabilityTimer = null;
        let child = null;
        let cancelProbe = null;
        let stdoutBuffer = '';
        let stderrBuffer = '';

        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (writeTimer) clearTimeout(writeTimer);
            if (stabilityTimer) clearTimeout(stabilityTimer);
            if (cancelProbe) state?.probes.delete(cancelProbe);
            try {
                child?.stdin?.end();
            } catch {
                /* ignore */
            }
            try {
                child?.kill('SIGKILL');
            } catch {
                /* ignore */
            }
            resolve(result);
        };

        cancelProbe = () =>
            finish({ ok: false, aborted: true, reason: '操作已取消' });
        state?.probes.add(cancelProbe);

        timer = setTimeout(
            () => finish({ ok: false, reason: `ACP 握手超时（${PROBE_TIMEOUT_MS}ms）` }),
            PROBE_TIMEOUT_MS
        );

        try {
            child = spawn(command, ACP_ARGS, {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: os.homedir() || process.cwd(),
                env: buildProbeEnv(),
                windowsHide: true,
            });
        } catch (error) {
            finish({ ok: false, reason: `无法启动进程：${errText(error)}` });
            return;
        }

        child.on('error', (error) => {
            finish({ ok: false, reason: `无法启动进程：${errText(error)}` });
        });

        child.on('exit', (code, signal) => {
            const tail = stderrTail(stderrBuffer);
            finish({
                ok: false,
                reason: `进程提前退出（code=${code}, signal=${signal || 'none'}）${
                    tail ? `：${tail}` : ''
                }`,
            });
        });

        child.stdin?.on('error', (error) => {
            finish({
                ok: false,
                reason: `写入 ACP initialize 失败：${errText(error)}`,
            });
        });

        child.stdout?.on('data', (chunk) => {
            stdoutBuffer += chunk.toString('utf8');
            if (stdoutBuffer.length > MAX_PROBE_BUFFER) {
                stdoutBuffer = stdoutBuffer.slice(-MAX_PROBE_BUFFER);
            }
            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('{')) continue;
                let message;
                try {
                    message = JSON.parse(trimmed);
                } catch {
                    continue;
                }
                if (message.id !== 1) continue;
                if (message.error) {
                    finish({
                        ok: false,
                        reason: `initialize 返回错误：${
                            message.error.message || JSON.stringify(message.error)
                        }`,
                    });
                    return;
                }
                if (message.result) {
                    if (!stabilityTimer) {
                        stabilityTimer = setTimeout(() => {
                            const agent = message.result.agentInfo || {};
                            finish({ ok: true, agentInfo: agent });
                        }, PROBE_STABILITY_MS);
                    }
                }
            }
        });
        child.stdout?.on('error', (error) => {
            finish({ ok: false, reason: `读取 ACP stdout 失败：${errText(error)}` });
        });

        child.stderr?.on('data', (chunk) => {
            stderrBuffer += chunk.toString('utf8');
            if (stderrBuffer.length > MAX_PROBE_BUFFER) {
                stderrBuffer = stderrBuffer.slice(-MAX_PROBE_BUFFER);
            }
        });
        child.stderr?.on('error', (error) => {
            finish({ ok: false, reason: `读取 ACP stderr 失败：${errText(error)}` });
        });

        writeTimer = setTimeout(() => {
            if (settled) return;
            const initRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: 1,
                    capabilities: {},
                    clientInfo: {
                        name: PLUGIN_NAME,
                        version: PLUGIN_VERSION,
                    },
                },
            };
            try {
                if (!child.stdin || child.stdin.destroyed) {
                    throw new Error('stdin 已关闭');
                }
                child.stdin.write(`${JSON.stringify(initRequest)}\n`, (error) => {
                    if (error) {
                        finish({ ok: false, reason: `写入 initialize 失败：${errText(error)}` });
                    }
                });
            } catch (error) {
                finish({ ok: false, reason: `写入 initialize 失败：${errText(error)}` });
            }
        }, options.writeDelayMs ?? PROBE_WRITE_DELAY_MS);
    });
}

/**
 * 挑一个真能跑的 dsh。返回 { ok, path, agentInfo, failures }。
 */
async function pickWorkingDsh(logger, state) {
    throwIfCancelled(state);
    const candidates = collectCandidates();
    if (candidates.length === 0) {
        return {
            ok: false,
            failures: [],
            reason: process.env.DSH_PATH
                ? `DSH_PATH 指向的路径不存在或不可执行：${process.env.DSH_PATH}`
                : '未找到 dsh（应用内置路径和 PATH 都没有）',
        };
    }

    const failures = [];
    for (const candidate of candidates) {
        throwIfCancelled(state);
        const result = await probeAcp(candidate.path, state);
        throwIfCancelled(state);
        if (result.ok) {
            logger.info(
                `[deepseek-harness-acp] 使用 dsh：${candidate.path}（来源 ${candidate.source}，agent ${
                    result.agentInfo?.name || 'unknown'
                } ${result.agentInfo?.version || ''}）`
            );
            return { ok: true, path: candidate.path, agentInfo: result.agentInfo, failures };
        }
        const detail = `${candidate.path}（${candidate.source}）：${result.reason}`;
        failures.push(detail);
        logger.warn(`[deepseek-harness-acp] 候选 dsh 不可用：${detail}`);
    }

    return {
        ok: false,
        failures,
        reason:
            failures.length === 1
                ? `找到的 dsh 无法启动 ACP：${failures[0]}`
                : `${failures.length} 个 dsh 候选都无法启动 ACP`,
    };
}

/* ------------------------------------------------------------------ */
/* 跨实例互斥：避免 Alma 刷新插件时两个实例同时创建出重复 provider       */
/* ------------------------------------------------------------------ */

function lockFilePath() {
    return path.join(almaConfigDir(), 'deepseek-harness-acp.lock');
}

function readLockFile(file = lockFilePath()) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const stat = fs.statSync(file);
        let record = null;
        try {
            record = JSON.parse(raw);
        } catch {
            /* 旧版本或损坏的锁仍可按 mtime 处理 */
        }
        return { file, raw, stat, record };
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        return { file, raw: null, stat: null, record: null, error };
    }
}

function pidIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

function createLockHandle() {
    const file = lockFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, 'wx', 0o600);
    const nonce = randomUUID();
    const record = { pid: process.pid, nonce, at: Date.now() };
    try {
        fs.writeFileSync(fd, JSON.stringify(record));
        fs.fsyncSync(fd);
    } catch (error) {
        try {
            fs.closeSync(fd);
        } catch {
            /* ignore */
        }
        try {
            fs.unlinkSync(file);
        } catch {
            /* ignore */
        }
        throw error;
    }
    return { file, fd, nonce, heartbeat: null, closed: false };
}

function restoreMovedLock(movedFile) {
    const file = lockFilePath();
    try {
        fs.linkSync(movedFile, file);
    } catch {
        /* 已经有新锁则不能覆盖 */
    }
    try {
        fs.unlinkSync(movedFile);
    } catch {
        /* ignore */
    }
}

function takeOverStaleLock(snapshot, logger) {
    const file = lockFilePath();
    const movedFile = `${file}.stale-${process.pid}-${randomUUID()}`;
    try {
        fs.renameSync(file, movedFile);
    } catch (error) {
        if (error?.code === 'ENOENT') return createLockHandle();
        return null;
    }

    const moved = readLockFile(movedFile);
    if (!moved || moved.raw !== snapshot.raw) {
        restoreMovedLock(movedFile);
        return null;
    }

    try {
        logger?.warn?.('[deepseek-harness-acp] 接管过期锁（原持锁进程已不存在）。');
        return createLockHandle();
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        return null;
    } finally {
        try {
            fs.unlinkSync(movedFile);
        } catch {
            /* ignore */
        }
    }
}

function tryLock(logger) {
    try {
        return createLockHandle();
    } catch (error) {
        if (error?.code !== 'EEXIST') {
            logger?.warn?.(
                `[deepseek-harness-acp] 获取注册锁失败：${redactSecrets(errText(error))}`
            );
            return null;
        }
    }

    const snapshot = readLockFile();
    if (!snapshot || !snapshot.stat) return null;

    const ownerPid = Number(snapshot.record?.pid);
    if (pidIsAlive(ownerPid)) return null;
    if (Date.now() - snapshot.stat.mtimeMs <= LOCK_STALE_MS) return null;
    return takeOverStaleLock(snapshot, logger);
}

function heartbeatLock(handle, logger) {
    if (!handle || handle.closed) return false;
    try {
        const fdStat = fs.fstatSync(handle.fd);
        const pathStat = fs.statSync(handle.file);
        if (fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) {
            logger?.warn?.('[deepseek-harness-acp] 注册锁已被接管，停止心跳。');
            return false;
        }
        const now = new Date();
        fs.futimesSync(handle.fd, now, now);
        return true;
    } catch (error) {
        logger?.warn?.(
            `[deepseek-harness-acp] 注册锁心跳失败：${redactSecrets(errText(error))}`
        );
        return false;
    }
}

function startLockHeartbeat(handle, logger) {
    handle.heartbeat = setInterval(() => {
        if (!heartbeatLock(handle, logger)) {
            clearInterval(handle.heartbeat);
            handle.heartbeat = null;
        }
    }, LOCK_HEARTBEAT_MS);
    handle.heartbeat.unref?.();
}

async function acquireLock(context, logger, state) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
        throwIfCancelled(state);
        const handle = tryLock(logger);
        if (handle) {
            startLockHeartbeat(handle, logger);
            state.lock = handle;
            return handle;
        }
        await sleep(LOCK_RETRY_MS);
        throwIfCancelled(state);
    }
    logger.warn('[deepseek-harness-acp] 另一个实例正在注册，本次跳过。');
    notify(
        context,
        '另一个 DeepSeek Harness ACP 注册实例正在运行，本次跳过。',
        'warning',
        state
    );
    return null;
}

function releaseLock(handle, logger) {
    if (!handle) return false;
    if (handle.heartbeat) clearInterval(handle.heartbeat);

    let released = false;
    try {
        const current = readLockFile(handle.file);
        if (!current) return false;
        if (!current.record || current.record.nonce !== handle.nonce) {
            logger?.warn?.(
                '[deepseek-harness-acp] 注册锁归属已变化，跳过删除（不碰其他实例的锁）。'
            );
            return false;
        }
        fs.unlinkSync(handle.file);
        released = true;
    } catch (error) {
        logger?.warn?.(
            `[deepseek-harness-acp] 释放注册锁失败：${redactSecrets(errText(error))}`
        );
    } finally {
        if (!handle.closed) {
            handle.closed = true;
            try {
                fs.closeSync(handle.fd);
            } catch {
                /* ignore */
            }
        }
    }
    return released;
}

/* ------------------------------------------------------------------ */
/* provider 对齐                                                        */
/* ------------------------------------------------------------------ */

function commandLooksLikeDsh(command) {
    if (typeof command !== 'string' || !command) return false;
    const lower = command.toLowerCase();
    return /(^|\/)dsh(\.js)?$/.test(lower) || lower.includes('deepseek harness');
}

function isDshProvider(provider) {
    if (!provider || provider.type !== 'acp') return false;
    if (typeof provider.name === 'string' && provider.name.toLowerCase().includes(PROVIDER_NAME_HINT)) {
        return true;
    }
    return commandLooksLikeDsh(provider.acpCommand);
}

function sameArgs(args) {
    if (!Array.isArray(args) || args.length !== ACP_ARGS.length) return false;
    return args.every((arg, index) => arg === ACP_ARGS[index]);
}

async function testProvider(providerId, logger, state) {
    let lastReason = '未知原因';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        throwIfCancelled(state);
        try {
            const response = await request(
                'POST',
                `/api/providers/${encodeURIComponent(providerId)}/test`,
                undefined,
                PROVIDER_TEST_TIMEOUT_MS,
                state,
                logger
            );
            throwIfCancelled(state);
            if (response.statusCode >= 200 && response.statusCode < 300) {
                const body = response.json;
                if (!body || body.success !== false) {
                    logger.info(
                        `[deepseek-harness-acp] 连接测试通过（${
                            body && body.latencyMs != null ? `${body.latencyMs}ms` : 'ok'
                        }）`
                    );
                    return { ok: true };
                }
                lastReason = String(body.error || '测试返回 success=false');
            } else {
                lastReason = `HTTP ${response.statusCode}${
                    errorDetail(response) ? `：${errorDetail(response)}` : ''
                }`;
            }
        } catch (error) {
            if (isAbortError(error) || state?.cancelled) throw abortError();
            lastReason = errText(error);
        }
        if (attempt === 1) {
            await sleep(1000);
            throwIfCancelled(state);
        }
    }
    logger.warn(
        `[deepseek-harness-acp] 连接测试失败：${redactSecrets(lastReason)}`
    );
    return { ok: false, reason: redactSecrets(lastReason) };
}

async function deleteProvider(providerId, logger, state) {
    let lastReason = '未知原因';
    for (let attempt = 1; attempt <= DELETE_RETRIES; attempt += 1) {
        throwIfCancelled(state);
        try {
            const response = await request(
                'DELETE',
                `/api/providers/${encodeURIComponent(providerId)}`,
                undefined,
                HTTP_TIMEOUT_MS,
                state,
                logger
            );
            throwIfCancelled(state);
            if (
                (response.statusCode >= 200 && response.statusCode < 300) ||
                response.statusCode === 404
            ) {
                logger.info(`[deepseek-harness-acp] 已回滚删除 provider（id=${providerId}）`);
                return { ok: true };
            }
            lastReason = `HTTP ${response.statusCode}${errorDetail(response) ? ` ${errorDetail(response)}` : ''}`;
        } catch (error) {
            if (isAbortError(error) || state?.cancelled) throw abortError();
            lastReason = errText(error);
        }
        if (attempt < DELETE_RETRIES) {
            logger.warn(
                `[deepseek-harness-acp] 回滚 DELETE 第 ${attempt} 次失败，将重试：${redactSecrets(lastReason)}`
            );
            await sleep(DELETE_RETRY_DELAY_MS * attempt);
            throwIfCancelled(state);
        }
    }
    logger.warn(
        `[deepseek-harness-acp] 回滚 DELETE 重试耗尽：${redactSecrets(lastReason)}`
    );
    return { ok: false, reason: redactSecrets(lastReason) };
}

async function disableProvider(providerId, logger, state) {
    throwIfCancelled(state);
    try {
        const response = await request(
            'PUT',
            `/api/providers/${encodeURIComponent(providerId)}`,
            { enabled: false },
            HTTP_TIMEOUT_MS,
            state,
            logger
        );
        throwIfCancelled(state);
        if (response.statusCode === 404) return true;
        assert2xx(response, '禁用 provider');
        return true;
    } catch (error) {
        if (isAbortError(error) || state?.cancelled) throw abortError();
        logger.warn(
            `[deepseek-harness-acp] 禁用 provider 失败：${redactSecrets(errText(error))}`
        );
        return false;
    }
}

async function enableProvider(providerId, logger, state) {
    throwIfCancelled(state);
    try {
        const response = await request(
            'PUT',
            `/api/providers/${encodeURIComponent(providerId)}`,
            { enabled: true },
            HTTP_TIMEOUT_MS,
            state,
            logger
        );
        throwIfCancelled(state);
        if (response.statusCode === 404) {
            logger.warn(
                `[deepseek-harness-acp] 启用 provider 失败：provider 不存在（id=${providerId}）`
            );
            return { ok: false, reason: 'provider 不存在' };
        }
        assert2xx(response, '启用 provider');
        return { ok: true };
    } catch (error) {
        if (isAbortError(error) || state?.cancelled) throw abortError();
        const reason = redactSecrets(errText(error));
        logger.warn(
            `[deepseek-harness-acp] 启用 provider 失败（id=${providerId}）：${reason}`
        );
        return { ok: false, reason };
    }
}

async function rollbackCreatedProvider(context, logger, state, providerId, testReason) {
    logger.warn(
        `[deepseek-harness-acp] 新建 provider 测试失败，开始回滚：${redactSecrets(testReason)}`
    );
    const deleted = await deleteProvider(providerId, logger, state);
    throwIfCancelled(state);

    if (deleted.ok) {
        notify(
            context,
            `新建 provider 连接测试失败，已回滚删除（id=${providerId}）。`,
            'warning',
            state
        );
        const error = new Error('新建 provider 连接测试失败，已回滚删除。');
        error.notified = true;
        error.rollback = 'deleted';
        throw error;
    }

    const disabled = await disableProvider(providerId, logger, state);
    throwIfCancelled(state);
    if (disabled) {
        notify(
            context,
            `新建 provider 连接测试失败，DELETE 未成功，已禁用 provider（id=${providerId}）。请到设置中手动删除。`,
            'error',
            state
        );
        const error = new Error('DELETE 回滚失败，provider 已禁用。');
        error.notified = true;
        error.rollback = 'disabled';
        throw error;
    }

    notify(
        context,
        `新建 provider 连接测试失败，DELETE 和禁用都失败（id=${providerId}）。请立即到设置中检查并手动处理。`,
        'error',
        state
    );
    const error = new Error('DELETE 回滚和禁用 provider 均失败。');
    error.notified = true;
    error.rollback = 'failed';
    throw error;
}

/**
 * 保证 provider 有可用模型。Alma 不会替 ACP provider 自动发现模型，
 * 空列表会让它在模型选择器里直接消失。
 */
async function ensureModels(providerId, logger, state, context) {
    try {
        throwIfCancelled(state);
        const providers = await listProviders(state, logger);
        throwIfCancelled(state);
        const provider = providers.find(
            (item) => item && String(item.id) === String(providerId)
        );
        if (normalizeModelIds(provider?.models).length > 0) {
            return { ok: true, changed: false };
        }

        let models = [];
        try {
            const fetched = assert2xx(
                await request(
                    'POST',
                    `/api/providers/${encodeURIComponent(providerId)}/models/fetch`,
                    undefined,
                    MODELS_FETCH_TIMEOUT_MS,
                    state,
                    logger
                ),
                '拉取模型'
            );
            throwIfCancelled(state);
            models = extractFetchedModels(fetched.json);
        } catch (error) {
            if (isAbortError(error) || state?.cancelled) throw abortError();
            logger.warn(
                `[deepseek-harness-acp] 拉取模型失败，使用默认模型：${redactSecrets(errText(error))}`
            );
        }

        throwIfCancelled(state);
        if (models.length === 0) models = [{ ...FALLBACK_MODEL }];

        assert2xx(
            await request(
                'PUT',
                `/api/providers/${encodeURIComponent(providerId)}/models`,
                { models },
                HTTP_TIMEOUT_MS,
                state,
                logger
            ),
            '启用模型'
        );
        throwIfCancelled(state);
        logger.info(
            `[deepseek-harness-acp] 已启用模型：${models.map((model) => model.id).join(', ')}`
        );
        return { ok: true, changed: true };
    } catch (error) {
        if (isAbortError(error) || state?.cancelled) throw abortError();
        const reason = redactSecrets(errText(error));
        logger.warn(`[deepseek-harness-acp] 模型列表设置失败：${reason}`);
        notify(
            context,
            `DeepSeek Harness provider 已就绪，但模型列表为空，请手动添加（id=${providerId}）。`,
            'warning',
            state
        );
        return { ok: false, reason };
    }
}

/**
 * 主流程：检测 → 对齐或创建 → 测试 → 启用模型。
 * 失败时抛错，由 activate 统一通知。
 */
async function createProvider(context, logger, state, dshPath) {
    throwIfCancelled(state);
    const created = assert2xx(
        await request(
            'POST',
            '/api/providers',
            {
                name: PROVIDER_NAME,
                type: 'acp',
                acpCommand: dshPath,
                acpArgs: ACP_ARGS.slice(),
                // 先保持禁用；只有连接测试通过、模型步骤收尾后才启用。
                // 这样即使 POST 响应不可解析且反查失败，也不会留下 enabled 的僵尸条目。
                enabled: false,
            },
            HTTP_TIMEOUT_MS,
            state,
            logger
        ),
        '创建 ACP provider'
    );
    throwIfCancelled(state);

    const resolved = await resolveCreatedProvider(created, state, logger);
    throwIfCancelled(state);
    if (!resolved) {
        logger.error(
            '[deepseek-harness-acp] POST 创建成功但拿不到 id，且按名称反查不到 provider。'
        );
        notify(
            context,
            'provider 创建结果无法确认（未返回 id，列表反查也失败）；新条目保持禁用。请到设置检查后点 Refresh。',
            'error',
            state
        );
        return { status: 'created-unknown', providerId: null, dshPath };
    }

    const providerId = resolved.id;
    logger.info(`[deepseek-harness-acp] 已创建 ACP provider（id=${providerId}）`);

    const tested = await testProvider(providerId, logger, state);
    throwIfCancelled(state);
    if (!tested.ok) {
        await rollbackCreatedProvider(context, logger, state, providerId, tested.reason);
    }

    const models = await ensureModels(providerId, logger, state, context);
    throwIfCancelled(state);
    const enabled = await enableProvider(providerId, logger, state);
    throwIfCancelled(state);
    if (!enabled.ok) {
        notify(
            context,
            `provider 已创建并通过连接测试，但自动启用失败（id=${providerId}）。请 Refresh 重试或到设置中手动启用。`,
            'error',
            state
        );
    } else if (models.ok) {
        notify(
            context,
            `已把 DeepSeek Harness 注册为 ACP provider（id=${providerId}），连接测试通过。`,
            'success',
            state
        );
    }
    return {
        status: enabled.ok ? 'created' : 'created-disabled',
        providerId,
        dshPath,
        enabled: enabled.ok,
        modelsEnabled: models.ok,
    };
}

function chooseExistingTarget(matches, dshPath) {
    const exact = matches.filter((provider) => provider.name === PROVIDER_NAME);
    const pool = exact.length > 0 ? exact : matches;
    return pool.find((provider) => provider.acpCommand === dshPath) || pool[0];
}

async function alignExistingProvider(
    context,
    logger,
    state,
    dshPath,
    matches
) {
    const target = chooseExistingTarget(matches, dshPath);
    const providerId = String(target.id);
    const managed = target.name === PROVIDER_NAME;
    const patch = {};

    if (managed && !commandIsUsable(target.acpCommand)) {
        patch.acpCommand = dshPath;
        if (!sameArgs(target.acpArgs)) patch.acpArgs = ACP_ARGS.slice();
    }

    let changed = false;
    if (Object.keys(patch).length > 0) {
        throwIfCancelled(state);
        logger.info(
            `[deepseek-harness-acp] 修正已有 provider（id=${providerId}）：${Object.keys(patch).join(', ')}`
        );
        assert2xx(
            await request(
                'PUT',
                `/api/providers/${encodeURIComponent(providerId)}`,
                patch,
                HTTP_TIMEOUT_MS,
                state,
                logger
            ),
            '更新 ACP provider'
        );
        throwIfCancelled(state);
        changed = true;
    }

    const tested = await testProvider(providerId, logger, state);
    throwIfCancelled(state);
    if (!tested.ok) {
        notify(
            context,
            `已有 DeepSeek Harness provider（id=${providerId}）连接测试失败；配置未被删除，详情见日志。`,
            'error',
            state
        );
        return { status: 'existing-test-failed', providerId };
    }

    let modelsEnabled = null;
    if (managed) {
        const models = await ensureModels(providerId, logger, state, context);
        throwIfCancelled(state);
        changed = changed || models.changed;
        modelsEnabled = models.ok;
        if (target.enabled === false) {
            const enabled = await enableProvider(providerId, logger, state);
            throwIfCancelled(state);
            if (!enabled.ok) {
                notify(
                    context,
                    `已有 DeepSeek Harness provider（id=${providerId}）连接测试通过，但自动启用失败；配置未被删除。请到设置中手动启用。`,
                    'error',
                    state
                );
                return {
                    status: 'existing-disabled',
                    providerId,
                    dshPath,
                    patched: Object.keys(patch),
                    modelsEnabled,
                };
            }
            changed = true;
        }
    } else {
        logger.info(
            '[deepseek-harness-acp] 命中的是模糊匹配条目；仅识别与测试，不修改其配置。'
        );
    }

    if (matches.length > 1) {
        logger.warn(
            `[deepseek-harness-acp] 发现 ${matches.length} 个匹配的 provider，插件不会删除多出来的那些。`
        );
    }

    logger.info('[deepseek-harness-acp] provider 已就绪，无需重复创建。');
    if (changed) {
        notify(
            context,
            `DeepSeek Harness 已注册为 ACP provider（id=${providerId}，已自动修正配置），连接测试通过。`,
            'info',
            state
        );
    }
    return {
        status: 'existing',
        providerId,
        dshPath,
        patched: Object.keys(patch),
        modelsEnabled,
    };
}

async function run(context, logger, state) {
    logger.info('[deepseek-harness-acp] 开始检测 DeepSeek Harness…');
    throwIfCancelled(state);

    const picked = await pickWorkingDsh(logger, state);
    throwIfCancelled(state);
    if (!picked.ok) {
        logger.warn(`[deepseek-harness-acp] ${picked.reason}`);
        for (const failure of picked.failures || []) {
            logger.warn(`[deepseek-harness-acp] ${failure}`);
        }
        notify(
            context,
            '未检测到可用的 DeepSeek Harness（dsh）。请安装，或确保 dsh 在 PATH 中后点 Refresh。详情见日志。',
            'warning',
            state
        );
        return { status: 'no-dsh' };
    }

    throwIfCancelled(state);
    const dshPath = picked.path;
    const providers = await listProviders(state, logger);
    throwIfCancelled(state);
    const matches = providers.filter(isDshProvider);

    if (matches.length === 0) {
        const rechecked = await listProviders(state, logger);
        throwIfCancelled(state);
        const recheckedMatches = rechecked.filter(isDshProvider);
        if (recheckedMatches.length > 0) {
            return alignExistingProvider(
                context,
                logger,
                state,
                dshPath,
                recheckedMatches
            );
        }
        return createProvider(context, logger, state, dshPath);
    }

    return alignExistingProvider(context, logger, state, dshPath, matches);
}

/* ------------------------------------------------------------------ */
/* 激活入口                                                            */
/* ------------------------------------------------------------------ */

async function activate(context) {
    const logger = createLogger(context);
    const state = createRunState();

    logger.info('[deepseek-harness-acp] 插件启动');

    // 后台执行，绝不阻塞 Alma 启动（Alma 会 await 每个插件的 activate）。
    const runPromise = Promise.resolve()
        .then(async () => {
            const locked = await acquireLock(context, logger, state);
            if (!locked) return { status: 'locked' };
            try {
                throwIfCancelled(state);
                return await run(context, logger, state);
            } finally {
                releaseLock(state.lock, logger);
                state.lock = null;
            }
        })
        .catch((error) => {
            if (isAbortError(error) || state.cancelled) {
                logger.info('[deepseek-harness-acp] 注册流程已取消');
                return { status: 'cancelled' };
            }
            const detail = redactSecrets(errText(error));
            logger.error(`[deepseek-harness-acp] 注册失败：${detail}`);
            if (!error?.notified && !state.cancelled) {
                notify(
                    context,
                    '注册 DeepSeek Harness ACP provider 失败，详情见日志。',
                    'error',
                    state
                );
            }
            return { status: 'error', error: detail };
        });

    // 供测试 / 调试等待后台流程用，Alma 本身不依赖它。
    activate.lastRun = runPromise;

    let disposing = null;
    return {
        // Alma 只用到 dispose；ready 供测试/调试等待后台流程结束。
        ready: runPromise,
        dispose() {
            if (disposing) return disposing;
            cancelRunState(state);
            logger.info('[deepseek-harness-acp] 插件已停用');
            disposing = new Promise((resolve) => {
                let timeout = null;
                const timerPromise = new Promise((timerResolve) => {
                    timeout = setTimeout(() => timerResolve(false), DISPOSE_WAIT_MS);
                });
                Promise.race([
                    runPromise.then(
                        () => true,
                        () => true
                    ),
                    timerPromise,
                ]).then((completed) => {
                    if (timeout) clearTimeout(timeout);
                    logger.info(
                        completed
                            ? '[deepseek-harness-acp] 后台注册流程已停止'
                            : '[deepseek-harness-acp] 后台注册流程未在 3 秒内结束（已取消，继续在后台收尾）'
                    );
                    resolve(completed);
                });
            });
            return disposing;
        },
    };
}

// 测试钩子：暴露内部函数，便于在真实 API 上做集成测试。
export const __internal = {
    PLUGIN_VERSION,
    PROVIDER_NAME,
    ACP_ARGS,
    DISPOSE_WAIT_MS,
    LOCK_HEARTBEAT_MS,
    LOCK_STALE_MS,
    LOCK_WAIT_MS,
    collectCandidates,
    probeAcp,
    pickWorkingDsh,
    isDshProvider,
    sameArgs,
    commandIsUsable,
    buildProbeEnv,
    redactSecrets,
    isConnectError,
    request,
    listProviders,
    testProvider,
    deleteProvider,
    disableProvider,
    enableProvider,
    ensureModels,
    findLatestProviderByName,
    providerIdFromResponse,
    resolveApiBase,
    extractFetchedModels,
    normalizeModelIds,
    createRunState,
    cancelRunState,
    throwIfCancelled,
    lockFilePath,
    readLockFile,
    tryLock,
    acquireLock,
    releaseLock,
    heartbeatLock,
    pidIsAlive,
};

export { activate };
export default activate;
