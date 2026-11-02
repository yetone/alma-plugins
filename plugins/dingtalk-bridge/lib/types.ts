/**
 * 共享类型定义
 */

export interface BridgeConfig {
    almaApiPort: number;
    clientId: string;
    clientSecret: string;
    robotCode: string;
    defaultModel: string;
    workspaceId: string;
    mode: SessionMode;
    allowedStaffIds: string[];
    streamingReply: boolean;
    replyOnToolUse: boolean;
}

export type SessionMode = 'per-chat' | 'per-sender' | 'single';

export interface SessionRecord {
    threadId: string;
    createdAt: number;
    title?: string;
}

export interface TurnState {
    threadId: string;
    chatId: string;
    webhook: string;
    senderId: string;
    /** 累积的文本 */
    text: string;
    /** 本回合调用过的工具名 */
    tools: string[];
    /** 已推送过提示的工具名，避免重复提示 */
    announcedTools: string[];
    startedAt: number;
    lastActivity: number;
    finished: boolean;
    assistantMessageId?: string;
    lastToolOutput?: string;
    flushTimer?: ReturnType<typeof setTimeout>;
    flushStartedAt?: number;
    flushedChars?: number;
    streamed?: boolean;
    stopRequested?: boolean;
}

export interface AlmaThread {
    id: string;
    title: string;
    model: string | null;
    workspaceId: string | null;
}

export interface AlmaWorkspace {
    id: string;
    name: string;
    path?: string;
}

/** 推送目标（sessionWebhook 或主动发送） */
export interface DingTalkTarget {
    webhook?: string;
    conversationId?: string;
    senderStaffId?: string;
}

export interface SendResult {
    ok: boolean;
    error?: string;
}

/** 钉钉下游事件里的机器消息体 */
export interface DingTalkRobotMessage {
    conversationId: string;
    conversationType: string;
    conversationTitle?: string;
    senderStaffId: string;
    senderNick?: string;
    msgId: string;
    msgtype: string;
    text?: { content: string };
    content?: { richText?: string; downloadCode?: string };
    sessionWebhook: string;
    sessionWebhookExpiredTime: number;
    robotCode: string;
    createAt?: number;
}
