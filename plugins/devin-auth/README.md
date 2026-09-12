# Devin Auth

Use your Devin subscription with Alma via OAuth, and talk to **SWE-2** (plus Claude, GPT, Gemini, GLM, Kimi and more) through a normal chat provider.

This plugin speaks Codeium's **Cascade** API directly, so there is no `devin acp` subprocess in the loop — no sidecar bridge, no session-matching heuristics. Alma just sees an `openai-compatible` provider and a protocol translator in a custom `fetch`.

## Features

- **OAuth login** against `app.devin.ai` (PKCE), or zero-config reuse of an existing `devin` CLI login.
- **Live model catalog** — pulls your account's models from Codeium's `GetCliModelConfigs` RPC (209 models on a Devin Teams account).
- **Streaming** chat with real per-delta output, including streamed reasoning (`deltaThinking`).
- **Native tool calling** — `stopReason = FUNCTION_CALL` and standard `argumentsJson`, not prompt hacks.
- **Multi-turn** — conversation threads server-side via a stable `cascadeId`, so follow-up turns hit the prompt cache.

## Installation

1. Open Alma Settings → **Plugins**
2. Search for **Devin Auth**
3. Click **Install**

Or install manually:

```bash
git clone https://github.com/yetone/alma-plugins ~/alma-plugins
cp -R ~/alma-plugins/plugins/devin-auth ~/.config/alma/plugins/devin-auth
```

## Usage

### Authentication

1. Go to **Settings → Providers**
2. Find **Devin** and click **Connect**
3. If you already have the `devin` CLI logged in on this machine, the token is picked up automatically.
4. Otherwise your browser opens to Devin's login page; authorise and the callback completes on `127.0.0.1:59653`.

### Using Models

Once authenticated, Devin models appear in the model selector:

- `swe-2-max` — the strongest SWE tier (262K context)
- `swe-2-high`, `swe-2-medium`
- plus `claude-opus-5-medium`, `claude-sonnet-5-medium`, `gemini-3-8-flash-medium`, `glm-5-3-high`, `kimi-k3-high`, … (the full catalog is fetched live; only enabled models appear in chat)

Pick your tier in the model selector; the thinking effort is part of the model uid.

## How it works

Devin's backend is **not** OpenAI-compatible and **not** REST. It's Google's **Connect** protocol over HTTP/1.1 with protobuf payloads:

```
POST https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt                     → user JWT
POST https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs   → model catalog
POST https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage       → streaming chat
```

The first two are unary (`application/proto`, bare protobuf). The third is server-streaming (`application/connect+proto`), where each frame is:

```
byte[0]    flag   bit0 set = payload is gzip, bit1 set = end-of-stream JSON trailer
byte[1..4] uint32BE payload length
byte[5..]  payload
```

This plugin implements that wire format in `lib/proto.ts` (a dependency-free protobuf reader/writer) and `lib/cascade.ts` (the Codeium client), then exposes it to Alma as OpenAI Chat Completions SSE from a custom `fetch` returned by `getSDKConfig()`.

### Two things worth knowing

**1. Devin screens tool definitions and rejects the whole request.**

Some tool name/description pairs make Cascade answer `permission_denied: an internal error occurred` — with no indication that your tools were the problem. The known offender is a tool named exactly `TaskOutput` whose description contains the literal substring `- Takes a task_id parameter identifying the task` (case-sensitive; changing `task_id` to `taskid` makes it pass).

The plugin rewords known offenders before they reach the wire, and keeps a retry ladder in reserve: if a `permission_denied` arrives *before any token*, it retries with progressively lighter tool descriptions. (Retrying after the first token would produce a duplicate answer, so it doesn't.)

**2. Cascade splits one tool call across several deltas.**

Only the first delta of a tool call carries `id` and `name`; later ones just extend `argumentsJson`. The client carries the in-flight id forward and waits for the name before announcing the call — otherwise a single `Bash` invocation shows up as a dozen phantom tool calls.

## Notes on latency

Devin is an agent backend rather than a fast inference pool, and it shows: measured time-to-first-token on a realistic Alma turn (≈38 KB system prompt, ≈15 KB user message, 13 tools) was **20–52 s**, compared with under 3 s for a bare request with the same prompt.

It's a great coding agent — generous quota, native tool calling, 262K context — but a poor choice as a day-to-day chat default. Map it to the coding-agent slot rather than the chat default.

## Disclaimer

For personal use with your own Devin subscription only. Not for commercial resale or multi-user services.
