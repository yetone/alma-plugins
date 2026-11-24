import { spawn } from 'node:child_process';

const MAX_STDOUT_BUFFER = 1024 * 1024;
const MAX_STDERR_BUFFER = 16384;

function asText(content) {
    if (typeof content === 'string') return content;
    if (!content || typeof content !== 'object') return '';
    if (content.type === 'text' && typeof content.text === 'string') {
        return content.text;
    }
    if (Array.isArray(content)) return content.map(asText).join('');
    return '';
}

function rpcFailure(method, error) {
    const detail =
        error && typeof error === 'object'
            ? error.message || JSON.stringify(error)
            : String(error);
    return new Error(`${method} 失败：${detail}`);
}

/**
 * 直接驱动 ACP agent：initialize → session/new → session/prompt。
 * 不经过 Alma 的 /api/chat/completions，用于验证 ACP 本身能返回真实模型文本。
 */
export function runAcpPrompt({
    command,
    args = [],
    cwd = process.cwd(),
    env = process.env,
    prompt,
    timeoutMs = 180000,
    clientInfo = {
        name: 'deepseek-harness-acp-integration',
        version: '0.2.1',
    },
    logger = null,
}) {
    if (typeof command !== 'string' || !command) {
        return Promise.reject(new Error('runAcpPrompt 需要可执行的 ACP command'));
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
        return Promise.reject(new Error('runAcpPrompt 需要非空 prompt'));
    }

    return new Promise((resolve, reject) => {
        let child = null;
        let settled = false;
        let nextId = 1;
        let stdoutBuffer = '';
        let stderrBuffer = '';
        let sessionId = null;
        const textChunks = [];
        const pending = new Map();
        const timer = setTimeout(
            () => finishError(new Error(`ACP prompt 超时（${timeoutMs}ms）`)),
            timeoutMs
        );

        const cleanup = () => {
            clearTimeout(timer);
            for (const entry of pending.values()) {
                entry.reject(new Error(`ACP 请求未完成：${entry.method}`));
            }
            pending.clear();
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
        };

        const finishError = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };

        const finishSuccess = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };

        const write = (message) => {
            if (settled) return false;
            try {
                if (!child?.stdin || child.stdin.destroyed) {
                    throw new Error('ACP stdin 已关闭');
                }
                child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
                    if (error) {
                        finishError(
                            new Error(`写入 ACP 消息失败：${error.message || String(error)}`)
                        );
                    }
                });
                return true;
            } catch (error) {
                finishError(new Error(`写入 ACP 消息失败：${error.message || String(error)}`));
                return false;
            }
        };

        const send = (method, params) =>
            new Promise((requestResolve, requestReject) => {
                const id = nextId;
                nextId += 1;
                pending.set(id, {
                    method,
                    resolve: requestResolve,
                    reject: requestReject,
                });
                if (
                    !write({
                        jsonrpc: '2.0',
                        id,
                        method,
                        params,
                    })
                ) {
                    pending.delete(id);
                }
            });

        const respond = (id, result) =>
            write({ jsonrpc: '2.0', id, result });

        const respondError = (id, code, message) =>
            write({
                jsonrpc: '2.0',
                id,
                error: { code, message },
            });

        const handleMessage = (message) => {
            if (!message || typeof message !== 'object') return;

            if (message.method) {
                if (message.method === 'session/update') {
                    const update = message.params?.update;
                    if (
                        update?.sessionUpdate === 'agent_message_chunk' &&
                        update.content
                    ) {
                        textChunks.push(asText(update.content));
                    }
                    return;
                }

                if (message.method === 'session/request_permission') {
                    const options = Array.isArray(message.params?.options)
                        ? message.params.options
                        : [];
                    const allow =
                        options.find((option) => option?.kind === 'allow_once') ||
                        options.find((option) => /allow/i.test(option?.kind || '')) ||
                        null;
                    if (allow?.optionId && message.id != null) {
                        respond(message.id, {
                            outcome: {
                                outcome: 'selected',
                                optionId: allow.optionId,
                            },
                        });
                    } else if (message.id != null) {
                        respond(message.id, { outcome: { outcome: 'cancelled' } });
                    }
                    return;
                }

                if (message.id != null) {
                    respondError(
                        message.id,
                        -32601,
                        `不支持的 ACP client method：${message.method}`
                    );
                }
                return;
            }

            if (message.id == null || !pending.has(message.id)) return;
            const entry = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) {
                entry.reject(rpcFailure(entry.method, message.error));
            } else {
                entry.resolve(message.result);
            }
        };

        try {
            child = spawn(command, args, {
                cwd,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (error) {
            finishError(
                new Error(`无法启动 ACP agent：${error.message || String(error)}`)
            );
            return;
        }

        child.on('error', (error) => {
            finishError(new Error(`ACP agent 启动失败：${error.message || String(error)}`));
        });

        child.on('exit', (code, signal) => {
            if (settled) return;
            const tail = stderrBuffer
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .slice(-3)
                .join(' | ');
            finishError(
                new Error(
                    `ACP agent 提前退出（code=${code}, signal=${signal || 'none'}）${
                        tail ? `：${tail}` : ''
                    }`
                )
            );
        });

        child.stdin?.on('error', (error) => {
            finishError(new Error(`ACP stdin 写入失败：${error.message || String(error)}`));
        });

        child.stdout?.on('error', (error) => {
            finishError(new Error(`读取 ACP stdout 失败：${error.message || String(error)}`));
        });

        child.stderr?.on('error', (error) => {
            finishError(new Error(`读取 ACP stderr 失败：${error.message || String(error)}`));
        });

        child.stdout?.on('data', (chunk) => {
            stdoutBuffer += chunk.toString('utf8');
            if (stdoutBuffer.length > MAX_STDOUT_BUFFER) {
                finishError(new Error('ACP stdout 超过 1 MiB 上限'));
                return;
            }
            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                let message;
                try {
                    message = JSON.parse(trimmed);
                } catch {
                    continue;
                }
                handleMessage(message);
            }
        });

        child.stderr?.on('data', (chunk) => {
            stderrBuffer += chunk.toString('utf8');
            if (stderrBuffer.length > MAX_STDERR_BUFFER) {
                stderrBuffer = stderrBuffer.slice(-MAX_STDERR_BUFFER);
            }
        });

        (async () => {
            const initialized = await send('initialize', {
                protocolVersion: 1,
                capabilities: {},
                clientInfo,
            });
            logger?.info?.(
                `[acp-direct] initialize 通过：${initialized?.agentInfo?.name || 'unknown'} ${
                    initialized?.agentInfo?.version || ''
                }`
            );

            const created = await send('session/new', {
                cwd,
                mcpServers: [],
            });
            sessionId = created?.sessionId;
            if (typeof sessionId !== 'string' || !sessionId) {
                throw new Error('session/new 未返回 sessionId');
            }
            logger?.info?.(`[acp-direct] session/new 通过：${sessionId}`);

            const promptResponse = await send('session/prompt', {
                sessionId,
                prompt: [{ type: 'text', text: prompt }],
            });
            const content = textChunks.join('').trim();

            finishSuccess({
                transport: 'acp-direct',
                command,
                agentInfo: initialized?.agentInfo || null,
                protocolVersion: initialized?.protocolVersion ?? null,
                sessionId,
                stopReason: promptResponse?.stopReason ?? null,
                content,
            });
        })().catch((error) => {
            finishError(error instanceof Error ? error : new Error(String(error)));
        });
    });
}

export const __internal = {
    asText,
};
