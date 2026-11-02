/**
 * Alma 本地 REST API 客户端
 *
 * 只用于插件 API 覆盖不到的部分：
 * - 建线程（插件上下文的 chat.createThread 未接线）
 * - 读工作区列表（用于 /ws 命令）
 * - 回读最终消息（防止增量丢字）
 */
import type { AlmaThread, AlmaWorkspace } from './types';

export interface AlmaApiLogger {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
}

export class AlmaApi {
    constructor(
        private readonly baseUrl: () => string,
        private readonly logger: AlmaApiLogger,
    ) {}

    private async req<T>(path: string, init?: RequestInit): Promise<T> {
        const url = `${this.baseUrl()}${path}`;
        const res = await fetch(url, {
            ...init,
            headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Alma API ${init?.method ?? 'GET'} ${path} → ${res.status} ${body.slice(0, 200)}`);
        }
        if (res.status === 204) return undefined as T;

        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
    }

    getSettings(): Promise<Record<string, any>> {
        return this.req('/api/settings');
    }

    getThreads(): Promise<AlmaThread[]> {
        return this.req('/api/threads');
    }

    async getWorkspaces(): Promise<AlmaWorkspace[]> {
        const data = await this.req<AlmaWorkspace[] | { workspaces?: AlmaWorkspace[] }>('/api/workspaces');
        return Array.isArray(data) ? data : (data?.workspaces ?? []);
    }

    async getMessages(threadId: string): Promise<any[]> {
        const data = await this.req<any[] | { messages?: any[] }>(`/api/threads/${threadId}/messages`);
        return Array.isArray(data) ? data : (data?.messages ?? []);
    }

    createThread(body: { title: string; workspaceId?: string; model?: string }): Promise<AlmaThread> {
        return this.req('/api/threads', { method: 'POST', body: JSON.stringify(body) });
    }

    deleteThread(threadId: string): Promise<void> {
        return this.req(`/api/threads/${threadId}`, { method: 'DELETE' });
    }

    /** 解析要用的模型 ID（providerId:modelId） */
    async resolveModel(explicit: string): Promise<string> {
        if (explicit) {
            if (!explicit.includes(':')) {
                throw new Error(`模型格式应为 providerId:modelId，当前是 "${explicit}"`);
            }
            return explicit;
        }
        const settings = await this.getSettings();
        const fallback = settings?.chat?.defaultModel;
        if (!fallback) {
            throw new Error('Alma 未配置默认模型，请在插件设置里填写 defaultModel');
        }
        return fallback;
    }

    /** 解析要绑定的工作区 ID */
    async resolveWorkspaceId(explicit: string): Promise<string | undefined> {
        if (explicit) return explicit;
        try {
            const settings = await this.getSettings();
            if (settings?.general?.defaultWorkspaceId) {
                return settings.general.defaultWorkspaceId;
            }
        } catch (e) {
            this.logger.warn('读取默认工作区失败，回退到工作区列表', e);
        }
        try {
            const list = await this.getWorkspaces();
            return list[0]?.id;
        } catch {
            return undefined;
        }
    }

    /** 健康检查：确认 Alma API 真的在跑 */
    async ping(): Promise<boolean> {
        try {
            const r = await fetch(`${this.baseUrl()}/api/health`);
            return r.ok;
        } catch {
            return false;
        }
    }
}
