#!/usr/bin/env node
/**
 * 从命令行向钉钉发消息（复用插件已配置的凭据）
 *
 * 用法：
 *   node cmd/send.mjs <staffId> "消息内容"
 *
 * 凭据从 Alma 插件设置里读，不需要另外配。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const ALMA_API = `http://127.0.0.1:${process.env.ALMA_PORT || 23001}`;

async function getPluginSettings() {
    /* 插件设置存在 Alma 的插件状态里，走 API 拿最稳 */
    try {
        const res = await fetch(`${ALMA_API}/api/plugins`);
        if (res.ok) {
            const list = await res.json();
            const plugin = (Array.isArray(list) ? list : list?.plugins ?? []).find(
                (p) => p.id === 'dingtalk-bridge' || p.name === 'DingTalk Bridge',
            );
            if (plugin?.settings) {
                return typeof plugin.settings === 'string' ? JSON.parse(plugin.settings) : plugin.settings;
            }
        }
    } catch {
        /* 忽略，走文件兜底 */
    }

    /* 兜底：直接读插件目录下的 state */
    const candidates = [
        path.join(os.homedir(), '.config/alma/plugins/dingtalk-bridge/settings.json'),
        path.join(os.homedir(), '.config/alma/plugin-state/dingtalk-bridge.json'),
    ];
    for (const file of candidates) {
        try {
            if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            /* 继续 */
        }
    }
    return {};
}

const [staffId, message] = process.argv.slice(2);

if (!staffId || !message) {
    console.error('用法: node cmd/send.mjs <staffId> "消息内容"');
    process.exit(1);
}

const settings = await getPluginSettings();
const clientId = settings['dingtalkBridge.clientId'] || settings.clientId;
const clientSecret = settings['dingtalkBridge.clientSecret'] || settings.clientSecret;
const robotCode = settings['dingtalkBridge.robotCode'] || settings.robotCode || clientId;

if (!clientId || !clientSecret) {
    console.error('未找到钉钉凭据。请先在 Alma 里配置 DingTalk Bridge 插件。');
    process.exit(1);
}

const tokenRes = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
});
const tokenData = await tokenRes.json();
if (!tokenData.accessToken) {
    console.error('获取 accessToken 失败:', JSON.stringify(tokenData).slice(0, 300));
    process.exit(1);
}

const sendRes = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': tokenData.accessToken,
    },
    body: JSON.stringify({
        robotCode,
        userIds: [staffId],
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: message }),
    }),
});

const body = await sendRes.text();
if (!sendRes.ok) {
    console.error('发送失败:', sendRes.status, body.slice(0, 300));
    process.exit(1);
}
console.log('已发送:', body.slice(0, 200));
