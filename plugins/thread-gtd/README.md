# Thread GTD Status

Keeps the GTD status of every conversation in sync with **who needs to act** — so the sidebar
becomes a "what needs my attention" board instead of a graveyard.

| Event | Sets status to |
|---|---|
| `chat.message.willSend` (user sends a message) | `in_progress` — Alma is working on it |
| `chat.message.didReceive` (Alma finished replying) | `todo` — waiting on you |

`done` and `archived` are never written by this plugin: close a thread yourself and it stays
closed — the `todo` write skips threads already `done`/`archived`.

## Why

In Alma's GTD sidebar mode, status is the primary grouping. With this plugin the grouping answers
one question: **whose turn is it?**

## Install

Settings > Plugins > Marketplace → search "Thread GTD Status".

Requires sidebar mode **GTD** to show the status grouping.

## Permissions

| Permission | Why |
|---|---|
| `chat:read` | Reads thread metadata (current GTD status) |
| `network:localhost` | Writes status back to the local Alma API (`PUT /api/threads/:id`) |

## How it works

- `GET /api/threads/:id`, merge `metadata.gtdStatus`, then `PUT` back with `skipUpdatedAt: true`
  (so the sidebar's time ordering is untouched). `metadata` is replaced wholesale by this
  endpoint — the merge is mandatory, dropping `activePath` would rebuild the branch.
- Alma may rewrite `thread.metadata` wholesale while a generation is in flight; a single deferred
  re-assert (3s) re-applies the status after that window closes.
- No CLI, no settings: it just runs. A rolling `plugin.log` next to `main.js` records every write.

## Notes

- Hidden threads (`alma run`, cron isolated runs) may log `thread not found` — they are not part
  of `/api/threads` and are skipped. Expected noise.
- Override the endpoint with `ALMA_API_HOST` / `ALMA_API_PORT` if Alma listens elsewhere.
- Zero npm dependencies, plain CommonJS, no build step.

## License

MIT
