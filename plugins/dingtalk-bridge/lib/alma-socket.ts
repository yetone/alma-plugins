/**
 * Alma 内部 WebSocket 协议桥
 *
 * Alma 没有公开「发送消息」的 API：/api/chat/completions 是裸 LLM 代理，
 * 不跑工具循环。真正驱动完整 agent turn 的是 ws://127.0.0.1:PORT/ws/threads
 * 上的 generate_response 消息。
 *
 * 协议（逆向所得，无官方文档）：
 *   发送 → { type: 'generate_response', data: { threadId, model, userMessage, ephemeralContext, source } }
 *   停止 → { type: 'stop_generation',  data: { threadId } }
 *   接收 → message_added / message_delta / generation_completed / generation_error
 *
 * message_delta.data.deltas[] 里：
 *   text_append            { partType: 'text', text }
 *   tool_input_append      { inputKey, text }
 *   part_update            { updates: { input, toolName? } }
 *   tool_output_streaming  { stream: { stdout } }
 *
 * 注意：工具名不在 delta 里，只出现在 message_added 的 part.type（"tool-Bash"）。
 */
import type { TurnState } from './types';

const EPHEMERAL_CONTEXT = [
    '[System: 你正在通过「钉钉」渠道与用户对话。',
    '',
    '回复格式要求：',
    '- 钉钉对 Markdown 支持有限，只支持粗体、链接、有序/无序列表和行内代码。',
    '- 不要使用 Markdown 表格、标题（#）、引用块（>）和分割线，它们会显示为原始符号。',
    '- 不要使用 HTML 标签和图片语法。',
    '- 代码块可以用三个反引号，但注意移动端宽度，尽量保持行短。',
    '- 回复保持紧凑，避免大段长篇。',
    '',
    '能力说明：',
    '- 你拥有完整工具能力，可以读写本地文件、执行命令、操作绑定项目的工作区。',
    '- 如果生成了文件，在回复里说明文件路径即可，用户可以在本机直接查看。',
    '- 不要声称自己无法发送文件或无法访问本地环境。',
    ']',
].join('\n');

export interface SocketLogger {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
}

export interface SocketCallbacks {
    onTextDelta: (turn: TurnState, text: string) => void;
    onToolAnnounce: (turn: TurnState, toolName: string) => void;
    onToolOutput: (turn: TurnState, stdout: string) => void;
    onComplete: (turn: TurnState, data: any) => void;
    onError: (turn: TurnState, message: string) => void;
    onStateChange?: (connected: boolean) => void;
}

const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30000;
const CONNECT_WAIT_MS = 5000;

export class AlmaSocket {
    private ws: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelay = RECONNECT_BASE_MS;
    private stopped = false;
    private readonly turns = new Map<string, TurnState>();

    constructor(
        private readonly url: () => string,
        private readonly logger: SocketLogger,
        private readonly cb: SocketCallbacks,
    ) {}

    isOpen(): boolean {
        return this.ws?.readyState === 1 /* OPEN */;
    }

    connect(): void {
        if (this.stopped || this.ws) return;

        let socket: WebSocket;
        try {
            socket = new WebSocket(this.url());
        } catch (e) {
            this.logger.error('WebSocket 创建失败', e);
            this.scheduleReconnect();
            return;
        }
        this.ws = socket;

        socket.onopen = () => {
            this.reconnectDelay = RECONNECT_BASE_MS;
            this.logger.info('已连接 Alma WebSocket:', this.url());
            this.cb.onStateChange?.(true);
        };

        socket.onmessage = (ev: MessageEvent) => {
            let msg: any;
            try {
                const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
                msg = JSON.parse(raw);
            } catch {
                return;
            }
            this.dispatch(msg);
        };

        socket.onclose = () => {
            if (this.ws === socket) {
                this.ws = null;
                this.cb.onStateChange?.(false);
            }
            if (!this.stopped) {
                this.logger.warn('Alma WebSocket 断开，准备重连');
            }
            this.scheduleReconnect();
        };

        socket.onerror = () => {
            /* onclose 会跟着触发，不重复处理 */
        };
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.reconnectTimer) return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    private dispatch(msg: any): void {
        const data = msg?.data;
        const threadId: string | undefined = data?.threadId;
        if (!threadId) return;

        const turn = this.turns.get(threadId);
        /* 只处理自己发起的回合，避免串到别的渠道 */
        if (!turn || turn.finished) return;

        switch (msg.type) {
            case 'message_delta': {
                for (const delta of data.deltas ?? []) this.handleDelta(turn, delta);
                break;
            }
            case 'message_added': {
                this.handleAdded(turn, data);
                break;
            }
            case 'generation_completed': {
                this.cb.onComplete(turn, data);
                break;
            }
            case 'generation_error': {
                this.cb.onError(turn, String(data?.error ?? data?.message ?? '未知错误'));
                break;
            }
            default:
                break;
        }
    }

    private handleDelta(turn: TurnState, delta: any): void {
        switch (delta?.type) {
            case 'text_append': {
                if (typeof delta.text === 'string' && delta.text) {
                    turn.text += delta.text;
                    turn.lastActivity = Date.now();
                    this.cb.onTextDelta(turn, delta.text);
                }
                break;
            }
            case 'tool_output_streaming': {
                const out = delta?.stream?.stdout;
                if (typeof out === 'string' && out) {
                    turn.lastToolOutput = out.slice(-2000);
                    turn.lastActivity = Date.now();
                    this.cb.onToolOutput(turn, out);
                }
                break;
            }
            case 'part_update': {
                /* 工具参数就绪，部分版本会带 toolName */
                const name = delta?.updates?.toolName ?? delta?.updates?.name;
                if (typeof name === 'string' && name) this.announceTool(turn, name);
                break;
            }
            default:
                break;
        }
    }

    private handleAdded(turn: TurnState, data: any): void {
        const parts = data?.message?.parts;
        if (!Array.isArray(parts)) return;
        for (const p of parts) {
            const type = typeof p?.type === 'string' ? p.type : '';
            if (!type.startsWith('tool-')) continue;
            this.announceTool(turn, type.slice(5) || 'tool');
        }
    }

    private announceTool(turn: TurnState, name: string): void {
        if (!turn.tools.includes(name)) turn.tools.push(name);
        turn.lastActivity = Date.now();
        if (!turn.announcedTools.includes(name)) {
            turn.announcedTools.push(name);
            this.cb.onToolAnnounce(turn, name);
        }
    }

    /** 提交一轮生成 */
    async submit(turn: TurnState, model: string, text: string): Promise<void> {
        if (!this.isOpen()) {
            this.connect();
            const deadline = Date.now() + CONNECT_WAIT_MS;
            while (!this.isOpen() && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 150));
            }
        }
        if (!this.isOpen() || !this.ws) {
            throw new Error('Alma WebSocket 未连接，请检查 Alma 是否在运行');
        }

        this.turns.set(turn.threadId, turn);
        this.ws.send(
            JSON.stringify({
                type: 'generate_response',
                data: {
                    threadId: turn.threadId,
                    model,
                    userMessage: { role: 'user', parts: [{ type: 'text', text }] },
                    ephemeralContext: EPHEMERAL_CONTEXT,
                    source: 'dingtalk',
                },
            }),
        );
    }

    stop(threadId: string): boolean {
        if (!this.isOpen() || !this.ws) return false;
        if (!this.turns.has(threadId)) return false;
        this.ws.send(JSON.stringify({ type: 'stop_generation', data: { threadId } }));
        return true;
    }

    /** 该线程当前是否在生成 */
    isRunning(threadId: string): boolean {
        const turn = this.turns.get(threadId);
        return Boolean(turn && !turn.finished);
    }

    release(threadId: string): void {
        this.turns.delete(threadId);
    }

    close(): void {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const socket = this.ws;
        this.ws = null;
        try {
            socket?.close();
        } catch {
            /* noop */
        }
        this.cb.onStateChange?.(false);
    }
}
