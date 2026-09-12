/**
 * Codeium / Windsurf Cascade client.
 *
 * Devin's backend is not OpenAI-compatible and not REST. It speaks Google's
 * **Connect** protocol over HTTP/1.1 with protobuf payloads, against
 * `server.codeium.com`:
 *
 *   POST /exa.auth_pb.AuthService/GetUserJwt                         → user JWT
 *   POST /exa.api_server_pb.ApiServerService/GetCliModelConfigs      → model catalog
 *   POST /exa.api_server_pb.ApiServerService/GetChatMessage          → streaming chat
 *
 * The first two are unary (`application/proto`, bare protobuf). GetChatMessage
 * is server-streaming (`application/connect+proto`, gzip'd Connect frames).
 *
 * Protocol shape reverse-engineered from the tooling OMP ships
 * (`@oh-my-pi/pi-ai/src/providers/devin.ts`) and verified end-to-end against a
 * live Devin Teams account.
 */

import { gunzipSync, gzipSync } from "node:zlib";
import { Writer, read, s, n, sub, subList, type Fields } from "./proto";

export const CODEIUM_BASE_URL = "https://server.codeium.com";
const AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";

/** Version strings the Codeium gateway expects to see. */
export const IDE_NAME = "windsurf";
export const IDE_VERSION = "3.2.23";
export const EXTENSION_NAME = "windsurf";
export const EXTENSION_VERSION = "1.48.2";

/** Access tokens are opaque strings with this literal prefix. */
const SESSION_TOKEN_PREFIX = "devin-session-token$";

/** Connect frame flag bits. */
const FLAG_GZIP = 0x01;
const FLAG_END_STREAM = 0x02;

/** Guard against a corrupt length prefix ballooning memory. */
const MAX_FRAME_PAYLOAD = 16 * 1024 * 1024;

/** ChatMessageRequestType.CASCADE */
const REQUEST_TYPE_CASCADE = 5;
/** ConversationalPlannerMode.DEFAULT */
const PLANNER_MODE_DEFAULT = 1;
/** CacheControlType.EPHEMERAL */
const CACHE_EPHEMERAL = 1;

/** ChatMessageSource */
export const SOURCE_USER = 1;
export const SOURCE_SYSTEM = 2;
export const SOURCE_TOOL = 4;

/** StopReason values we care about. */
export const STOP_FUNCTION_CALL = 10;
export const STOP_MAX_TOKENS = 3;

const DEFAULT_STOP_PATTERNS = [
	"<|user|>",
	"<|bot|>",
	"<|context_request|>",
	"<|endoftext|>",
	"<|end_of_turn|>",
];

export function normalizeToken(token: string): string {
	const t = token.trim();
	if (!t) return "";
	return t.startsWith(SESSION_TOKEN_PREFIX) ? t : `${SESSION_TOKEN_PREFIX}${t}`;
}

function metadata(apiKey: string, userJwt?: string): Writer {
	const m = new Writer();
	m.str(1, IDE_NAME);
	m.str(7, IDE_VERSION);
	m.str(12, EXTENSION_NAME);
	m.str(2, EXTENSION_VERSION);
	m.str(3, apiKey);
	m.str(4, "en");
	if (userJwt) m.str(21, userJwt);
	return m;
}

export class CascadeError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name = "CascadeError";
		this.status = status;
	}
}

/**
 * Exchange a Devin session token for the short-lived user JWT that must ride
 * along on every Cascade call. Also yields a server override URL when the
 * account is pinned to a dedicated API server.
 */
export async function getUserJwt(
	apiKey: string,
	opts: { baseUrl?: string; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ userJwt: string; baseUrl: string }> {
	const doFetch = opts.fetch ?? fetch;
	const base = (opts.baseUrl ?? CODEIUM_BASE_URL).replace(/\/+$/, "");
	const body = new Writer().msg(1, metadata(apiKey)).done();

	const res = await doFetch(`${base}${AUTH_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "*/*",
		},
		body,
		signal: opts.signal,
	});

	const raw = Buffer.from(await res.arrayBuffer());
	if (!res.ok) {
		throw new CascadeError(
			`Devin auth failed (${res.status}): ${raw.toString("utf8").slice(0, 300)}`,
			res.status,
		);
	}

	let fields: Fields;
	try {
		fields = read(raw);
	} catch {
		fields = read(gunzipSync(raw));
	}
	const userJwt = s(fields, 1);
	if (!userJwt) throw new CascadeError("Devin auth returned an empty user JWT");
	const override = s(fields, 2).trim();
	return { userJwt, baseUrl: override ? override.replace(/\/+$/, "") : base };
}

export interface DevinModel {
	id: string;
	label: string;
	supportsImages: boolean;
	supportsTools: boolean;
	contextWindow: number;
	maxTokens: number;
}

/**
 * Fetch the account's available model catalog.
 *
 * `modelUid` (what you pass as `chatModelUid`) lives in field 22; the human
 * label in field 1. Context window is field 18.
 */
export async function fetchModels(
	apiKey: string,
	userJwt: string,
	opts: { baseUrl?: string; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<DevinModel[]> {
	const doFetch = opts.fetch ?? fetch;
	const base = (opts.baseUrl ?? CODEIUM_BASE_URL).replace(/\/+$/, "");
	const body = new Writer().msg(1, metadata(apiKey, userJwt)).done();

	const res = await doFetch(`${base}${MODEL_CONFIGS_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "*/*",
		},
		body,
		signal: opts.signal,
	});

	const raw = Buffer.from(await res.arrayBuffer());
	if (!res.ok) {
		throw new CascadeError(`Devin model list failed (${res.status})`, res.status);
	}

	let fields: Fields;
	try {
		fields = read(raw);
	} catch {
		fields = read(gunzipSync(raw));
	}

	const out: DevinModel[] = [];
	const seen = new Set<string>();
	for (const cfg of subList(fields, 1)) {
		if (n(cfg, 4) === 1) continue; // disabled
		const id = s(cfg, 22).trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const info = sub(cfg, 23);
		const features = sub(info, 6);
		const ctx = n(cfg, 18);
		out.push({
			id,
			label: s(cfg, 1).trim() || id,
			supportsImages: n(cfg, 5) === 1 || n(features, 11) === 1,
			supportsTools: n(features, 12) === 1,
			contextWindow: ctx > 0 ? ctx : 200_000,
			maxTokens: 64_000,
		});
	}
	out.sort((a, b) => a.id.localeCompare(b.id));
	return out;
}

/** One message in the Cascade conversation history. */
export interface CascadePrompt {
	messageId: string;
	source: number;
	prompt: string;
	toolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
	toolCallId?: string;
	toolResultIsError?: boolean;
	images?: Array<{ base64Data: string; mimeType: string }>;
	thinking?: string;
	signature?: string;
}

export interface CascadeTool {
	name: string;
	description: string;
	/** JSON Schema for the tool arguments, stringified. */
	jsonSchema: string;
	strict?: boolean;
}

export interface StreamChatOptions {
	apiKey: string;
	userJwt: string;
	baseUrl?: string;
	modelUid: string;
	/** Reuse across turns so the server threads the conversation. */
	cascadeId: string;
	/** System prompt, flattened to a single string. */
	systemPrompt?: string;
	prompts: CascadePrompt[];
	tools?: CascadeTool[];
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	stopSequences?: string[];
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

/** Decoded Cascade stream event. */
export type CascadeEvent =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| {
			type: "toolcall";
			id: string;
			name: string;
			argumentsJson: string;
	  }
	| { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number }
	| { type: "stop"; reason: number };

function buildChatRequest(opts: StreamChatOptions): Buffer {
	const cfg = new Writer();
	cfg.int(1, 1); // numCompletions
	cfg.int(2, opts.maxTokens ?? 64_000);
	cfg.int(3, 200); // maxNewlines
	cfg.dbl(5, opts.temperature ?? 0.4);
	cfg.dbl(6, opts.temperature ?? 0.4);
	cfg.int(7, 50); // topK
	cfg.dbl(8, opts.topP ?? 1);
	for (const p of [...DEFAULT_STOP_PATTERNS, ...(opts.stopSequences ?? [])]) cfg.str(9, p);

	const req = new Writer();
	req.msg(1, metadata(opts.apiKey, opts.userJwt));
	req.str(2, opts.systemPrompt ?? "");

	for (const p of opts.prompts) {
		const w = new Writer();
		w.str(1, p.messageId);
		w.int(2, p.source);
		w.str(3, p.prompt);
		for (const tc of p.toolCalls ?? []) {
			const t = new Writer();
			t.str(1, tc.id);
			t.str(2, tc.name);
			t.str(3, tc.argumentsJson);
			w.msg(6, t);
		}
		w.str(7, p.toolCallId);
		w.bool(9, p.toolResultIsError);
		for (const img of p.images ?? []) {
			const i = new Writer();
			i.str(1, img.base64Data);
			i.str(2, img.mimeType);
			w.msg(10, i);
		}
		w.str(11, p.thinking);
		w.str(12, p.signature);
		req.msg(3, w);
	}

	req.str(21, opts.modelUid);
	req.int(7, REQUEST_TYPE_CASCADE);
	req.msg(8, cfg);

	for (const t of opts.tools ?? []) {
		const tw = new Writer();
		tw.str(1, t.name);
		tw.str(2, t.description);
		tw.str(3, t.jsonSchema);
		tw.bool(12, t.strict);
		req.msg(10, tw);
	}

	req.bool(11, true); // disableParallelToolCalls
	const cache = new Writer();
	cache.int(1, CACHE_EPHEMERAL);
	req.msg(13, cache);
	req.str(16, opts.cascadeId);
	req.int(20, PLANNER_MODE_DEFAULT);
	req.str(22, crypto.randomUUID());
	return req.done();
}

/** Frame a protobuf body as a single gzip'd Connect message. */
function connectFrame(body: Buffer): Buffer {
	const gz = gzipSync(body);
	const frame = Buffer.alloc(5 + gz.length);
	frame[0] = FLAG_GZIP;
	frame.writeUInt32BE(gz.length, 1);
	gz.copy(frame, 5);
	return frame;
}

interface TrailerError {
	code: string;
	message: string;
}

function parseTrailer(text: string): TrailerError | null {
	if (!text) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return null;
	const err = (parsed as { error: unknown }).error;
	if (!err || typeof err !== "object") return null;
	const e = err as Record<string, unknown>;
	const code = typeof e.code === "string" ? e.code : "";
	const message = typeof e.message === "string" ? e.message : "";
	if (!code && !message) return null;
	return { code, message };
}

/**
 * Run one Cascade turn, yielding decoded events as they stream in.
 *
 * History is NOT remembered server-side by message content — you resend the
 * full `prompts` array each turn and the server uses `cascadeId` to thread
 * things (and to hit its prompt cache). Reusing a `cascadeId` across turns is
 * what makes follow-ups fast.
 */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<CascadeEvent> {
	const doFetch = opts.fetch ?? fetch;
	const base = (opts.baseUrl ?? CODEIUM_BASE_URL).replace(/\/+$/, "");
	const frame = connectFrame(buildChatRequest(opts));

	const res = await doFetch(`${base}${CHAT_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/connect+proto",
			"connect-protocol-version": "1",
			"connect-content-encoding": "gzip",
			"accept-encoding": "identity",
			"connect-accept-encoding": "gzip",
			"user-agent": "connect-go/1.18.1 (go1.26.3)",
		},
		body: frame,
		signal: opts.signal,
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new CascadeError(`Devin chat failed (${res.status}): ${text.slice(0, 400)}`, res.status);
	}
	if (!res.body) throw new CascadeError("Devin chat returned an empty body");

	const reader = res.body.getReader();
	let pending = Buffer.alloc(0);
	let trailer: TrailerError | null = null;
	/**
	 * Cascade streams one logical tool call across several deltas: only the first
	 * carries `id` and `name`, later ones just extend `argumentsJson`. Without
	 * carrying the id forward we would mint a fresh call per delta (fifteen
	 * phantom tool calls for one Bash invocation), so remember the in-flight id.
	 */
	let activeToolCallId = "";

	for (;;) {
		const { done, value } = await reader.read();
		if (value && value.length > 0) {
			pending =
				pending.length === 0
					? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
					: Buffer.concat([pending, Buffer.from(value.buffer, value.byteOffset, value.byteLength)]);
		}

		while (pending.length >= 5) {
			const flag = pending[0]!;
			const len = pending.readUInt32BE(1);
			if (len > MAX_FRAME_PAYLOAD) {
				throw new CascadeError(`Devin Connect frame length ${len} exceeds cap`);
			}
			if (pending.length < 5 + len) break;

			const payload = pending.subarray(5, 5 + len);
			pending = pending.subarray(5 + len);

			if (flag & FLAG_END_STREAM) {
				const bytes = flag & FLAG_GZIP ? gunzipSync(payload) : payload;
				trailer = parseTrailer(bytes.toString("utf8").trim());
				continue;
			}

			const raw = flag & FLAG_GZIP ? gunzipSync(payload) : payload;
			const msg = read(raw);

			const deltaText = s(msg, 3);
			const deltaThinking = s(msg, 9);
			if (deltaThinking) yield { type: "thinking", text: deltaThinking };
			if (deltaText) yield { type: "text", text: deltaText };

			for (const tc of subList(msg, 6)) {
				const toolCallId = s(tc, 1) || activeToolCallId;
				if (!toolCallId) continue;
				activeToolCallId = toolCallId;
				yield {
					type: "toolcall",
					id: toolCallId,
					// Empty on continuation deltas — the consumer keeps the name it
					// already announced rather than overwriting it with "".
					name: s(tc, 2),
					argumentsJson: s(tc, 3),
				};
			}

			const usageRaw = msg[7]?.[0];
			if (usageRaw && Buffer.isBuffer(usageRaw)) {
				const u = read(usageRaw);
				yield {
					type: "usage",
					input: n(u, 2),
					output: n(u, 3),
					cacheWrite: n(u, 4),
					cacheRead: n(u, 5),
				};
			}

			const stop = n(msg, 5);
			if (stop) yield { type: "stop", reason: stop };
		}

		if (done) break;
	}

	if (trailer) {
		throw new CascadeError(`Devin stream error ${trailer.code}: ${trailer.message}`.trim());
	}
}
