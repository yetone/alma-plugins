"use strict";

/**
 * Project Sidebar Recency
 *
 * In project sidebar mode, orders projects by "most recent conversation":
 * the project whose newest thread was touched last goes to the top.
 * Projects without any conversation keep their relative order below the active ones.
 *
 * The sidebar order lives in `ui.projectSidebarOrder` (an array of workspace ids),
 * so the plugin reads the app settings over the local API, recomputes the array and
 * writes it back. Alma broadcasts `settings_updated` to the renderer, so the sidebar
 * re-sorts immediately without a restart.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = process.env.ALMA_API_HOST || "127.0.0.1";
const PORT = parseInt(process.env.ALMA_API_PORT || "23001", 10);

const UNC = "__uncategorized__";
const ORDER_KEY = "projectSidebarOrder";
const LOG = path.join(__dirname, "plugin.log");
const MAX_LOG_LINES = 400;

const DEFAULT_DEBOUNCE_MS = 1500;

/* ------------------------------------------------------------------ logging */

function log(line) {
    try {
        fs.appendFileSync(LOG, new Date().toISOString().slice(11, 19) + "  " + line + "\n");
        const lines = fs.readFileSync(LOG, "utf8").split("\n");
        if (lines.length > MAX_LOG_LINES) {
            fs.writeFileSync(LOG, lines.slice(-MAX_LOG_LINES).join("\n"));
        }
    } catch (e) {
        /* a broken log must never break the feature */
    }
}

/* ---------------------------------------------------------------------- http */

function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = { Accept: "application/json" };
        if (payload !== null) {
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = Buffer.byteLength(payload);
        }
        const req = http.request(
            { host: HOST, port: PORT, path: urlPath, method, headers },
            (res) => {
                let raw = "";
                res.on("data", (chunk) => {
                    raw += chunk;
                });
                res.on("end", () => {
                    if (res.statusCode >= 400) {
                        return reject(new Error("HTTP " + res.statusCode + " " + method + " " + urlPath));
                    }
                    if (!raw) return resolve(null);
                    try {
                        resolve(JSON.parse(raw));
                    } catch (e) {
                        reject(new Error("bad JSON from " + urlPath));
                    }
                });
            }
        );
        req.on("error", reject);
        req.setTimeout(15000, () => req.destroy(new Error("timeout " + method + " " + urlPath)));
        if (payload !== null) req.write(payload);
        req.end();
    });
}

/* ------------------------------------------------------------------- ordering */

/**
 * Walks `parentWorkspaceId` up to the top-level project.
 * Worktree / session workspaces hang off a real project; their threads belong to it.
 */
function makeRootResolver(workspaces) {
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    return function rootOf(id) {
        let cur = byId.get(id);
        let guard = 0;
        while (cur && cur.parentWorkspaceId && guard++ < 32) {
            const parent = byId.get(cur.parentWorkspaceId);
            if (!parent) break;
            cur = parent;
        }
        return cur ? cur.id : null;
    };
}

/**
 * Pure ordering function — exported for tests.
 *
 * @returns {{ order: string[], changed: boolean, ranked: Array<{id: string, latest: number|null}> }}
 */
function computeOrder({ threads, workspaces, current }) {
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    const rootOf = makeRootResolver(workspaces);

    // Newest thread timestamp per top-level project.
    const latest = new Map();
    for (const thread of threads) {
        if (!thread || !thread.workspaceId) continue;
        if (thread.isTemporary) continue;
        const root = rootOf(thread.workspaceId);
        if (!root || !byId.has(root)) continue;
        const ts = Date.parse(thread.updatedAt || thread.createdAt || "");
        if (!Number.isFinite(ts)) continue;
        const prev = latest.get(root);
        if (prev === undefined || ts > prev) latest.set(root, ts);
    }

    // Projects the sidebar can actually show: top-level, not temporary, not worktree.
    const roots = workspaces
        .filter((w) => !w.isTemporary && !w.isWorktree)
        .filter((w) => !(w.parentWorkspaceId && byId.has(w.parentWorkspaceId)))
        .map((w) => w.id);

    const base = Array.isArray(current) && current.length ? current : roots;
    const position = new Map(base.map((id, index) => [id, index]));
    const pos = (id) => (position.has(id) ? position.get(id) : Number.MAX_SAFE_INTEGER);

    const active = [];
    const idle = [];
    for (const id of roots) {
        (latest.has(id) ? active : idle).push(id);
    }

    // Most recently used first; ties fall back to the user's own arrangement.
    active.sort((a, b) => latest.get(b) - latest.get(a) || pos(a) - pos(b));
    // Projects with no conversation keep the relative order they already had.
    idle.sort((a, b) => pos(a) - pos(b));

    const order = active.concat(idle);

    // Carry over ids that the sidebar renders but this pass did not rank — the synthetic
    // "uncategorized" bucket, plus any top-level project missing from `roots` (e.g. one
    // created between the two API reads). Keeping them means the plugin never drops an
    // entry the sidebar still shows; temporary/worktree ids are deliberately not carried,
    // because the sidebar does not render them as rows.
    const carried = Array.isArray(current) ? current : [];
    const seen = new Set(order);
    for (const id of carried) {
        if (seen.has(id)) continue;
        const known = byId.get(id);
        const renderable = id === UNC || (known && !known.isTemporary && !known.isWorktree);
        if (!renderable) continue;
        seen.add(id);
        order.push(id);
    }

    const previous = Array.isArray(current) ? current : [];
    const changed = previous.length !== order.length || previous.some((id, i) => id !== order[i]);

    const ranked = order
        .filter((id) => id !== UNC)
        .map((id) => ({ id, latest: latest.has(id) ? latest.get(id) : null }));

    return { order, changed, ranked };
}

/* ------------------------------------------------------------------- syncing */

function createSync(context) {
    const { logger, settings } = context;
    let running = false;
    let pendingForce = false;
    let timer = null;

    const enabled = () => {
        const value = settings.get("projectSidebarRecency.enabled", true);
        return value !== false;
    };

    const debounceMs = () => {
        const value = Number(settings.get("projectSidebarRecency.debounceMs", DEFAULT_DEBOUNCE_MS));
        return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DEBOUNCE_MS;
    };

    async function runOnce(force) {
        if (!enabled()) return "disabled";

        const [appSettings, threads, workspaces] = await Promise.all([
            request("GET", "/api/settings"),
            request("GET", "/api/threads"),
            request("GET", "/api/workspaces"),
        ]);
        if (!appSettings || !Array.isArray(threads) || !Array.isArray(workspaces)) {
            throw new Error("unexpected API payload");
        }

        const ui = appSettings.ui || {};
        const current = Array.isArray(ui[ORDER_KEY]) ? ui[ORDER_KEY] : [];
        const { order, changed } = computeOrder({ threads, workspaces, current });

        if (!changed && !force) return "unchanged";

        appSettings.ui = Object.assign({}, ui, { [ORDER_KEY]: order });
        await request("PUT", "/api/settings", appSettings);
        log("wrote " + order.length + " ids: " + order.slice(0, 5).join(",") + (order.length > 5 ? ",…" : ""));
        return "written";
    }

    function schedule(force) {
        if (!enabled()) return;
        if (force) pendingForce = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            drain();
        }, force ? 0 : debounceMs());
    }

    async function drain() {
        if (running) return;
        running = true;
        const force = pendingForce;
        pendingForce = false;
        try {
            const result = await runOnce(force);
            if (result === "written") logger.info("[project-sidebar-recency] reordered");
        } catch (error) {
            log("error: " + (error && error.message ? error.message : String(error)));
            logger.warn("[project-sidebar-recency] sync failed: " + (error && error.message));
        } finally {
            running = false;
            if (pendingForce) schedule(true);
        }
    }

    return {
        schedule,
        sortNow: () => runOnce(true),
        dispose: () => {
            if (timer) clearTimeout(timer);
            timer = null;
        },
    };
}

/* ------------------------------------------------------------------ activate */

async function activate(context) {
    const { logger, events, commands, ui } = context;
    logger.info("Project Sidebar Recency activated");
    log("activated");

    const sync = createSync(context);
    const disposables = [];

    const on = (hook) => {
        try {
            disposables.push(
                events.on(hook, () => {
                    sync.schedule(false);
                })
            );
        } catch (e) {
            logger.warn("[project-sidebar-recency] cannot subscribe " + hook + ": " + e.message);
        }
    };

    ["app.ready", "chat.message.didSend", "chat.message.didReceive", "chat.thread.created", "chat.thread.deleted"].forEach(on);

    disposables.push(
        commands.register("projectSidebarRecency.sortNow", async () => {
            const result = await sync.sortNow();
            ui.showNotification(
                result === "disabled" ? "Auto sorting is off" : "Projects reordered by latest conversation",
                { type: result === "disabled" ? "warning" : "success" }
            );
            return result;
        })
    );

    // A project may already be stale when the plugin is installed or re-enabled.
    sync.schedule(true);

    return {
        dispose: () => {
            sync.dispose();
            disposables.forEach((d) => {
                try {
                    d.dispose();
                } catch (e) {
                    /* ignore */
                }
            });
            log("deactivated");
        },
    };
}

module.exports = { activate, computeOrder };
