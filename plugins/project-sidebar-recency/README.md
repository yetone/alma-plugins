# Project Sidebar Recency

In **project** sidebar mode, puts the project with the **most recent conversation** on top.

Alma's project sidebar keeps a hand-arranged order (`ui.projectSidebarOrder`), so a project you
worked on five minutes ago can sit below one you have not opened in a week. This plugin recomputes
that order from thread activity: every project is ranked by the `updatedAt` of its newest thread,
so the sidebar reads as "what I was just doing" instead of "what I dragged up there months ago".

```
before                          after
──────────────────────────      ──────────────────────────
ailiao_one_for_one_CTNBS         Script          (2 min ago)
business                         sdd_back        (6 min ago)
sqtg_back                        社区团购         (yesterday)
minichang_back                   sqtg_back       (yesterday)
pfly_back                        ailiao…         (yesterday)
...                              ...
```

## Behaviour

| Situation | Result |
|---|---|
| Project has threads | Ranked by its **newest** thread's `updatedAt`, most recent first |
| Project has no threads | Sinks below all active projects, keeping its previous relative order |
| Ties on timestamp | Falls back to the order you already had |
| Order already correct | Nothing is written — no needless settings churn |
| Worktree / session workspaces | Rolled up into their parent project; their threads count for the parent |
| Temporary workspaces | Ignored |
| Threads with no project | Stay in `Uncategorized`, which is pinned last |
| Sidebar mode is not "project" | Harmless: the array is written, nothing renders differently |

## Install

Settings > Plugins > Marketplace, or drop the folder into `~/.config/alma/plugins/`
(`%APPDATA%/Alma/plugins/` on Windows) and hit Refresh.

Then set the sidebar to **Project** mode. Re-sorting happens automatically — no restart, no reload.

## Permissions

| Permission | Why |
|---|---|
| `network:localhost` | Reads `/api/settings`, `/api/threads`, `/api/workspaces` and writes the order back via `PUT /api/settings` |
| `notifications` | Only for the manual "Sort Projects by Latest Conversation" command |

No other capability is used: no `tools`, no npm dependencies, plain CommonJS, no build step.

## Commands

| Command | What it does |
|---|---|
| `Project Sidebar: Sort Projects by Latest Conversation` | Forces one re-sort immediately and confirms with a notification |

## Settings

| Key | Default | Meaning |
|---|---|---|
| `projectSidebarRecency.enabled` | `true` | Turn automatic ordering off without uninstalling |
| `projectSidebarRecency.debounceMs` | `1500` | Wait this long after a conversation changes before re-sorting |

## How it works

- Triggers on `app.ready`, `chat.message.didSend`, `chat.message.didReceive`,
  `chat.thread.created` and `chat.thread.deleted`, debounced so a burst of messages causes one write.
- `PUT /api/settings` requires the **complete** settings object (partial updates are rejected with
  404), so the plugin always `GET`s first and merges — it only replaces `ui.projectSidebarOrder`.
- Alma broadcasts `settings_updated` to the renderer after that write, so the sidebar re-sorts
  immediately with no restart.
- Writes only happen when the computed order differs from the stored one, so the plugin is idle
  when nothing moved.
- A rolling `plugin.log` next to `main.js` records every write.

## Tests

```bash
node test/computeOrder.test.js
```

13 cases covering recency ranking, empty projects, ties, worktree roll-up, temporary workspaces,
the uncategorized bucket, and the "already correct → don't write" path.

## Notes

- Override the endpoint with `ALMA_API_HOST` / `ALMA_API_PORT` if Alma listens elsewhere.
- Dragging a project in the sidebar still works; the next conversation change re-sorts by recency.
  Turn `enabled` off if you would rather keep a fully manual order.

## License

MIT
