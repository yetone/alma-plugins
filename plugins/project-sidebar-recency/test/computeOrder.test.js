"use strict";

/**
 * Unit tests for the pure ordering function. No network, no Alma needed:
 *   node test/computeOrder.test.js
 */

const assert = require("assert");
const { computeOrder } = require("../main.js");

const UNC = "__uncategorized__";

function ws(id, extra) {
    return Object.assign(
        {
            id,
            name: id,
            isTemporary: false,
            isWorktree: false,
            parentWorkspaceId: null,
        },
        extra || {}
    );
}

function th(id, workspaceId, updatedAt, extra) {
    return Object.assign({ id, workspaceId, updatedAt, createdAt: updatedAt }, extra || {});
}

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

/* ------------------------------------------------------------------- cases */

test("most recent conversation wins", () => {
    const workspaces = [ws("a"), ws("b"), ws("c")];
    const threads = [
        th("t1", "a", "2026-11-01T00:00:00Z"),
        th("t2", "b", "2026-11-03T00:00:00Z"),
        th("t3", "c", "2026-11-02T00:00:00Z"),
    ];
    const { order } = computeOrder({ threads, workspaces, current: ["a", "b", "c"] });
    assert.deepStrictEqual(order.filter((id) => id !== UNC), ["b", "c", "a"]);
});

test("the newest thread of a project counts, not the oldest", () => {
    const workspaces = [ws("a"), ws("b")];
    const threads = [
        th("a-old", "a", "2026-01-01T00:00:00Z"),
        th("a-new", "a", "2026-12-01T00:00:00Z"),
        th("b-mid", "b", "2026-06-01T00:00:00Z"),
    ];
    const { order } = computeOrder({ threads, workspaces, current: ["b", "a"] });
    assert.deepStrictEqual(order.filter((id) => id !== UNC), ["a", "b"]);
});

test("projects without conversations sink below active ones, keeping their order", () => {
    const workspaces = [ws("idle1"), ws("idle2"), ws("active")];
    const threads = [th("t1", "active", "2026-11-01T00:00:00Z")];
    const { order } = computeOrder({
        threads,
        workspaces,
        current: ["idle1", "active", "idle2"],
    });
    assert.deepStrictEqual(order.filter((id) => id !== UNC), ["active", "idle1", "idle2"]);
});

test("no threads at all keeps the user's arrangement", () => {
    const workspaces = [ws("a"), ws("b"), ws("c")];
    const current = ["c", "a", "b"];
    const { order, changed } = computeOrder({ threads: [], workspaces, current });
    assert.deepStrictEqual(order.filter((id) => id !== UNC), current);
    assert.strictEqual(changed, false);
});

test("worktree and session workspaces roll up into their parent project", () => {
    const workspaces = [
        ws("main"),
        ws("wt", { isWorktree: true, parentWorkspaceId: "main" }),
        ws("other"),
    ];
    const threads = [
        th("t1", "wt", "2026-11-05T00:00:00Z"),
        th("t2", "other", "2026-11-01T00:00:00Z"),
    ];
    const { order } = computeOrder({ threads, workspaces, current: ["other", "main"] });
    assert.deepStrictEqual(order.filter((id) => id !== UNC), ["main", "other"]);
    // the worktree itself must not appear as its own row
    assert.ok(!order.includes("wt"));
});

test("temporary workspaces are ignored", () => {
    const workspaces = [ws("real"), ws("tmp", { isTemporary: true })];
    const threads = [
        th("t1", "tmp", "2026-12-31T00:00:00Z"),
        th("t2", "real", "2026-01-01T00:00:00Z"),
    ];
    const { order } = computeOrder({ threads, workspaces, current: ["real", "tmp"] });
    assert.deepStrictEqual(order.filter((id) => id !== UNC), ["real"]);
});

test("uncategorized bucket stays last", () => {
    const workspaces = [ws("a")];
    const threads = [th("t1", "a", "2026-11-01T00:00:00Z")];
    const { order } = computeOrder({ threads, workspaces, current: [UNC, "a"] });
    assert.strictEqual(order[order.length - 1], UNC);
});

test("an unassigned thread lands in uncategorized, not in a project", () => {
    const workspaces = [ws("a")];
    const threads = [
        th("loose", null, "2026-12-31T00:00:00Z"),
        th("t1", "a", "2026-01-01T00:00:00Z"),
    ];
    const { order } = computeOrder({ threads, workspaces, current: ["a", UNC] });
    assert.deepStrictEqual(order.filter((id) => id !== UNC), ["a"]);
});

test("changed=false when the order is already correct", () => {
    const workspaces = [ws("a"), ws("b")];
    const threads = [
        th("t1", "a", "2026-11-02T00:00:00Z"),
        th("t2", "b", "2026-11-01T00:00:00Z"),
    ];
    const current = ["a", "b", UNC];
    const { changed, order } = computeOrder({ threads, workspaces, current });
    assert.deepStrictEqual(order, current);
    assert.strictEqual(changed, false);
});

test("equal timestamps fall back to the existing arrangement", () => {
    const workspaces = [ws("a"), ws("b")];
    const threads = [
        th("t1", "a", "2026-11-01T00:00:00Z"),
        th("t2", "b", "2026-11-01T00:00:00Z"),
    ];
    const { order } = computeOrder({ threads, workspaces, current: ["b", "a"] });
    assert.deepStrictEqual(order.filter((id) => id !== UNC), ["b", "a"]);
});

test("threads pointing at unknown workspaces are ignored", () => {
    const workspaces = [ws("a")];
    const threads = [
        th("ghost", "does-not-exist", "2026-12-31T00:00:00Z"),
        th("t1", "a", "2026-01-01T00:00:00Z"),
    ];
    const { order } = computeOrder({ threads, workspaces, current: ["a"] });
    assert.deepStrictEqual(order.filter((id) => id !== UNC), ["a"]);
});

test("no current order still produces a usable ranking", () => {
    const workspaces = [ws("a"), ws("b")];
    const threads = [th("t1", "b", "2026-11-01T00:00:00Z")];
    const { order } = computeOrder({ threads, workspaces, current: [] });
    assert.deepStrictEqual(order.filter((id) => id !== UNC), ["b", "a"]);
});

test("ranking exposes the latest timestamp per project", () => {
    const workspaces = [ws("a"), ws("b")];
    const threads = [
        th("t1", "a", "2026-11-01T00:00:00Z"),
        th("t2", "b", "2026-11-02T00:00:00Z"),
    ];
    const { ranked } = computeOrder({ threads, workspaces, current: ["a", "b"] });
    assert.deepStrictEqual(ranked, [
        { id: "b", latest: Date.parse("2026-11-02T00:00:00Z") },
        { id: "a", latest: Date.parse("2026-11-01T00:00:00Z") },
    ]);
});

/* -------------------------------------------------------------------- runner */

let failed = 0;
for (const { name, fn } of tests) {
    try {
        fn();
        console.log("  ok   " + name);
    } catch (error) {
        failed++;
        console.log("  FAIL " + name);
        console.log("       " + (error && error.message ? error.message.split("\n").join("\n       ") : error));
    }
}
console.log("\n" + (tests.length - failed) + "/" + tests.length + " passed");
process.exit(failed === 0 ? 0 : 1);
