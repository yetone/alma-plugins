/**
 * DingTalk Bridge — Alma 插件
 *
 * 把钉钉机器人接成 Alma 的聊天渠道。Alma 的渠道是硬编码的
 * （telegram / discord / feishu / lark / weixin），插件没有 channels.register()，
 * 因此这里走替代路径：钉钉 Stream 模式收消息 + Alma 内部 WebSocket 协议驱动
 * 完整 agent（工具 / 技能 / 项目工作区）。
 *
 * 结构参考官方 alma-plugins 仓库：
 * - manifest.json 声明 main.js（预打包，自包含依赖，无需 npm install）
 * - main.ts 只做装配，逻辑放在 lib/
 * - 命令用 commands.register(id, handler)
 * - 状态用 ui.createStatusBarItem
 */

import type { PluginContext, PluginActivation } from 'alma-plugin-api';

import { DingTalkBridge } from './lib/bridge';
import type { BridgeConfig, SessionMode } from './lib/types';

const STATUS_BAR_ID = 'dingtalk-bridge.status';

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, settings, ui, commands } = context;

    logger.info('DingTalk Bridge 正在激活…');

    /* ---------------- 配置读取 ---------------- */

    const readConfig = (): BridgeConfig => {
        const get = <T>(key: string, fallback: T): T => {
            try {
                const value = settings.get<T>(`dingtalkBridge.${key}` as any, fallback);
                return value === undefined || value === null ? fallback : value;
            } catch {
                return fallback;
            }
        };

        const rawStaff = String(get<string>('allowedStaffIds', '') ?? '');
        const mode = String(get<string>('mode', 'per-chat')) as SessionMode;

        return {
            almaApiPort: Number(get<number>('almaApiPort', 23001)) || 23001,
            clientId: String(get<string>('clientId', '') ?? '').trim(),
            clientSecret: String(get<string>('clientSecret', '') ?? '').trim(),
            robotCode: String(get<string>('robotCode', '') ?? '').trim(),
            defaultModel: String(get<string>('defaultModel', '') ?? '').trim(),
            workspaceId: String(get<string>('workspaceId', '') ?? '').trim(),
            mode: mode === 'per-sender' || mode === 'single' ? mode : 'per-chat',
            allowedStaffIds: rawStaff
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            streamingReply: Boolean(get<boolean>('streamingReply', true)),
            replyOnToolUse: Boolean(get<boolean>('replyOnToolUse', true)),
        };
    };

    /* ---------------- 桥接实例 ---------------- */

    const bridge = new DingTalkBridge({ context, config: readConfig });

    /* ---------------- 状态栏 ---------------- */

    const statusBar = ui.createStatusBarItem({
        id: STATUS_BAR_ID,
        alignment: 'right',
        priority: 90,
    });

    const formatTime = (ts: number | null): string =>
        ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—';

    const refreshStatusBar = (): void => {
        const status = bridge.getStatus();

        if (!status.running) {
            statusBar.text = '$(plug) 钉钉 未连接';
            statusBar.tooltip = status.lastError
                ? `DingTalk Bridge\n${status.lastError}`
                : 'DingTalk Bridge 未启动，请检查 AppKey / AppSecret';
            return;
        }

        const ws = status.socketConnected ? '●' : '○';
        statusBar.text = `${ws} 钉钉 ${status.sessionCount}`;
        statusBar.tooltip = [
            'DingTalk Bridge',
            `运行中：${status.running ? '是' : '否'}`,
            `WebSocket：${status.socketConnected ? '已连接' : '未连接'}`,
            `启动于：${formatTime(status.startedAt)}`,
            `最近消息：${formatTime(status.lastMessageAt)}`,
            `会话数：${status.sessionCount}`,
            ...(status.lastError ? [`最近错误：${status.lastError}`] : []),
        ].join('\n');
    };

    statusBar.show();
    statusBar.command = 'dingtalkBridge.status';
    refreshStatusBar();

    /* 状态栏定时刷新（会话数/连接态会变） */
    const statusTimer = setInterval(refreshStatusBar, 5000);

    /* ---------------- 命令 ---------------- */

    const disposables = [
        commands.register('dingtalkBridge.status', async () => {
            refreshStatusBar();
            const status = bridge.getStatus();
            const lines = [
                '📊 DingTalk Bridge',
                `运行中：${status.running ? '是' : '否'}`,
                `WebSocket：${status.socketConnected ? '已连接' : '未连接'}`,
                `启动时间：${status.startedAt ? new Date(status.startedAt).toLocaleString('zh-CN') : '—'}`,
                `最近消息：${status.lastMessageAt ? new Date(status.lastMessageAt).toLocaleString('zh-CN') : '—'}`,
                `会话数：${status.sessionCount}`,
                ...(status.lastError ? [`最近错误：${status.lastError}`] : []),
            ];
            ui.showNotification(lines.join('\n'), { type: 'info', duration: 8000 });
            logger.info(lines.join(' | '));
        }),

        commands.register('dingtalkBridge.restart', async () => {
            logger.info('正在重连钉钉桥接…');
            await bridge.restart();
            refreshStatusBar();
            const status = bridge.getStatus();
            ui.showNotification(
                status.running ? '✅ 钉钉桥接已重连' : `⚠️ 重连失败：${status.lastError ?? '未知原因'}`,
                { type: status.running ? 'info' : 'warning' },
            );
        }),

        commands.register('dingtalkBridge.clearSessions', async () => {
            bridge.clearSessions();
            refreshStatusBar();
            ui.showNotification('已清空会话映射，下次消息会新建会话', { type: 'info' });
        }),

        commands.register('dingtalkBridge.testAlma', async () => {
            /* 探测 Alma 本地 API 与 WebSocket 是否可达，便于排查 */
            const config = readConfig();
            const status = bridge.getStatus();
            const lines = [
                '🔍 连通性自检',
                `Alma API：127.0.0.1:${config.almaApiPort}`,
                `WebSocket：${status.socketConnected ? '✅ 已连接' : '❌ 未连接'}`,
                status.lastError ? `最近错误：${status.lastError}` : '',
            ].filter(Boolean);
            ui.showNotification(lines.join('\n'), { type: 'info', duration: 8000 });
        }),
    ];

    /* ---------------- 工具（供 AI 主动发钉钉消息） ---------------- */

    const toolDisposable = context.tools.register('dingtalk_notify', {
        description:
            '通过钉钉给指定用户发送一条消息。需要插件已配置 AppKey/AppSecret，且你知道对方的 senderStaffId。',
        parameters: {
            type: 'object',
            properties: {
                staffId: { type: 'string', description: '钉钉用户的 senderStaffId' },
                message: { type: 'string', description: '要发送的文本内容' },
            },
            required: ['staffId', 'message'],
        } as const,
        execute: async (params: any) => {
            const { staffId, message } = params as { staffId: string; message: string };
            const ok = await bridge.notify(staffId, message);
            return ok
                ? { success: true, message: `已发送给 ${staffId}` }
                : { success: false, error: '发送失败，请检查凭据与 staffId' };
        },
    });

    /* ---------------- 事件 ---------------- */

    let started = false;
    const tryStart = async (reason: string): Promise<void> => {
        if (started) return;
        started = true;
        try {
            await bridge.start();
        } catch (e) {
            logger.error(`启动失败（${reason}）`, e);
        }
        refreshStatusBar();
    };

    const readyDisposable = context.events.on('app.ready', () => {
        void tryStart('app.ready');
    });

    /* app.ready 可能已经错过，直接尝试一次 */
    void tryStart('activate');

    const settingsDisposable = settings.onDidChange((e: any) => {
        /* 换线程相关配置后重建映射 */
        if (typeof e?.key === 'string' && e.key.startsWith('dingtalkBridge.')) {
            logger.info('配置变更，刷新状态栏', e.key);
            refreshStatusBar();
        }
    });

    /* 离线测试探针：仅测试宿主会设置该环境变量 */
    if (process.env.ALMA_DT_SELFTEST === '1') {
        (globalThis as any).__dingtalkBridgeProbe = { bridge, readConfig, context };
        logger.info('测试探针已挂载');
    }

    logger.info('DingTalk Bridge 已激活');

    return {
        dispose: async () => {
            logger.info('DingTalk Bridge 正在卸载…');
            clearInterval(statusTimer);
            for (const d of disposables) {
                try {
                    d.dispose();
                } catch {
                    /* noop */
                }
            }
            toolDisposable.dispose();
            readyDisposable.dispose();
            settingsDisposable.dispose();
            statusBar.dispose();
            await bridge.stop();
            logger.info('DingTalk Bridge 已卸载');
        },
    };
}
