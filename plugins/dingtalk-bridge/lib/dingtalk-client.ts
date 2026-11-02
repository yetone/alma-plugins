/**
 * 钉钉发送侧
 *
 * 回复用下游事件里的 sessionWebhook（两小时有效、单条限制 5000 字符）。
 * 主动发消息（心跳/通知）需要 appKey/appSecret 换 access_token，
 * 这里实现了 token 缓存与主动发送。
 */
import type { SendResult } from './types';

export interface DingTalkLogger {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
}

/** 单条消息上限，留出余量 */
const MAX_CHUNK = 4000;
const TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const SEND_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
const GROUP_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';

export class DingTalkClient {
    private token: string | null = null;
    private tokenExpiry = 0;

    constructor(
        private readonly credentials: () => { clientId: string; clientSecret: string; robotCode: string },
        private readonly logger: DingTalkLogger,
    ) {}

    /* ---------------- 分段 ---------------- */

    /** 按行边界切分，避免把句子切开 */
    static chunk(text: string, limit = MAX_CHUNK): string[] {
        if (!text) return [];
        if (text.length <= limit) return [text];

        const out: string[] = [];
        let rest = text;
        while (rest.length > limit) {
            let cut = rest.lastIndexOf('\n', limit);
            if (cut < limit * 0.5) cut = limit;
            out.push(rest.slice(0, cut));
            rest = rest.slice(cut).replace(/^\n+/, '');
        }
        if (rest) out.push(rest);
        return out;
    }

    /* ---------------- webhook 回复 ---------------- */

    /** 通过 sessionWebhook 回复（最常用，无需 token） */
    async replyWebhook(webhook: string, text: string, title?: string): Promise<SendResult> {
        if (!webhook) return { ok: false, error: '缺少 sessionWebhook' };

        const payload = title
            ? { msgtype: 'markdown', markdown: { title, text } }
            : { msgtype: 'text', text: { content: text } };

        try {
            const res = await fetch(webhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const body = await res.text().catch(() => '');

            /* 钉钉即使 HTTP 200 也可能返回 errcode */
            if (!res.ok) {
                this.logger.warn('webhook 回复 HTTP 失败', res.status, body.slice(0, 200));
                return { ok: false, error: `HTTP ${res.status}` };
            }
            const errcode = /"errcode"\s*:\s*(\d+)/.exec(body)?.[1];
            if (errcode && errcode !== '0') {
                this.logger.warn('webhook 回复 errcode', errcode, body.slice(0, 200));
                return { ok: false, error: `errcode ${errcode}` };
            }
            return { ok: true };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            this.logger.warn('webhook 回复异常', error);
            return { ok: false, error };
        }
    }

    /* ---------------- 主动发送 ---------------- */

    private async getAccessToken(): Promise<string | null> {
        const { clientId, clientSecret } = this.credentials();
        if (!clientId || !clientSecret) return null;

        const now = Date.now();
        if (this.token && now < this.tokenExpiry - 60_000) return this.token;

        try {
            const res = await fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
            });
            if (!res.ok) {
                this.logger.warn('获取 accessToken 失败', res.status);
                return null;
            }
            const data = (await res.json()) as { accessToken?: string; expireIn?: number };
            if (!data?.accessToken) return null;

            this.token = data.accessToken;
            this.tokenExpiry = now + (data.expireIn ?? 7200) * 1000;
            return this.token;
        } catch (e) {
            this.logger.warn('获取 accessToken 异常', e);
            return null;
        }
    }

    /** 主动发单聊消息（需要 clientId/clientSecret） */
    async sendToUser(staffId: string, text: string): Promise<SendResult> {
        const { robotCode } = this.credentials();
        const token = await this.getAccessToken();
        if (!token) return { ok: false, error: '未配置凭据或 token 获取失败' };

        try {
            const res = await fetch(SEND_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-acs-dingtalk-access-token': token,
                },
                body: JSON.stringify({
                    robotCode,
                    userIds: [staffId],
                    msgKey: 'sampleText',
                    msgParam: JSON.stringify({ content: text }),
                }),
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 160)}` };
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }

    /** 主动发群消息（需要 openConversationId） */
    async sendToGroup(conversationId: string, text: string): Promise<SendResult> {
        const { robotCode } = this.credentials();
        const token = await this.getAccessToken();
        if (!token) return { ok: false, error: '未配置凭据或 token 获取失败' };

        try {
            const res = await fetch(GROUP_SEND_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-acs-dingtalk-access-token': token,
                },
                body: JSON.stringify({
                    robotCode,
                    openConversationId: conversationId,
                    msgKey: 'sampleText',
                    msgParam: JSON.stringify({ content: text }),
                }),
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 160)}` };
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }
}
