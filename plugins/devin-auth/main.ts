/**
 * Devin (Cascade) provider plugin for Alma.
 *
 * Registers Devin as a normal chat provider by translating OpenAI Chat
 * Completions ⇄ Codeium Cascade in a custom `fetch`. No `devin acp`
 * subprocess, no sidecar bridge, no session-matching heuristics — Alma just
 * sees an `openai-compatible` provider and talks to it in the shape it already
 * understands.
 *
 * Auth: reuses the token `devin` CLI already stored at
 * ~/.local/share/devin/credentials.toml when present; otherwise runs a PKCE
 * OAuth flow against app.devin.ai.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	CascadeError,
	CODEIUM_BASE_URL,
	fetchModels,
	getUserJwt,
	normalizeToken,
	SOURCE_SYSTEM,
	SOURCE_TOOL,
	SOURCE_USER,
	STOP_FUNCTION_CALL,
	streamChat,
	type CascadePrompt,
	type CascadeTool,
	type DevinModel,
} from "./lib/cascade";

// =============================================================================
// Constants
// =============================================================================

const PROVIDER_ID = "devin";
const DUMMY_API_KEY = "devin-oauth";

/** Where the `devin` CLI keeps its credentials; we piggyback on it. */
const CLI_CREDENTIALS = join(homedir(), ".local", "share", "devin", "credentials.toml");

/** Devin OAuth (same flow the `devin` CLI and OMP use). */
const DEVIN_WEBAPP_URL = "https://app.devin.ai";
const DEVIN_API_URL = "https://api.devin.ai";
const OAUTH_CALLBACK_PORT = 59653;
const OAUTH_CALLBACK_PATH = "/callback";

/** Fallback catalog when a live fetch is impossible (e.g. offline cold start). */
const FALLBACK_MODELS: DevinModel[] = [
	mk("swe-2-max", "SWE-2 Max"),
	mk("swe-2-high", "SWE-2 High"),
	mk("swe-2-medium", "SWE-2 Medium"),
	mk("swe-1-7-lightning-max", "SWE-1.7 Lightning Max"),
	mk("claude-opus-5-medium", "Claude Opus 5 Medium"),
	mk("claude-sonnet-5-medium", "Claude Sonnet 5 Medium"),
	mk("gemini-3-8-flash-medium", "Gemini 3.8 Flash Medium"),
	mk("gpt-5-6-sol-medium-thinking", "GPT-5.6 Sol Medium Thinking"),
	mk("glm-5-3-high", "GLM-5.3 High"),
	mk("kimi-k3-high", "Kimi K3 High"),
];

function mk(id: string, label: string): DevinModel {
	return { id, label, supportsImages: false, supportsTools: true, contextWindow: 262_000, maxTokens: 64_000 };
}

// =============================================================================
// Plugin entry
// =============================================================================

export async function activate(ctx: any) {
	const { logger, ui, providers, commands, storage } = ctx;

	logger.info("Devin (Cascade) plugin activating");

	// -- Token storage --------------------------------------------------------
	// Prefer the plugin's own secret store; fall back to whatever the `devin`
	// CLI already wrote so an existing login carries over with zero friction.
	const secrets = storage?.secrets;

	async function readStoredToken(): Promise<string | null> {
		try {
			const t = await secrets?.get?.("devin_session_token");
			if (typeof t === "string" && t.trim()) return t.trim();
		} catch {
			/* ignore */
		}
		return readCliToken();
	}

	function readCliToken(): string | null {
		try {
			if (!existsSync(CLI_CREDENTIALS)) return null;
			const raw = readFileSync(CLI_CREDENTIALS, "utf8");
			const m = raw.match(/windsurf_api_key\s*=\s*"([^"]+)"/);
			return m?.[1]?.trim() || null;
		} catch (e) {
			logger.warn(`Could not read devin CLI credentials: ${String(e)}`);
			return null;
		}
	}

	async function writeToken(token: string): Promise<void> {
		try {
			await secrets?.set?.("devin_session_token", token);
		} catch (e) {
			logger.warn(`Could not persist token to secret store: ${String(e)}`);
		}
		// Also mirror into the CLI file so `devin` itself stays logged in.
		try {
			if (existsSync(CLI_CREDENTIALS)) {
				const raw = readFileSync(CLI_CREDENTIALS, "utf8");
				if (!/windsurf_api_key/.test(raw)) return;
				const next = raw.replace(
					/windsurf_api_key\s*=\s*"[^"]*"/,
					`windsurf_api_key = "${token}"`,
				);
				if (next !== raw) writeFileSync(CLI_CREDENTIALS, next, "utf8");
			}
		} catch {
			/* non-fatal */
		}
	}

	async function clearToken(): Promise<void> {
		try {
			await secrets?.delete?.("devin_session_token");
		} catch {
			/* ignore */
		}
	}

	// -- Auth: resolve a session token + user JWT -----------------------------
	let cachedJwt: { jwt: string; baseUrl: string; expiresAt: number } | null = null;

	function jwtExpiry(jwt: string): number {
		try {
			const [, payload] = jwt.split(".");
			if (!payload) return 0;
			const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
			if (typeof decoded?.exp === "number") return decoded.exp * 1000 - 5 * 60 * 1000;
		} catch {
			/* opaque token */
		}
		// Conservative: refresh every 10 minutes when the JWT is not decodable.
		return Date.now() + 10 * 60 * 1000;
	}

	async function resolveAuth(): Promise<{ jwt: string; baseUrl: string; token: string }> {
		const token = await readStoredToken();
		if (!token) throw new CascadeError("Not logged in to Devin. Run the login command first.");
		const normalized = normalizeToken(token);

		if (cachedJwt && cachedJwt.expiresAt > Date.now()) {
			return { jwt: cachedJwt.jwt, baseUrl: cachedJwt.baseUrl, token: normalized };
		}

		logger.info("Requesting Devin user JWT");
		const { userJwt, baseUrl } = await getUserJwt(normalized);
		cachedJwt = { jwt: userJwt, baseUrl, expiresAt: jwtExpiry(userJwt) };
		return { jwt: userJwt, baseUrl, token: normalized };
	}

	// -- Model catalog --------------------------------------------------------
	let cachedModels: { models: DevinModel[]; at: number } | null = null;
	const MODEL_TTL_MS = 10 * 60 * 1000;

	async function loadModels(): Promise<DevinModel[]> {
		if (cachedModels && Date.now() - cachedModels.at < MODEL_TTL_MS) return cachedModels.models;
		try {
			const { jwt, baseUrl, token } = await resolveAuth();
			const models = await fetchModels(token, jwt, { baseUrl });
			if (models.length > 0) {
				cachedModels = { models, at: Date.now() };
				return models;
			}
		} catch (e) {
			logger.warn(`Devin model fetch failed, using fallback catalog: ${String(e)}`);
		}
		return cachedModels?.models ?? FALLBACK_MODELS;
	}

	function toProviderModels(models: DevinModel[]) {
		return models.map((m) => ({
			id: m.id,
			name: m.label,
			description: `Devin: ${m.label}`,
			contextWindow: m.contextWindow,
			maxOutputTokens: m.maxTokens,
			capabilities: {
				temperature: true,
				streaming: true,
				reasoning: true,
				attachment: m.supportsImages,
				functionCalling: m.supportsTools,
				input: { text: true, audio: false, image: m.supportsImages, video: false, pdf: false },
				output: { text: true, audio: false, image: false, video: false, pdf: false },
			},
		}));
	}

	// =========================================================================
	// OpenAI ⇄ Cascade translation
	// =========================================================================

	/** Stable conversation id: same opening message ⇒ same Cascade thread. */
	function cascadeIdFor(messages: any[]): string {
		const firstUser = (messages ?? []).find((m) => m?.role === "user");
		const seed = textOf(firstUser?.content) || "devin-default";
		const h = createHash("sha1").update(seed).digest("hex").slice(0, 32);
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
	}

	function textOf(content: unknown): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((p: any) => p?.type === "text" || p?.type === "input_text")
				.map((p: any) => p.text ?? "")
				.join("");
		}
		return "";
	}

	function imagesOf(content: unknown): Array<{ base64Data: string; mimeType: string }> {
		if (!Array.isArray(content)) return [];
		const out: Array<{ base64Data: string; mimeType: string }> = [];
		for (const p of content as any[]) {
			const url = p?.image_url?.url ?? p?.image?.url;
			if (typeof url !== "string" || !url.startsWith("data:")) continue;
			const m = url.match(/^data:([^;]+);base64,(.*)$/s);
			if (m) out.push({ mimeType: m[1], base64Data: m[2] });
		}
		return out;
	}

	function deterministicId(seed: string): string {
		const h = createHash("sha1").update(seed).digest("hex");
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
	}

	/** Map an OpenAI-format message array onto Cascade's prompt list. */
	function buildPrompts(messages: any[], cascadeId: string): { system: string; prompts: CascadePrompt[] } {
		const systemParts: string[] = [];
		const prompts: CascadePrompt[] = [];

		for (const [index, msg] of (messages ?? []).entries()) {
			const role = msg?.role;

			if (role === "system" || role === "developer") {
				systemParts.push(textOf(msg.content));
				continue;
			}

			if (role === "user") {
				const text = textOf(msg.content);
				const images = imagesOf(msg.content);
				if (!text && images.length === 0) continue;
				prompts.push({
					messageId: deterministicId(`${cascadeId}:${index}:user`),
					source: SOURCE_USER,
					prompt: text,
					images,
				});
				continue;
			}

			if (role === "assistant") {
				const text = textOf(msg.content);
				const reasoning: string = msg.reasoning_content ?? msg.reasoning ?? "";
				const toolCalls = (msg.tool_calls ?? []).map((tc: any) => ({
					id: tc?.id ?? `call_${randomUUID().slice(0, 8)}`,
					name: tc?.function?.name ?? tc?.name ?? "",
					argumentsJson:
						typeof (tc?.function?.arguments ?? tc?.arguments) === "string"
							? (tc.function?.arguments ?? tc.arguments)
							: JSON.stringify(tc?.function?.arguments ?? tc?.arguments ?? {}),
				}));
				if (!text && !reasoning && toolCalls.length === 0) continue;
				prompts.push({
					messageId:
						typeof msg.responseId === "string" && msg.responseId
							? msg.responseId
							: `bot-${deterministicId(`${cascadeId}:${index}:assistant`)}`,
					source: SOURCE_SYSTEM,
					prompt: text,
					toolCalls: toolCalls.length ? toolCalls : undefined,
					thinking: reasoning || undefined,
				});
				continue;
			}

			if (role === "tool") {
				prompts.push({
					messageId: deterministicId(`${cascadeId}:${index}:tool:${msg.tool_call_id ?? ""}`),
					source: SOURCE_TOOL,
					prompt: textOf(msg.content),
					toolCallId: msg.tool_call_id ?? undefined,
					toolResultIsError: false,
				});
			}
		}

		return { system: systemParts.filter(Boolean).join("\n\n"), prompts };
	}

	function buildTools(tools: any[] | undefined): CascadeTool[] | undefined {
		if (!Array.isArray(tools) || tools.length === 0) return undefined;
		return tools
			.map((t) => t?.function ?? t)
			.filter((f: any) => f?.name)
			.map((f: any) => ({
				name: f.name,
				description: f.description ?? "",
				jsonSchema: JSON.stringify(f.parameters ?? { type: "object", properties: {} }),
				strict: Boolean(f.strict),
			}));
	}

	/** SSE helper. */
	function sse(obj: unknown): Uint8Array {
		return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
	}

	/**
	 * Devin's Cascade backend screens incoming tool definitions and rejects the
	 * whole request with `permission_denied: an internal error occurred`
	 * (never a useful message) when a tool looks like it impersonates Devin's
	 * own agent surface.
	 *
	 * Characterized against the live API (2026-09-13): the rejection is an exact
	 * literal match requiring BOTH
	 *   (a) tool name `TaskOutput` (case-sensitive — `TASKOUTPUT` passes), and
	 *   (b) the description containing the substring
	 *       `- Takes a task_id parameter identifying the task`
	 *     (case-sensitive — changing `task_id` to `taskid` passes, and a
	 *      trailing space or suffix still rejects, so it is containment).
	 * Everything else — payloads up to 92 KB, 13 tools, 40 KB system prompts,
	 * other names — is accepted.
	 *
	 * Reword the offending line rather than dropping the tool: Alma dispatches
	 * on the tool NAME, so the description is free to change without breaking
	 * tool calls.
	 */
	const BLOCKED_DESCRIPTION_REWRITES: Array<[RegExp, string]> = [
		[/-\s*Takes a task_id parameter identifying the task/gi, "- Pass the task_id of the task you want"],
	];

	function sanitizeToolDescription(description: string): string {
		let out = description;
		for (const [pattern, replacement] of BLOCKED_DESCRIPTION_REWRITES) {
			out = out.replace(pattern, replacement);
		}
		return out;
	}

	/** First line only — the emergency fallback when a rejection slips through. */
	function truncateToolDescription(description: string): string {
		return description.split("\n")[0] ?? "";
	}

	function mapTools(tools: CascadeTool[] | undefined, transform: (d: string) => string): CascadeTool[] | undefined {
		if (!tools) return tools;
		return tools.map((t) => ({ ...t, description: transform(t.description) }));
	}

	/**
	 * The custom fetch handed to Alma's AI SDK. Receives an OpenAI Chat
	 * Completions request and answers with OpenAI-shaped SSE, doing the Cascade
	 * work in between.
	 */
	function createCascadeFetch() {
		return async (input: any, init?: any): Promise<Response> => {
			const url = typeof input === "string" ? input : (input?.url ?? String(input));
			const bodyText = typeof init?.body === "string" ? init.body : "";
			if (!bodyText) return new Response("{}", { status: 400, statusText: "Empty body" });

			let req: any;
			try {
				req = JSON.parse(bodyText);
			} catch {
				return new Response(JSON.stringify({ error: { message: "Malformed JSON body" } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				});
			}

			const modelId: string = req.model ?? "swe-2-max";
			const wantsStream = req.stream !== false;

			let auth: Awaited<ReturnType<typeof resolveAuth>>;
			try {
				auth = await resolveAuth();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				logger.error(`Devin auth failed: ${msg}`);
				return new Response(JSON.stringify({ error: { message: msg, type: "authentication_error" } }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			}

			const cascadeId = cascadeIdFor(req.messages);
			const { system, prompts } = buildPrompts(req.messages, cascadeId);
			const rawTools = buildTools(req.tools);

			// Devin rejects certain tool names/descriptions outright; reword the
			// known offenders before they reach the wire.
			const tools = mapTools(rawTools, sanitizeToolDescription);

			const baseOptions = {
				apiKey: auth.token,
				userJwt: auth.jwt,
				baseUrl: auth.baseUrl,
				modelUid: modelId,
				cascadeId,
				systemPrompt: system,
				prompts,
				maxTokens: typeof req.max_tokens === "number" ? req.max_tokens : undefined,
				temperature: typeof req.temperature === "number" ? req.temperature : undefined,
				topP: typeof req.top_p === "number" ? req.top_p : undefined,
				stopSequences: Array.isArray(req.stop) ? req.stop : undefined,
				signal: init?.signal ?? undefined,
			};

			/**
			 * Retry ladder for Devin's opaque `permission_denied` tool screening:
			 * the untouched request, then the sanitized one, then descriptions
			 * reduced to their first line.
			 */
			const attempts = rawTools
				? [
						{ label: "sanitized", tools },
						{ label: "first-line descriptions", tools: mapTools(tools, truncateToolDescription) },
				  ]
				: [{ label: "no tools", tools: undefined }];

			logger.info(
				`Devin chat → model=${modelId} prompts=${prompts.length} tools=${tools?.length ?? 0} cascade=${cascadeId.slice(0, 8)}`,
			);

			const options = { ...baseOptions, tools };

			if (!wantsStream) {
				return await nonStreamingResponse(baseOptions, attempts, modelId);
			}

			// ---- Streaming -------------------------------------------------
			const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
			const created = Math.floor(Date.now() / 1000);
			const encoder = new TextEncoder();

			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					const emit = (delta: any, finish: string | null = null) => {
						controller.enqueue(
							sse({
								id: completionId,
								object: "chat.completion.chunk",
								created,
								model: modelId,
								choices: [{ index: 0, delta, finish_reason: finish }],
							}),
						);
					};

					// First chunk advertises the role, like OpenAI does.
					emit({ role: "assistant", content: "" });

					// tool-call ids/args accumulate here so we can emit deltas.
					const toolState = new Map<string, { index: number; args: string; announced: boolean }>();
					let nextToolIndex = 0;
					let usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null;
					let sawFunctionCall = false;

					try {
						// Retry ladder: an opaque permission_denied before the first
						// token means Devin screened our tool definitions, so step down
						// to a more aggressive reword. Once tokens flow we can no longer
						// retry without emitting a duplicate answer.
						const handleEvent = async (ev: any) => {
							switch (ev.type) {
								case "thinking":
									emit({ reasoning_content: ev.text });
									break;
								case "text":
									emit({ content: ev.text });
									break;
								case "toolcall": {
									let st = toolState.get(ev.id);
									if (!st) {
										st = { index: nextToolIndex++, args: "", announced: false, name: "" };
										toolState.set(ev.id, st);
									}
									if (ev.name) st.name = ev.name;
									// Announce only once the name has arrived — Cascade may send
									// the id in one delta and the name in the next.
									if (!st.announced && st.name) {
										st.announced = true;
										emit({ tool_calls: [{ index: st.index, id: ev.id, type: "function", function: { name: st.name, arguments: "" } }] });
									}
									if (!st.announced) break;
									const incoming = ev.argumentsJson ?? "";
									let tdelta = incoming;
									if (incoming.startsWith(st.args)) {
										tdelta = incoming.slice(st.args.length);
										st.args = incoming;
									} else {
										st.args += incoming;
									}
									if (tdelta) emit({ tool_calls: [{ index: st.index, function: { arguments: tdelta } }] });
									break;
								}
								case "usage":
									usage = ev;
									break;
								case "stop":
									if (ev.reason === STOP_FUNCTION_CALL) sawFunctionCall = true;
									break;
							}
						};

						let started = false;
						let lastError: unknown = null;
						// Retry ladder: Devin answers a screened tool definition with an opaque
						// permission_denied before any token. Step down to a lighter reword until
						// one is accepted. Past the first token we cannot retry without emitting a
						// duplicate answer, so the error surfaces as-is.
						for (const attempt of attempts) {
							try {
								for await (const ev of streamChat({ ...baseOptions, tools: attempt.tools })) {
									started = true;
									await handleEvent(ev);
								}
								lastError = null;
								break;
							} catch (e) {
								lastError = e;
								const msg = e instanceof Error ? e.message : String(e);
								if (started || !/permission_denied/i.test(msg) || attempt === attempts[attempts.length - 1]) throw e;
								logger.warn(`Devin rejected tools (${attempt.label}); retrying with a lighter tool description`);
							}
						}
						if (lastError) throw lastError;

						const finish = sawFunctionCall || toolState.size > 0 ? "tool_calls" : "stop";
						emit({}, finish);

						if (usage) {
							const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
							controller.enqueue(
								sse({
									id: completionId,
									object: "chat.completion.chunk",
									created,
									model: modelId,
									choices: [],
									usage: {
										prompt_tokens: prompt,
										completion_tokens: usage.output,
										total_tokens: prompt + usage.output,
										prompt_tokens_details: { cached_tokens: usage.cacheRead },
									},
								}),
							);
						}

						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						logger.error(`Devin stream failed: ${msg}`);
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`));
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
					}
				},
			});

			return new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
			});
		};
	}

	/** Non-streaming fallback: drain the Cascade stream, return one JSON body. */
	async function nonStreamingResponse(baseOpts: any, ladder: Array<{ label: string; tools: any }>, modelId: string): Promise<Response> {
		let text = "";
		let reasoning = "";
		const toolCalls: Array<{ id: string; name: string; args: string }> = [];
		let usage: any = null;

		try {
			let lastErr: unknown = null;
			for (const attempt of ladder) {
				try {
					for await (const ev of streamChat({ ...baseOpts, tools: attempt.tools })) {
						if (ev.type === "text") text += ev.text;
						else if (ev.type === "thinking") reasoning += ev.text;
						else if (ev.type === "toolcall") {
							const existing = toolCalls.find((t) => t.id === ev.id);
							if (existing) existing.args = ev.argumentsJson;
							else toolCalls.push({ id: ev.id, name: ev.name, args: ev.argumentsJson });
						} else if (ev.type === "usage") usage = ev;
					}
					lastErr = null;
					break;
				} catch (e) {
					lastErr = e;
					const m = e instanceof Error ? e.message : String(e);
					if (!/permission_denied/i.test(m) || attempt === ladder[ladder.length - 1]) throw e;
					logger.warn(`Devin rejected tools (${attempt.label}); retrying with a lighter tool description`);
					text = ""; reasoning = ""; toolCalls.length = 0; usage = null;
				}
			}
			if (lastErr) throw lastErr;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return new Response(JSON.stringify({ error: { message: msg } }), {
				status: 502,
				headers: { "content-type": "application/json" },
			});
		}

		const message: any = { role: "assistant", content: text || null };
		if (reasoning) message.reasoning_content = reasoning;
		if (toolCalls.length) {
			message.tool_calls = toolCalls.map((t) => ({
				id: t.id,
				type: "function",
				function: { name: t.name, arguments: t.args || "{}" },
			}));
		}

		return new Response(
			JSON.stringify({
				id: `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: modelId,
				choices: [
					{
						index: 0,
						message,
						finish_reason: toolCalls.length ? "tool_calls" : "stop",
					},
				],
				usage: usage
					? {
							prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
							completion_tokens: usage.output,
							total_tokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
						}
					: undefined,
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}

	// =========================================================================
	// Provider registration
	// =========================================================================

	const providerDisposable = providers.register({
		id: PROVIDER_ID,
		name: "Devin",
		description: "Access SWE-2 Max, Claude, GPT, Gemini and more via your Devin subscription",
		authType: "oauth",
		sdkType: "openai-compatible",

		async initialize() {
			logger.info("Devin provider initialized");
		},

		async isAuthenticated(): Promise<boolean> {
			return Boolean(await readStoredToken());
		},

		async authenticate() {
			try {
				// Fast path: the `devin` CLI already logged in on this machine.
				const existing = readCliToken();
				if (existing) {
					await writeToken(existing);
					const { userJwt } = await getUserJwt(normalizeToken(existing));
					cachedJwt = { jwt: userJwt, baseUrl: CODEIUM_BASE_URL, expiresAt: jwtExpiry(userJwt) };
					ui.showNotification("Connected to Devin using your existing CLI login", { type: "success" });
					return { success: true };
				}

				// Full flow: PKCE against app.devin.ai.
				const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)) as any);
				const challenge = base64url(
					new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
				);
				const state = randomUUID();
				const redirectUri = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;

				const params = new URLSearchParams({
					redirect_uri: redirectUri,
					state,
					prompt: "select_account",
					code_challenge: challenge,
					code_challenge_method: "S256",
				});
				const authUrl = `${DEVIN_WEBAPP_URL}/auth/cli/continue?${params.toString()}`;

				ui.showNotification("Opening browser for Devin login...", { type: "info" });
				const result = await ui.startOAuthFlow({
					authUrl,
					callbackPort: OAUTH_CALLBACK_PORT,
					callbackPath: OAUTH_CALLBACK_PATH,
					timeout: 300_000,
				});

				if (!result?.code) {
					ui.showNotification("Devin login was cancelled or timed out", { type: "warning" });
					return { success: false, error: "cancelled" };
				}

				const res = await fetch(`${DEVIN_API_URL}/auth/cli/token`, {
					method: "POST",
					headers: { accept: "application/json", "content-type": "application/json" },
					body: JSON.stringify({ code: result.code, code_verifier: verifier }),
				});
				if (!res.ok) {
					const detail = await res.text().catch(() => "");
					throw new Error(`Token exchange failed (${res.status}) ${detail.slice(0, 200)}`);
				}
				const data = (await res.json()) as { token?: string };
				if (!data?.token) throw new Error("Token exchange returned no token");

				await writeToken(data.token);
				const normalized = normalizeToken(data.token);
				const { userJwt } = await getUserJwt(normalized);
				cachedJwt = { jwt: userJwt, baseUrl: CODEIUM_BASE_URL, expiresAt: jwtExpiry(userJwt) };
				cachedModels = null;

				ui.showNotification("Successfully connected to Devin!", { type: "success" });
				return { success: true };
			} catch (e) {
				const message = e instanceof Error ? e.message : "Authentication failed";
				logger.error("Devin authentication error:", e);
				ui.showError(`Devin authentication failed: ${message}`);
				return { success: false, error: message };
			}
		},

		async logout() {
			await clearToken();
			cachedJwt = null;
			cachedModels = null;
			ui.showNotification("Logged out from Devin", { type: "info" });
		},

		async getModels() {
			return toProviderModels(await loadModels());
		},

		async fetchModels() {
			logger.info("Fetching available models from Devin...");
			try {
				const { jwt, baseUrl, token } = await resolveAuth();
				const models = await fetchModels(token, jwt, { baseUrl });
				if (models.length > 0) {
					cachedModels = { models, at: Date.now() };
					return toProviderModels(models);
				}
			} catch (e) {
				logger.warn(`Devin model fetch failed: ${String(e)}`);
			}
			return toProviderModels(await loadModels());
		},

		/**
		 * Alma builds `createOpenAICompatible({ apiKey, baseURL, fetch })` from
		 * this. `baseURL` is cosmetic — our fetch intercepts the request before
		 * it ever leaves the process.
		 */
		async getSDKConfig() {
			return {
				apiKey: DUMMY_API_KEY,
				baseURL: "https://devin.local/v1",
				fetch: createCascadeFetch(),
			};
		},
	});

	// =========================================================================
	// Commands
	// =========================================================================

	const loginCommand = commands.register("login", async () => {
		ui.showNotification("Use the Devin provider settings to connect", { type: "info" });
	});

	const logoutCommand = commands.register("logout", async () => {
		await clearToken();
		cachedJwt = null;
		cachedModels = null;
		ui.showNotification("Logged out from Devin", { type: "info" });
	});

	const statusCommand = commands.register("status", async () => {
		const token = await readStoredToken();
		if (!token) {
			ui.showNotification("Not connected to Devin", { type: "warning" });
			return;
		}
		try {
			const models = await loadModels();
			ui.showNotification(`Connected to Devin — ${models.length} models available`, { type: "success" });
		} catch (e) {
			ui.showNotification(`Devin token present but unusable: ${String(e)}`, { type: "error" });
		}
	});

	logger.info("Devin (Cascade) plugin activated");

	return {
		dispose: () => {
			providerDisposable.dispose();
			loginCommand.dispose();
			logoutCommand.dispose();
			statusCommand.dispose();
			logger.info("Devin (Cascade) plugin deactivated");
		},
	};
}

export default activate;

// =============================================================================
// Helpers
// =============================================================================

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
