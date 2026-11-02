/**
 * 桥接核心：钉钉消息 → Alma agent → 钉钉回复
 */
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import type { PluginContext } from 'alma-plugin-api';

import { AlmaApi } from './alma-api';
import { AlmaSocket } from './alma-socket';
import { DingTalkClient } from './dingtalk-client';
import type {
    BridgeConfig,
    DingTalkRobotMessage,
    SessionMode,
    SessionRecord,
    TurnState,
} from './types';

export interface BridgeDeps {
    context: PluginContext;
    config: () => BridgeConfig;
    getBuiltinThreadId?: () => string | undefined;
}

/** 回合结束后推送的最终文本等 */
const STORAGE_KEY = 'dingtalkSessions';
const STORAGE_VER = 2;
const FLUSH_INTERVAL_MS = 1200;
const COMMAND_PREFIX = '/';

export interface BridgeStatus {
    running: boolean;
    socketConnected: boolean;
    startedAt: number | null;
    lastMessageAt: number | null;
    sessionCount: number;
    lastError: string | null;
}

export class DingTalkBridge {
    private readonly ctx: PluginContext;
    private readonly cfg: () => BridgeConfig;

    private sessions: Record<string, SessionRecord> = {};
    private queue: Promise<void> = Promise.resolve();
    private completedTurns = 0;

    private dwClient: DWClient | null = null;
    private running = false;
    private startedAt: number | null = null;
    private lastMessageAt: number | null = null;
    private lastError: string | null = null;

    private readonly api: AlmaApi;
    private readonly dingtalk: DingTalkClient;
    private readonly socket: AlmaSocket;

    /* 去重缓冲：钉钉会在 60s 内重推未 ACK 的消息 */
    private readonly seenMsgIds = new Map<string, number>();

    constructor(private readonly deps: BridgeDeps) {
        this.ctx = deps.context;
        this.cfg = deps.config;

        this.api = new AlmaApi(
            () => `http://127.0.0.1:${this.cfg().almaApiPort}`,
            this.ctx.logger,
        );

        this.dingtalk = new DingTalkClient(
            () => {
                const c = this.cfg();
                return { clientId: c.clientId, clientSecret: c.clientSecret, robotCode: c.robotCode || c.clientId };
            },
            this.ctx.logger,
        );

        this.socket = new AlmaSocket(
            () => `ws://127.0.0.1:${this.cfg().almaApiPort}/ws/threads`,
            this.ctx.logger,
            {
                onTextDelta: (turn, _text) => {
                    if (this.cfg().streamingReply) this.scheduleFlush(turn);
                },
                onToolAnnounce: (turn, toolName) => {
                    turn.lastActivity = Date.now();
                    if (this.cfg().replyOnToolUse) {
                        void this.dingtalk.replyWebhook(turn.webhook, `🔧 正在使用 ${toolName}…`);
                    }
                },
                onToolOutput: (turn, stdout) => {
                    turn.lastActivity = Date.now();
                    turn.lastToolOutput = stdout.slice(-2000);
                },
                onComplete: (turn, data) => {
                    turn.finished = true;
                    turn.assistantMessageId = data?.assistantMessageId;
                    void this.finalizeTurn(turn);
                },
                onError: (turn, message) => {
                    turn.finished = true;
                    this.cancelFlush(turn);
                    this.socket.release(turn.threadId);
                    void this.reply(turn, `❌ 生成失败：${message}`);
                },
            },
        );
    }

    /* ============================================================ */
    /* 生命周期                                                      */
    /* ============================================================ */

    getStatus(): BridgeStatus {
        return {
            running: this.running,
            socketConnected: this.socket.isOpen(),
            startedAt: this.startedAt,
            lastMessageAt: this.lastMessageAt,
            sessionCount: Object.keys(this.sessions).length,
            lastError: this.lastError,
        };
    }

    async start(): Promise<void> {
        const config = this.cfg();

        if (!config.clientId || !config.clientSecret) {
            this.lastError = '未配置 clientId / clientSecret';
            this.ctx.logger.warn('钉钉凭据未配置，桥接不会启动。请在插件设置里填写 AppKey / AppSecret。');
            return;
        }

        await this.loadSessions();
        this.socket.connect();

        this.dwClient = new DWClient({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            debug: false,
            keepAlive: true,
        });

        this.dwClient.registerAllEventListener((msg: any) => {
            /* 立刻 ACK，避免钉钉 60 秒重推 */
            if (msg?.headers?.topic === TOPIC_ROBOT) {
                this.dispatchDownstream(msg).catch((e) => this.ctx.logger.error('入站处理异常', e));
            }
            return { status: 'SUCCESS' as any, message: 'ack' };
        });

        try {
            await this.dwClient.connect();
            this.running = true;
            this.startedAt = Date.now();
            this.lastError = null;
            this.ctx.logger.info('钉钉 Stream 已连接');
        } catch (e) {
            this.running = false;
            this.lastError = e instanceof Error ? e.message : String(e);
            this.ctx.logger.error('钉钉 Stream 连接失败', e);
            throw e;
        }
    }

    async stop(): Promise<void> {
        this.running = false;
        try {
            this.dwClient?.disconnect();
        } catch (e) {
            this.ctx.logger.warn('断开钉钉连接异常', e);
        }
        this.dwClient = null;
        this.socket.close();
    }

    async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    /* ============================================================ */
    /* 配置与持久化                                                  */
    /* ============================================================ */

    private async loadSessions(): Promise<void> {
        try {
            const data = await this.ctx.storage.local.get<any>(STORAGE_KEY, null);
            if (data && data.version === STORAGE_VER && data.sessions) {
                this.sessions = data.sessions;
                this.ctx.logger.info(`已载入 ${Object.keys(this.sessions).length} 条会话映射`);
            } else if (data?.sessions) {
                /* 旧版本迁移：字段兼容就直接用 */
                this.sessions = data.sessions;
                await this.saveSessions();
            }
        } catch (e) {
            this.ctx.logger.warn('读取会话映射失败', e);
        }
    }

    private async saveSessions(): Promise<void> {
        try {
            await this.ctx.storage.local.set(STORAGE_KEY, { version: STORAGE_VER, sessions: this.sessions });
        } catch (e) {
            this.ctx.logger.warn('保存会话映射失败', e);
        }
    }

    clearSessions(): void {
        this.sessions = {};
        void this.saveSessions();
    }

    getSessions(): Readonly<Record<string, SessionRecord>> {
        return this.sessions;
    }

    /* ============================================================ */
    /* 会话 → 线程                                                   */
    /* ============================================================ */

    private sessionKey(chatId: string, senderId: string, mode: SessionMode): string {
        if (mode === 'single') return 'global';
        if (mode === 'per-sender') return `${chatId}::${senderId}`;
        return chatId;
    }

    private async resolveThread(chatId: string, senderId: string, title: string): Promise<string> {
        const config = this.cfg();
        const key = this.sessionKey(chatId, senderId, config.mode);

        const existing = this.sessions[key];
        if (existing?.threadId) {
            /* 校验线程是否还在（用户可能手动删了） */
            try {
                const threads = await this.api.getThreads();
                if (threads.some((t) => t.id === existing.threadId)) return existing.threadId;
                this.ctx.logger.warn('映射的线程已不存在，重新创建', existing.threadId);
            } catch (e) {
                /* 查询失败先信任缓存，避免网络抖动导致上下文丢失 */
                this.ctx.logger.warn('校验线程失败，沿用缓存', e);
                return existing.threadId;
            }
            delete this.sessions[key];
        }

        return this.createThreadFor(key, title);
    }

    private async createThreadFor(key: string, title: string): Promise<string> {
        const config = this.cfg();
        const model = await this.api.resolveModel(config.defaultModel);
        const workspaceId = await this.api.resolveWorkspaceId(config.workspaceId);

        let thread;
        try {
            thread = await this.api.createThread({
                title: (title || '钉钉会话').slice(0, 80),
                ...(workspaceId ? { workspaceId } : {}),
                model,
            });
        } catch (e) {
            /* 回退：用插件上下文的 chat.createThread（若宿主接线了就能用） */
            this.ctx.logger.warn('HTTP 建线程失败，尝试插件 API 回退', e);
            const fallback = await this.ctx.chat.createThread({ title: (title || '钉钉会话').slice(0, 80), model });
            this.sessions[key] = { threadId: fallback.id, createdAt: Date.now(), title };
            await this.saveSessions();
            return fallback.id;
        }

        this.sessions[key] = { threadId: thread.id, createdAt: Date.now(), title };
        await this.saveSessions();
        this.ctx.logger.info(`为 ${key} 创建线程 ${thread.id}（工作区 ${workspaceId ?? '默认'}）`);
        return thread.id;
    }

    /** 强制为某会话换新线程 */
    async resetThread(chatId: string, senderId: string, title: string): Promise<string> {
        const key = this.sessionKey(chatId, senderId, this.cfg().mode);
        delete this.sessions[key];
        return this.createThreadFor(key, title);
    }

    /* ============================================================ */
    /* 回复                                                          */
    /* ============================================================ */

    private async reply(turn: TurnState, text: string, title?: string): Promise<void> {
        const chunks = DingTalkClient.chunk(text || '（无内容）');
        for (const chunk of chunks) {
            const result = await this.dingtalk.replyWebhook(turn.webhook, chunk, title);
            if (!result.ok) {
                this.ctx.logger.error('钉钉消息发送失败', result.error);
                return;
            }
        }
    }

    /* ============================================================ */
    /* 流式回复                                                      */
    /* ============================================================ */

    /**
     * 取可发送的一段。
     *
     * 规则：
     * - 找到最后一个句末标点/换行，切到那里（避免把半句话发出去）
     * - 没有边界时，只有攒够 200 字符才强制切
     * - 即使不足 MIN_FLUSH，只要有完整边界也允许发（短回复也要能流式出去）
     */
    static takeFlushable(text: string, alreadySent: number): string {
        const pending = text.slice(alreadySent);
        if (!pending) return '';

        const isBoundary = (ch: string): boolean =>
            ch === '\n' || ch === '。' || ch === '！' || ch === '？' ||
            ch === '.' || ch === '!' || ch === '?' || ch === '；' || ch === ';';

        let cut = -1;
        const floor = Math.max(0, pending.length - 400);
        for (let i = pending.length - 1; i >= floor; i--) {
            if (isBoundary(pending[i])) {
                cut = i + 1;
                break;
            }
        }

        if (cut > 0) return pending.slice(0, cut);
        return pending.length >= 200 ? pending : '';
    }

    private scheduleFlush(turn: TurnState): void {
        if (turn.flushTimer || turn.finished) return;
        const elapsed = Date.now() - (turn.flushStartedAt ?? turn.startedAt);
        if (elapsed < FLUSH_INTERVAL_MS) return;

        turn.flushTimer = setTimeout(() => {
            turn.flushTimer = undefined;
            void this.doFlush(turn);
        }, FLUSH_INTERVAL_MS);
    }

    private async doFlush(turn: TurnState): Promise<void> {
        if (turn.finished) return;
        const piece = DingTalkBridge.takeFlushable(turn.text, turn.flushedChars ?? 0);
        if (!piece) return;

        turn.flushedChars = (turn.flushedChars ?? 0) + piece.length;
        turn.flushStartedAt = Date.now();

        const result = await this.dingtalk.replyWebhook(turn.webhook, piece);
        if (result.ok) {
            turn.streamed = true;
        } else {
            /* 推送失败就回退，保证最终一次性发全文 */
            turn.flushedChars = 0;
            turn.streamed = false;
        }
    }

    private cancelFlush(turn: TurnState): void {
        if (turn.flushTimer) {
            clearTimeout(turn.flushTimer);
            turn.flushTimer = undefined;
        }
    }

    /* ============================================================ */
    /* 回合收尾                                                      */
    /* ============================================================ */

    private async finalizeTurn(turn: TurnState): Promise<void> {
        try {
            this.cancelFlush(turn);

            const full = await this.readFinalText(turn);
            const alreadySent = turn.streamed ? (turn.flushedChars ?? 0) : 0;
            const remainder = full.slice(alreadySent).trim();

            if (remainder) {
                await this.reply(turn, remainder);
            } else if (!turn.streamed) {
                await this.reply(turn, '（本轮没有产生文本回复）');
            }
        } catch (e) {
            this.ctx.logger.error('回合收尾失败', e);
            await this.reply(turn, `❌ 收尾异常：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.socket.release(turn.threadId);
            this.completedTurns += 1;
        }
    }

    /** 回读数据库里的最终消息，兜住增量丢字 */
    private async readFinalText(turn: TurnState): Promise<string> {
        if (!turn.assistantMessageId) return turn.text.trim();
        try {
            const messages = await this.api.getMessages(turn.threadId);
            const target = messages.find((m: any) => {
                const id = m?.id ?? m?.message?.id;
                return id && String(id).includes(String(turn.assistantMessageId));
            });
            if (!target) return turn.text.trim();

            const parts = target?.message?.parts ?? target?.parts ?? [];
            const text = parts
                .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
                .map((p: any) => p.text)
                .join('')
                .trim();
            return text || turn.text.trim();
        } catch (e) {
            this.ctx.logger.warn('回读最终消息失败，使用累计文本', e);
            return turn.text.trim();
        }
    }

    /* ============================================================ */
    /* 入站                                                          */
    /* ============================================================ */

    private async dispatchDownstream(downstream: any): Promise<void> {
        const ac = new AbortController();
        try {
            await this.handleIncoming(downstream);
        } finally {
            ac.abort();
        }
    }

    async handleIncoming(downstream: any): Promise<void> {
        let payload: DingTalkRobotMessage;
        try {
            payload = typeof downstream.data === 'string' ? JSON.parse(downstream.data) : downstream.data;
        } catch (e) {
            this.ctx.logger.warn('消息载荷解析失败', e);
            return;
        }

        const chatId = payload?.conversationId;
        const senderId = payload?.senderStaffId;
        const webhook = payload?.sessionWebhook;
        const msgId = payload?.msgId;

        if (!chatId || !senderId || !webhook) {
            this.ctx.logger.warn('消息缺少 conversationId / senderStaffId / sessionWebhook，忽略');
            return;
        }

        /* 去重：钉钉重推同一个 msgId */
        if (msgId) {
            const now = Date.now();
            for (const [id, ts] of this.seenMsgIds) {
                if (now - ts > 5 * 60_000) this.seenMsgIds.delete(id);
            }
            if (this.seenMsgIds.has(msgId)) {
                this.ctx.logger.info('重复消息，跳过', msgId);
                return;
            }
            this.seenMsgIds.set(msgId, now);
        }

        const config = this.cfg();
        if (config.allowedStaffIds.length > 0 && !config.allowedStaffIds.includes(senderId)) {
            this.ctx.logger.info(`拒绝未授权用户 ${senderId}`);
            await this.dingtalk.replyWebhook(webhook, '⛔ 你没有使用这个机器人的权限。');
            return;
        }

        const text = this.extractText(payload);
        if (!text) return;

        this.lastMessageAt = Date.now();

        if (text.startsWith(COMMAND_PREFIX)) {
            const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
            if (m) {
                await this.runCommand(m[1].toLowerCase(), m[2] ?? '', chatId, senderId, webhook);
                return;
            }
        }

        /* 串行化：同一时刻只处理一条，避免并发写同一线程 */
        const previous = this.queue;
        let release!: () => void;
        this.queue = new Promise<void>((r) => (release = r));
        await previous.catch(() => undefined);

        try {
            const title =
                payload.conversationTitle ??
                (payload.conversationType === '1' ? '钉钉单聊' : `钉钉群 ${chatId.slice(0, 8)}`);

            const threadId = await this.resolveThread(chatId, senderId, title);

            if (this.socket.isRunning(threadId)) {
                await this.dingtalk.replyWebhook(webhook, '⏳ 上一轮还在执行，请稍候或发送 /stop 中断。');
                return;
            }

            const model = await this.api.resolveModel(config.defaultModel);
            const turn: TurnState = {
                threadId,
                chatId,
                webhook,
                senderId,
                text: '',
                tools: [],
                announcedTools: [],
                startedAt: Date.now(),
                lastActivity: Date.now(),
                finished: false,
            };
            await this.socket.submit(turn, model, text);
        } catch (e) {
            this.ctx.logger.error('处理消息失败', e);
            this.lastError = e instanceof Error ? e.message : String(e);
            await this.dingtalk.replyWebhook(webhook, `❌ 处理失败：${this.lastError}`);
        } finally {
            release();
        }
    }

    private extractText(payload: DingTalkRobotMessage): string {
        const type = payload.msgtype;
        let text = '';

        if (type === 'text') {
            text = String(payload.text?.content ?? '');
        } else if (type === 'richText') {
            text = String(payload.content?.richText ?? '').replace(/@\S+/g, ' ').trim();
        } else if (type === 'picture' || type === 'image') {
            text = '[用户发来一张图片，当前版本暂不支持图片识别]';
        } else if (type === 'audio' || type === 'voice') {
            text = '[用户发来语音，当前版本暂不支持语音识别]';
        } else if (type === 'file') {
            text = '[用户发来文件，当前版本暂不支持附件读取]';
        } else {
            text = `[收到暂不支持的钉钉消息类型：${type}]`;
        }

        return text.replace(/\s+/g, ' ').trim();
    }

    /* ============================================================ */
    /* 命令                                                          */
    /* ============================================================ */

    private async runCommand(
        cmd: string,
        args: string,
        chatId: string,
        senderId: string,
        webhook: string,
    ): Promise<void> {
        const config = this.cfg();
        const reply = (t: string, title?: string) => this.dingtalk.replyWebhook(webhook, t, title);

        try {
            switch (cmd) {
                case 'help':
                case 'start':
                    await reply(
                        [
                            '👋 Alma 钉钉桥接已就绪',
                            '',
                            '直接发消息即可，我会用绑定的本地项目上下文回复。',
                            '',
                            '命令：',
                            '/new [标题]  开一个新会话',
                            '/stop        停止当前生成',
                            '/status      查看桥接状态',
                            '/ws          列出可绑定的项目工作区',
                            '/use <id>    切换当前会话绑定的工作区',
                            '/help        显示本帮助',
                        ].join('\n'),
                    );
                    break;

                case 'new': {
                    const title = args.trim() || `钉钉会话 ${new Date().toLocaleString('zh-CN')}`;
                    const threadId = await this.resetThread(chatId, senderId, title);
                    await reply(`✅ 已新建会话：${title}\n线程：${threadId}`);
                    break;
                }

                case 'stop': {
                    const key = this.sessionKey(chatId, senderId, config.mode);
                    const threadId = this.sessions[key]?.threadId;
                    if (!threadId) {
                        await reply('当前没有活跃会话。');
                        break;
                    }
                    if (!this.socket.stop(threadId)) {
                        await reply('当前线程没有正在执行的生成。');
                        break;
                    }
                    await reply('🛑 已发送停止指令');
                    break;
                }

                case 'status': {
                    const s = this.getStatus();
                    await reply(
                        [
                            '📊 DingTalk Bridge 状态',
                            `运行中：${s.running ? '是' : '否'}`,
                            `WebSocket：${s.socketConnected ? '已连接' : '未连接'}`,
                            `Alma API：127.0.0.1:${config.almaApiPort}`,
                            `模型：${config.defaultModel || '(跟随 Alma 默认)'}`,
                            `工作区：${config.workspaceId || '(跟随 Alma 默认)'}`,
                            `会话模式：${config.mode}`,
                            `会话数：${s.sessionCount}`,
                            ...(s.lastError ? [`最近错误：${s.lastError}`] : []),
                        ].join('\n'),
                    );
                    break;
                }

                case 'ws': {
                    const list = await this.api.getWorkspaces();
                    if (!list.length) {
                        await reply('没有找到任何工作区。');
                        break;
                    }
                    const lines = list.slice(0, 15).map((w) => `• ${w.name}  ${w.id}`);
                    await reply(['📁 可用工作区（用 /use <id> 绑定）', '', ...lines].join('\n'), '工作区列表');
                    break;
                }

                case 'use': {
                    const wsId = args.trim();
                    if (!wsId) {
                        await reply('用法：/use <workspaceId>，先用 /ws 查看列表');
                        break;
                    }
                    const list = await this.api.getWorkspaces();
                    const exists = list.some((w) => w.id === wsId);
                    if (!exists) {
                        await reply(`未找到工作区：${wsId}\n发送 /ws 查看可用列表。`);
                        break;
                    }
                    /* 临时覆盖：写入会话记录并存一个 override 配置键 */
                    await this.ctx.settings.update('dingtalkBridge.workspaceId' as any, wsId);
                    const threadId = await this.resetThread(chatId, senderId, `钉钉会话 @${wsId}`);
                    await reply(`✅ 已切换到工作区 ${wsId}\n线程：${threadId}`);
                    break;
                }

                default:
                    await reply(`未知命令：/${cmd}，发送 /help 查看可用命令`);
                    break;
            }
        } catch (e) {
            this.ctx.logger.error('命令执行失败', e);
            await reply(`❌ 命令执行失败：${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /* ============================================================ */
    /* 主动推送                                                      */
    /* ============================================================ */

    /** 向某个钉钉用户主动发消息（需要能换 token） */
    async notify(staffId: string, text: string): Promise<boolean> {
        const result = await this.dingtalk.sendToUser(staffId, text);
        if (!result.ok) this.ctx.logger.warn('主动推送失败', result.error);
        return result.ok;
    }

    /** 获取所有已知的钉钉用户（用于广播） */
    knownSenders(): string[] {
        return Array.from(new Set(Object.keys(this.sessions).map((k) => k.split('::')[1] ?? k)));
    }

    getCompletedTurns(): number {
        return this.completedTurns;
    }
}
