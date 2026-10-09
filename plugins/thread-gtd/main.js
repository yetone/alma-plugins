"use strict";
/**
 * Thread GTD Status
 * 状态语义 = 「球在谁手上」：in_progress = Alma 在干活，todo = 等用户处理。
 * 同进程处理事件，不 spawn shell。
 */
const http = require("http");
const path = require("path");
const fs = require("fs");

const HOST = process.env.ALMA_API_HOST || "127.0.0.1";
const PORT = parseInt(process.env.ALMA_API_PORT || "23001", 10);
const LOG = path.join(__dirname, "plugin.log");
const MAX_LOG = 400;

function log(line) {
  try {
    fs.appendFileSync(LOG, new Date().toISOString().slice(11, 19) + "  " + line + "\n");
    const all = fs.readFileSync(LOG, "utf8").split("\n");
    if (all.length > MAX_LOG) fs.writeFileSync(LOG, all.slice(-MAX_LOG).join("\n"));
  } catch (e) { /* 日志失败不能影响主流程 */ }
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: HOST, port: PORT, path: urlPath, method,
        headers: Object.assign({ Accept: "application/json" },
          payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          if (res.statusCode === 404) return reject(new Error("thread not found"));
          if (res.statusCode >= 400) return reject(new Error("HTTP " + res.statusCode));
          try { resolve(raw ? JSON.parse(raw) : null); } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

async function getStatus(threadId) {
  const t = await request("GET", "/api/threads/" + encodeURIComponent(threadId));
  return ((t && t.metadata) || {}).gtdStatus || "inbox";
}

/**
 * metadata 是整体替换 —— 必须 GET 后合并整个对象再 PUT。
 * skipUpdatedAt 防止把会话顶到侧边栏时间线顶部。
 */
async function setStatus(threadId, status, opts) {
  if (!threadId) return "no-thread";
  const unless = (opts && opts.unless) || [];
  const t = await request("GET", "/api/threads/" + encodeURIComponent(threadId));
  const meta = Object.assign({}, (t && t.metadata) || {});
  const cur = meta.gtdStatus || "inbox";
  if (unless.indexOf(cur) !== -1) { log(threadId + "  skip " + status + " (" + cur + " blocked)"); return "skip"; }
  if (cur === status) return "already";
  meta.gtdStatus = status;
  await request("PUT", "/api/threads/" + encodeURIComponent(threadId), { metadata: meta, skipUpdatedAt: true });
  log(threadId + "  " + status);
  return "ok";
}

async function activate(context) {
  const events = context && context.events;
  const logger = context && context.logger;
  const disposables = [];
  // 记录宿主注入的 context 键 —— 用来区分「Alma 真的加载了」和「测试桩调用了」
  log("activate ctx=" + Object.keys(context || {}).sort().join(","));
  if (logger && logger.info) logger.info("[thread-gtd] activated");

  if (!events || typeof events.on !== "function") {
    log("FATAL no context.events — 插件无法工作");
    throw new Error("[thread-gtd] context.events unavailable");
  }

  disposables.push(events.on("chat.message.willSend", async (input) => {
    try { await setStatus(input && input.threadId, "in_progress"); }
    catch (e) { log("ERR willSend: " + (e && e.message)); }
  }));

  disposables.push(events.on("chat.message.didReceive", async (input) => {
    const tid = input && input.threadId;
    const guard = { unless: ["done", "archived"] };   // 保住手写的 done
    try { await setStatus(tid, "todo", guard); }
    catch (e) { log("ERR didReceive: " + (e && e.message)); }
    // 应用会在生成窗口内整体重写 metadata，补一刀
    setTimeout(() => {
      setStatus(tid, "todo", guard).catch((e) => log("ERR retry: " + (e && e.message)));
    }, 3000);
  }));

  return {
    dispose: () => disposables.forEach((d) => { try { d && d.dispose && d.dispose(); } catch (e) {} }),
  };
}

exports.activate = activate;
exports.__test = { setStatus, getStatus, request };
