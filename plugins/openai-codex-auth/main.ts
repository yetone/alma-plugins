/**
 * OpenAI Codex Auth Plugin for Alma
 *
 * Enables using ChatGPT Plus/Pro subscription to access OpenAI Codex models
 * via OAuth authentication. This plugin registers a custom provider that
 * handles authentication and API calls to the ChatGPT Codex backend.
 *
 * IMPORTANT: This follows the same pattern as opencode-openai-codex-auth:
 * - Plugin returns { apiKey, baseURL, fetch } configuration
 * - Custom fetch wrapper handles OAuth headers, URL rewriting, etc.
 * - AI SDK handles all request/response logic using the provided config
 *
 * DISCLAIMER: This plugin is for personal development use only with your
 * own ChatGPT subscription. Not for commercial resale or multi-user services.
 */

import type { PluginContext, PluginActivation } from 'alma-plugin-api';
import { TokenStore } from './lib/token-store';
import { getAuthorizationUrl, exchangeCodeForTokens } from './lib/auth';
import { getActiveModels, setCachedModels, isCatalogCached, buildModelsFromApiResponse, getBaseModelId, getReasoningEffort, supportsServiceTier, collapseReasoningVariants, CODEX_IMAGE_MODELS } from './lib/models';
import type { CodexModelInfo } from './lib/types';
import { getCodexInstructions } from './lib/codex-instructions';
import { addAlmaBridgeMessage } from './lib/alma-codex-bridge';
import { fetchAccountQuota } from './lib/rate-limits';
import { fetchAccountProfile, avatarUrlForEmail } from './lib/profile';

// ============================================================================
// Constants (matching opencode-openai-codex-auth)
// ============================================================================

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const DUMMY_API_KEY = 'chatgpt-oauth';

// The Codex backend gates newer models (e.g. gpt-5.6-luna) on a User-Agent
// that identifies a known Codex client — without it /codex/responses 404s
// with "Model not found" even though the model is in the /codex/models
// catalog. Verified 2026-07: default undici UA → 404, codex_cli_rs UA → 200.
const CODEX_USER_AGENT = 'codex_cli_rs/0.144.0 (Mac OS 26.0.0; arm64) Apple_Terminal/455';

// OpenAI-specific headers (matching opencode)
const OPENAI_HEADERS = {
    BETA: 'OpenAI-Beta',
    ACCOUNT_ID: 'chatgpt-account-id',
    ORIGINATOR: 'originator',
    SESSION_ID: 'session_id',
    CONVERSATION_ID: 'conversation_id',
} as const;

// URL path segments
const URL_PATHS = {
    RESPONSES: '/responses',
    CODEX_RESPONSES: '/codex/responses',
} as const;

/**
 * Aspect-ratio hints Alma sends with image requests, mapped onto sizes that
 * satisfy gpt-image-2's constraints (edges multiples of 16 and <= 3840px,
 * long:short ratio <= 3:1, total pixels within 0.65-8.3MP). gpt-image-1.5
 * only accepts the three classic sizes, so unmapped/legacy ratios fall back
 * to the backend's `auto` by omitting `size`.
 */
const IMAGE_ASPECT_SIZES: Record<string, string> = {
    '1:1': '1024x1024',
    '3:2': '1536x1024',
    '2:3': '1024x1536',
    '16:9': '2048x1152',
    '9:16': '1152x2048',
    '4:3': '1600x1200',
    '3:4': '1200x1600',
    '2:1': '2048x1024',
    '1:2': '1024x2048',
    '20:9': '2560x1152',
    '9:20': '1152x2560',
};

/** Sizes gpt-image-1.x models accept (everything else must fall back to auto). */
const LEGACY_IMAGE_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536']);

// HTTP status codes (matching opencode)
const HTTP_STATUS = {
    NOT_FOUND: 404,
    TOO_MANY_REQUESTS: 429,
} as const;

// ============================================================================
// Plugin Activation
// ============================================================================

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, storage, providers, commands, ui, settings } = context;

    logger.info('OpenAI Codex Auth plugin activating...');

    // Initialize token store
    const tokenStore = new TokenStore(storage.secrets, logger);
    await tokenStore.initialize();

    // =========================================================================
    // Custom Fetch Wrapper (matching opencode-openai-codex-auth pattern)
    // =========================================================================

    /**
     * Convert SSE stream to JSON for non-streaming requests (generateText)
     * This matches the opencode-openai-codex-auth implementation
     */
    const convertSseToJson = async (response: Response, headers: Headers): Promise<Response> => {
        if (!response.body) {
            throw new Error('Response has no body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';

        // Consume the entire stream
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
        }

        // Parse SSE events to extract the final response.
        // The ChatGPT Codex backend (observed live 2026-07-13 with gpt-5.5 and
        // gpt-5.6-*) emits `response.completed` with an EMPTY `output` array —
        // the real items only arrive via `response.output_item.done` events.
        // Collect those as a fallback so the answer isn't silently dropped.
        const lines = fullText.split('\n');
        let finalResponse: { output?: unknown[] } | null = null;
        const doneItems: unknown[] = [];

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                try {
                    const data = JSON.parse(line.substring(6));
                    if (data.type === 'response.output_item.done' && data.item) {
                        doneItems.push(data.item);
                    } else if (data.type === 'response.done' || data.type === 'response.completed') {
                        finalResponse = data.response;
                    }
                } catch {
                    // Skip malformed JSON
                }
            }
        }

        if (finalResponse && doneItems.length > 0 && (!Array.isArray(finalResponse.output) || finalResponse.output.length === 0)) {
            finalResponse.output = doneItems;
        }

        if (!finalResponse) {
            logger.error('Could not find final response in SSE stream');
            return new Response(fullText, {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        }

        // Return as plain JSON
        const jsonHeaders = new Headers(headers);
        jsonHeaders.set('content-type', 'application/json; charset=utf-8');

        return new Response(JSON.stringify(finalResponse), {
            status: response.status,
            statusText: response.statusText,
            headers: jsonHeaders,
        });
    };

    /**
     * Map 404 usage limit errors to 429 status (matching opencode)
     * This allows the caller to properly handle rate limiting
     */
    const mapUsageLimit404 = async (response: Response): Promise<Response | null> => {
        if (response.status !== HTTP_STATUS.NOT_FOUND) return null;

        const clone = response.clone();
        let text = '';
        try {
            text = await clone.text();
        } catch {
            text = '';
        }
        if (!text) return null;

        let code = '';
        try {
            const parsed = JSON.parse(text) as any;
            code = (parsed?.error?.code ?? parsed?.error?.type ?? '').toString();
        } catch {
            code = '';
        }

        const haystack = `${code} ${text}`.toLowerCase();
        if (!/usage_limit_reached|usage_not_included|rate_limit_exceeded|usage limit/i.test(haystack)) {
            return null;
        }

        // Return 429 instead of 404 for usage limit errors
        const headers = new Headers(response.headers);
        return new Response(response.body, {
            status: HTTP_STATUS.TOO_MANY_REQUESTS,
            statusText: 'Too Many Requests',
            headers,
        });
    };

    /**
     * Is this error response the account running out of quota (rather than a
     * malformed request or an outage)? Codex answers such requests with a
     * 429, or a 404 carrying usage_limit_reached — and tells when the window
     * resets (`resets_in_seconds` / `resets_at`), which we use to park the
     * account until then. A bare 429 with no usage-limit code is a per-account
     * rate limit; another account escapes it too, so it is parked briefly.
     */
    const inspectUsageLimit = async (response: Response): Promise<{ limited: boolean; resetAt: number; message: string }> => {
        const none = { limited: false, resetAt: 0, message: '' };
        if (response.status !== HTTP_STATUS.TOO_MANY_REQUESTS && response.status !== HTTP_STATUS.NOT_FOUND) return none;
        let text = '';
        try {
            text = await response.clone().text();
        } catch {
            text = '';
        }
        let err: any = null;
        try {
            err = JSON.parse(text)?.error ?? null;
        } catch {
            err = null;
        }
        const code = `${err?.code ?? ''} ${err?.type ?? ''} ${text}`.toLowerCase();
        const isUsageLimit = /usage_limit_reached|usage_not_included|rate_limit_exceeded|usage limit/i.test(code);
        if (response.status === HTTP_STATUS.NOT_FOUND && !isUsageLimit) return none;

        const now = Date.now();
        let resetAt = 0;
        if (typeof err?.resets_in_seconds === 'number' && err.resets_in_seconds > 0) {
            resetAt = now + err.resets_in_seconds * 1000;
        } else if (typeof err?.resets_at === 'number' && err.resets_at > 0) {
            resetAt = err.resets_at * (err.resets_at < 1e12 ? 1000 : 1);
        } else {
            const retryAfter = Number(response.headers.get('retry-after') || 0);
            if (retryAfter > 0) resetAt = now + retryAfter * 1000;
        }
        // Unknown reset: a quota window is hours; a plain rate limit, a minute.
        if (!resetAt) resetAt = now + (isUsageLimit ? 30 * 60 * 1000 : 60 * 1000);
        return { limited: true, resetAt, message: typeof err?.message === 'string' ? err.message : '' };
    };

    /** How an account shows up in logs and notifications. */
    const accountLabel = (accountId: string): string => {
        const record = tokenStore.getAccount(accountId);
        return record?.email || `${accountId.slice(0, 8)}…`;
    };

    /**
     * Handle orphaned tool outputs by converting them to messages (matching opencode)
     * This prevents infinite loops when function_call was an item_reference that got filtered
     */
    const normalizeOrphanedToolOutputs = (input: any[]): any[] => {
        // Collect all call IDs by type (matching opencode's collectCallIds)
        const functionCallIds = new Set<string>();
        const localShellCallIds = new Set<string>();
        const customToolCallIds = new Set<string>();

        for (const item of input) {
            const callId = typeof item.call_id === 'string' ? item.call_id.trim() : null;
            if (!callId) continue;

            switch (item.type) {
                case 'function_call':
                    functionCallIds.add(callId);
                    break;
                case 'local_shell_call':
                    localShellCallIds.add(callId);
                    break;
                case 'custom_tool_call':
                    customToolCallIds.add(callId);
                    break;
            }
        }

        // Helper to convert orphaned output to message
        const convertToMessage = (item: any, callId: string | null) => {
            const toolName = item.name || 'tool';
            const labelCallId = callId || 'unknown';
            let text: string;
            try {
                text = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
            } catch {
                text = String(item.output ?? '');
            }
            if (text.length > 16000) {
                text = text.slice(0, 16000) + '\n...[truncated]';
            }
            return {
                type: 'message',
                role: 'assistant',
                content: `[Previous ${toolName} result; call_id=${labelCallId}]: ${text}`,
            };
        };

        // Convert orphaned output items to messages
        return input.map((item) => {
            const callId = typeof item.call_id === 'string' ? item.call_id.trim() : null;

            if (item.type === 'function_call_output') {
                const hasMatch = callId && (functionCallIds.has(callId) || localShellCallIds.has(callId));
                if (!hasMatch) {
                    logger.debug(`[DEBUG] Converting orphaned function_call_output to message: call_id=${callId}`);
                    return convertToMessage(item, callId);
                }
            }

            if (item.type === 'custom_tool_call_output') {
                const hasMatch = callId && customToolCallIds.has(callId);
                if (!hasMatch) {
                    logger.debug(`[DEBUG] Converting orphaned custom_tool_call_output to message: call_id=${callId}`);
                    return convertToMessage(item, callId);
                }
            }

            if (item.type === 'local_shell_call_output') {
                const hasMatch = callId && localShellCallIds.has(callId);
                if (!hasMatch) {
                    logger.debug(`[DEBUG] Converting orphaned local_shell_call_output to message: call_id=${callId}`);
                    return convertToMessage(item, callId);
                }
            }

            return item;
        });
    };

    /**
     * Creates a custom fetch function that:
     * 1. Refreshes OAuth token if needed
     * 2. Rewrites URLs for Codex backend
     * 3. Transforms request body for Codex format
     * 4. Adds OAuth headers
     * 5. Handles response (SSE→JSON for non-streaming, passthrough for streaming)
     *
     * This matches the opencode-openai-codex-auth implementation exactly.
     */
    const createCodexFetch = (): typeof globalThis.fetch => {
        return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            // Step 1: Pick the account and get a fresh access token. The active
            // account stays active as long as it has quota; once a request hit
            // its usage limit (or the usage endpoint says so), the next request
            // moves to another connected account instead of failing the same
            // way until the user notices (Margma: with two accounts, the second
            // was never used after the first ran dry).
            let accountId = tokenStore.getAccountId();
            if (!accountId) {
                // Preserve the original error text for callers that match on it.
                await tokenStore.getValidAccessToken();
                throw new Error('Account ID not found. Please re-authenticate.');
            }
            if (tokenStore.isAccountLimited(accountId)) {
                const alternative = tokenStore.pickAvailableAccount([accountId]);
                if (alternative) {
                    logger.info(`Codex account ${accountLabel(accountId)} is out of quota; using ${accountLabel(alternative.id)} instead`);
                    await tokenStore.setActiveAccount(alternative.id);
                    accountId = alternative.id;
                }
            }
            let accessToken = await tokenStore.getValidAccessTokenFor(accountId);

            // Step 2: Extract URL string
            let url: string;
            if (typeof input === 'string') {
                url = input;
            } else if (input instanceof URL) {
                url = input.toString();
            } else {
                url = input.url;
            }

            // Step 2.5: Image generation/editing requests take a separate path.
            // Alma's generateImageViaPluginProvider POSTs Grok-style JSON
            // ({ model, prompt, response_format, images?: [{url}], aspect_ratio? })
            // to <baseURL>/images/generations|edits. The Codex subscription
            // backend serves the Images API at /backend-api/codex/images/* as
            // JSON (verified live 2026-07-04): generations take
            // { model, prompt, size? }; edits take
            // { model, prompt, images: [{ image_url: <data URL> }] }. Responses
            // already come back as { data: [{ b64_json }] } — exactly the shape
            // Alma expects — so they pass through untouched.
            const imageEndpointMatch = url.match(/\/images\/(generations|edits)$/);
            if (imageEndpointMatch) {
                const isImageEdit = imageEndpointMatch[1] === 'edits';
                const imageUrl = url.replace(/\/images\/(generations|edits)$/, '/codex/images/$1');
                let imageBody = init?.body;

                if (imageBody && typeof imageBody === 'string') {
                    try {
                        const parsed = JSON.parse(imageBody);
                        const model = getBaseModelId(parsed.model || 'gpt-image-2');
                        const transformed: Record<string, unknown> = {
                            model,
                            prompt: parsed.prompt,
                        };

                        const size = IMAGE_ASPECT_SIZES[parsed.aspect_ratio as string];
                        if (size && (model === 'gpt-image-2' || LEGACY_IMAGE_SIZES.has(size))) {
                            transformed.size = size;
                        }

                        if (isImageEdit) {
                            const refs: unknown[] = Array.isArray(parsed.images) ? parsed.images : [];
                            transformed.images = refs
                                .map((item: any) => (typeof item === 'string' ? item : item?.url ?? item?.image_url))
                                .filter((u: unknown): u is string => typeof u === 'string')
                                .map((u: string) => ({ image_url: u }));
                        }

                        imageBody = JSON.stringify(transformed);
                        logger.info(`Image ${imageEndpointMatch[1]} request: model=${model}, size=${transformed.size ?? 'auto'}${isImageEdit ? `, refs=${(transformed.images as unknown[]).length}` : ''}`);
                    } catch (e) {
                        logger.error('Error transforming image request body:', e);
                    }
                }

                const imageHeaders = new Headers(init?.headers ?? {});
                imageHeaders.delete('x-api-key');
                imageHeaders.set('Content-Type', 'application/json');
                imageHeaders.set('Authorization', `Bearer ${accessToken}`);
                imageHeaders.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
                imageHeaders.set(OPENAI_HEADERS.ORIGINATOR, 'codex_cli_rs');
                imageHeaders.set('User-Agent', CODEX_USER_AGENT);
                imageHeaders.set('accept', 'application/json');

                let imageResponse = await globalThis.fetch(imageUrl, {
                    ...init,
                    body: imageBody,
                    headers: imageHeaders,
                });

                // Same invalidated-token recovery as the chat path: on 401,
                // force-refresh once and retry.
                if (imageResponse.status === 401) {
                    const errText = await imageResponse.clone().text().catch(() => '');
                    logger.warn(`Image API 401, forcing token refresh and retrying once: ${errText.slice(0, 200)}`);
                    try {
                        const newToken = await tokenStore.forceRefreshAccessToken();
                        imageHeaders.set('Authorization', `Bearer ${newToken}`);
                        imageResponse = await globalThis.fetch(imageUrl, {
                            ...init,
                            body: imageBody,
                            headers: imageHeaders,
                        });
                    } catch (refreshErr) {
                        logger.error('Forced token refresh failed:', refreshErr);
                    }
                }

                return imageResponse;
            }

            // Step 3: Rewrite URL for Codex backend: /responses -> /codex/responses
            const codexUrl = url.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES);
            logger.debug(`Rewriting URL: ${url} -> ${codexUrl}`);

            // Step 4: Transform request body (matching opencode-openai-codex-auth exactly)
            let body = init?.body;
            let isStreaming = true; // Default to streaming
            let promptCacheKey: string | undefined; // For prompt caching headers

            if (body && typeof body === 'string') {
                try {
                    const parsed = JSON.parse(body);

                    // Track if this is a streaming request (generateText sends no stream field)
                    // streamText sends stream=true
                    isStreaming = parsed.stream === true;

                    // Extract prompt_cache_key for caching headers (matching opencode)
                    promptCacheKey = parsed.prompt_cache_key;

                    // Normalize model name (e.g., gpt-5.2-codex-low -> gpt-5.2-codex).
                    // Hydrate first so id→base/effort resolution uses the real
                    // catalog; the suffix-strip fallback in getBaseModelId still
                    // covers the (now unlikely) unhydrated case.
                    await ensureCatalogHydrated();
                    const originalModel = parsed.model || '';
                    const normalizedModel = getBaseModelId(originalModel);

                    // Reasoning-effort resolution.
                    // - An explicit reasoning variant id (e.g. gpt-5.5-high) is the
                    //   user's explicit pick and always wins.
                    // - The base model id (no suffix) honors the composer's reasoning
                    //   selector, which the core forwards on the request body as
                    //   `reasoning.effort` (from providerOptions.openai.reasoningEffort).
                    //   This lets a single base model cover every thinking level, so
                    //   users no longer need a separate enabled model per effort.
                    const suffixEffort = getReasoningEffort(originalModel);
                    const isExplicitVariant = normalizedModel !== originalModel;
                    const incomingEffort =
                        typeof parsed?.reasoning?.effort === 'string' &&
                        ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(parsed.reasoning.effort)
                            ? parsed.reasoning.effort
                            : undefined;
                    const reasoningEffort = isExplicitVariant ? suffixEffort : incomingEffort ?? suffixEffort;

                    // De-sugar 'ultra' to the actual wire effort.
                    // 'ultra' is a CLIENT-SIDE preset in the official Codex CLI, NOT a
                    // valid `reasoning.effort` wire value: the ChatGPT Codex
                    // /backend-api/codex/responses endpoint rejects it with
                    //   400 "Invalid value: 'ultra'. Supported values are: 'none',
                    //   'minimal', 'low', 'medium', 'high', and 'xhigh'."
                    // (verified live; 'max' IS accepted, hence Max works but Ultra 400s).
                    // Capturing the official CLI's outgoing request for an Ultra turn
                    // shows it sends `reasoning: { effort: "max" }` — Ultra's distinct
                    // behavior comes from the client's multi-agent orchestration
                    // (code-mode exec tool, multi_agent_version v2), not a higher wire
                    // effort. Mirror that: send 'max' on the wire when the user picks
                    // Ultra so the request is accepted instead of 400ing.
                    const wireReasoningEffort = reasoningEffort === 'ultra' ? 'max' : reasoningEffort;

                    // Filter and transform input (matching opencode's filterInput function)
                    // This is CRITICAL for Codex API compatibility:
                    // 1. Remove item_reference types (AI SDK construct not supported by Codex)
                    // 2. Strip IDs from all items (required for stateless mode with store=false)
                    // 3. Normalize orphaned tool outputs to messages (prevent infinite loops)
                    // 4. Filter Alma system prompts (replaced by Codex instructions)
                    // 5. Add Alma-Codex bridge message when tools are present
                    let filteredInput = parsed.input || parsed.messages;
                    const hasTools = !!parsed.tools && parsed.tools.length > 0;

                    // DEBUG: Log the original input to understand what AI SDK sends
                    if (Array.isArray(filteredInput)) {
                        const typeCounts: Record<string, number> = {};
                        let itemRefCount = 0;
                        for (const item of filteredInput) {
                            const t = item.type || 'unknown';
                            typeCounts[t] = (typeCounts[t] || 0) + 1;
                            if (t === 'item_reference') {
                                itemRefCount++;
                                logger.warn(`[DEBUG] item_reference found: id=${item.id}, ref_id=${item.item_id || item.reference_id || 'N/A'}`);
                            }
                        }
                        logger.info(`[DEBUG] Original input: ${filteredInput.length} items, types: ${JSON.stringify(typeCounts)}`);
                        if (itemRefCount > 0) {
                            logger.warn(`[DEBUG] Found ${itemRefCount} item_reference entries that will be filtered out!`);
                        }
                    }

                    if (Array.isArray(filteredInput)) {
                        const beforeCount = filteredInput.length;
                        filteredInput = filteredInput
                            .filter((item: any) => {
                                // Remove AI SDK constructs not supported by Codex API
                                if (item.type === 'item_reference') {
                                    logger.warn(`[DEBUG] Filtering out item_reference: ${JSON.stringify(item).slice(0, 200)}`);
                                    return false;
                                }
                                return true;
                            })
                            .map((item: any) => {
                                // Strip IDs from all items (Codex API stateless mode)
                                if (item.id) {
                                    const { id, ...itemWithoutId } = item;
                                    return itemWithoutId;
                                }
                                return item;
                            });

                        const afterCount = filteredInput.length;
                        if (beforeCount !== afterCount) {
                            logger.warn(`[DEBUG] Filtered ${beforeCount - afterCount} items (from ${beforeCount} to ${afterCount})`);
                        }

                        // Handle orphaned tool outputs (matching opencode's normalizeOrphanedToolOutputs)
                        // This converts orphaned function_call_output items to messages to preserve context
                        filteredInput = normalizeOrphanedToolOutputs(filteredInput);

                        // Add Alma-Codex bridge message when tools are present
                        // This maps Codex tool names (apply_patch, update_plan) to Alma tool names (Edit, TodoWrite)
                        // Note: We don't filter Alma system prompts - they coexist with Codex instructions
                        // This preserves Alma's context (date, platform, memories) while adding Codex behavior
                        filteredInput = addAlmaBridgeMessage(filteredInput, hasTools);

                        // DEBUG: Log final input summary
                        const finalTypeCounts: Record<string, number> = {};
                        const roleCounts: Record<string, number> = {};
                        for (const item of filteredInput) {
                            const t = item.type || 'unknown';
                            finalTypeCounts[t] = (finalTypeCounts[t] || 0) + 1;
                            if (item.role) {
                                roleCounts[item.role] = (roleCounts[item.role] || 0) + 1;
                            }
                        }
                        logger.info(`[DEBUG] Final input: ${filteredInput.length} items, types: ${JSON.stringify(finalTypeCounts)}, roles: ${JSON.stringify(roleCounts)}`);
                    }

                    // Fetch Codex instructions from GitHub (matching opencode)
                    // These are cached with ETag for 15 minutes
                    const codexInstructions = await getCodexInstructions(normalizedModel);

                    // Build reasoning config (matching official Codex CLI's build_responses_request).
                    // Use wireReasoningEffort (ultra→max de-sugared) so we never send an
                    // effort value the backend rejects.
                    const hasReasoning = wireReasoningEffort !== 'none';
                    const reasoning = hasReasoning ? {
                        effort: wireReasoningEffort,
                        summary: 'auto',
                    } : undefined;

                    // Only include reasoning.encrypted_content when reasoning is enabled
                    // (matches official Codex CLI: `if reasoning.is_some() { vec!["reasoning.encrypted_content"] } else { vec![] }`)
                    const include = hasReasoning ? ['reasoning.encrypted_content'] : [];

                    // Transform to Codex format (matching official Codex CLI's ResponsesApiRequest)
                    const transformedBody: Record<string, any> = {
                        model: normalizedModel,
                        store: false, // Required: stateless mode (ChatGPT backend REQUIRES this)
                        stream: true, // Always stream for Codex (we convert to JSON if needed)
                        input: filteredInput,
                        include,
                        tool_choice: 'auto', // Required by Codex API (official CLI always sends "auto")
                        parallel_tool_calls: parsed.parallel_tool_calls ?? true, // Preserve from AI SDK or default true
                    };

                    // Set Codex instructions (matching opencode's body.instructions = codexInstructions)
                    if (codexInstructions) {
                        transformedBody.instructions = codexInstructions;
                    }

                    // Add reasoning config if enabled
                    if (reasoning) {
                        transformedBody.reasoning = reasoning;
                    }

                    // Add text controls (verbosity) - only when model supports it
                    // Official Codex CLI checks model_info.support_verbosity before setting
                    if (parsed.text) {
                        transformedBody.text = parsed.text;
                    } else {
                        transformedBody.text = { verbosity: 'medium' };
                    }

                    // Preserve tools if present
                    if (parsed.tools) {
                        transformedBody.tools = parsed.tools;
                    }

                    // Fast mode: the priority service tier, same as Codex CLI's
                    // `/fast`. It applies to every request through this provider,
                    // so subagents get it too. Only sent when the catalog lists the
                    // tier for this model; the backend bills it at a higher rate.
                    const fastMode = settings.get<boolean>('openaiCodex.fastMode', false);
                    if (fastMode && supportsServiceTier(normalizedModel, 'priority')) {
                        transformedBody.service_tier = 'priority';
                    }

                    // Preserve prompt_cache_key from AI SDK for cache continuity
                    if (parsed.prompt_cache_key) {
                        transformedBody.prompt_cache_key = parsed.prompt_cache_key;
                    }

                    // Remove unsupported parameters (matching opencode)
                    // These are not supported by Codex API
                    delete transformedBody.max_output_tokens;
                    delete transformedBody.max_completion_tokens;

                    body = JSON.stringify(transformedBody);
                    logger.debug(
                        `Transformed request: model=${originalModel}->${normalizedModel}, reasoning=${reasoningEffort}` +
                            `${wireReasoningEffort !== reasoningEffort ? `(wire:${wireReasoningEffort})` : ''}, streaming=${isStreaming}` +
                            `${transformedBody.service_tier ? `, service_tier=${transformedBody.service_tier}` : ''}`
                    );
                } catch (e) {
                    logger.error('Error transforming request body:', e);
                }
            }

            // Step 5: Create headers with OAuth credentials (matching opencode's createCodexHeaders)
            const headers = new Headers(init?.headers ?? {});
            headers.delete('x-api-key');
            headers.set('Authorization', `Bearer ${accessToken}`);
            headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
            headers.set(OPENAI_HEADERS.BETA, 'responses=experimental');
            headers.set(OPENAI_HEADERS.ORIGINATOR, 'codex_cli_rs');
            headers.set('User-Agent', CODEX_USER_AGENT);
            headers.set('accept', 'text/event-stream');

            // Set prompt cache headers if prompt_cache_key is present (matching opencode)
            if (promptCacheKey) {
                headers.set(OPENAI_HEADERS.CONVERSATION_ID, promptCacheKey);
                headers.set(OPENAI_HEADERS.SESSION_ID, promptCacheKey);
            } else {
                headers.delete(OPENAI_HEADERS.CONVERSATION_ID);
                headers.delete(OPENAI_HEADERS.SESSION_ID);
            }

            // Step 6: Make the request
            let response = await globalThis.fetch(codexUrl, {
                ...init,
                body,
                headers,
            });

            // Step 6.5: The server can invalidate an access token before its local
            // expiry (e.g. "Your authentication token has been invalidated" after
            // the same ChatGPT account logs in elsewhere). On 401, force a token
            // refresh and retry the request once.
            if (response.status === 401) {
                const errText = await response
                    .clone()
                    .text()
                    .catch(() => '');
                logger.warn(`Codex API 401, forcing token refresh and retrying once: ${errText.slice(0, 200)}`);
                try {
                    const newToken = await tokenStore.forceRefreshAccessToken();
                    headers.set('Authorization', `Bearer ${newToken}`);
                    response = await globalThis.fetch(codexUrl, {
                        ...init,
                        body,
                        headers,
                    });
                } catch (refreshErr) {
                    logger.error('Forced token refresh failed:', refreshErr);
                }
            }

            // Step 6.6: Out of quota on this account → park it until its window
            // resets and retry the same request on the next account that still
            // has quota. Streaming or not, nothing has been consumed yet: the
            // error arrives before any body, and `body` is our own string.
            let limit = response.ok ? null : await inspectUsageLimit(response);
            if (limit?.limited) {
                const tried = new Set<string>();
                while (limit?.limited) {
                    await tokenStore.markAccountLimited(accountId, limit.resetAt);
                    void refreshQuotaForAccount(accountId);
                    tried.add(accountId);
                    const next = tokenStore.pickAvailableAccount(tried);
                    if (!next) break;
                    logger.warn(
                        `Codex account ${accountLabel(accountId)} hit its usage limit (${limit.message || response.status}); switching to ${accountLabel(next.id)}`
                    );
                    ui.showNotification(`ChatGPT account ${accountLabel(accountId)} is out of quota — switched to ${accountLabel(next.id)}`, {
                        type: 'info',
                    });
                    await tokenStore.setActiveAccount(next.id);
                    accountId = next.id;
                    accessToken = await tokenStore.getValidAccessTokenFor(accountId);
                    headers.set('Authorization', `Bearer ${accessToken}`);
                    headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
                    response = await globalThis.fetch(codexUrl, { ...init, body, headers });
                    limit = response.ok ? null : await inspectUsageLimit(response);
                }
            }
            if (response.ok) {
                void tokenStore.clearAccountLimited(accountId);
            }

            // Step 7: Handle error response (matching opencode's handleErrorResponse)
            if (!response.ok) {
                // Map 404 usage limit errors to 429 for proper rate limit handling
                const mappedResponse = await mapUsageLimit404(response);
                if (mappedResponse || limit?.limited) {
                    const accounts = tokenStore.listAccounts();
                    logger.warn(`Usage limit reached on ${accounts.length} account(s), returning 429 status`);
                    // With several accounts all dry, say so — "no quota" alone
                    // reads as the other accounts never being tried.
                    if (accounts.length > 1) {
                        const reset = tokenStore.earliestLimitReset();
                        const when = reset ? ` Earliest reset: ${new Date(reset).toLocaleString()}.` : '';
                        const base = mappedResponse ?? response;
                        let payload: any = null;
                        try {
                            payload = JSON.parse(await base.clone().text());
                        } catch {
                            payload = null;
                        }
                        if (payload && typeof payload === 'object') {
                            payload.error = {
                                ...(payload.error ?? {}),
                                message: `All ${accounts.length} connected ChatGPT accounts have reached their usage limit.${when}`,
                            };
                            const h = new Headers(base.headers);
                            h.set('content-type', 'application/json; charset=utf-8');
                            return new Response(JSON.stringify(payload), { status: HTTP_STATUS.TOO_MANY_REQUESTS, statusText: 'Too Many Requests', headers: h });
                        }
                    }
                    return mappedResponse ?? response;
                }

                // For other errors, log and return the error response
                const errorText = await response.clone().text();
                logger.error(`Codex API error: ${response.status} ${response.statusText}`, errorText);

                // Return the error response instead of throwing
                // This allows the caller to handle errors properly
                return response;
            }

            // Step 8: Handle success response
            // For non-streaming requests (generateText), convert SSE to JSON
            // For streaming requests (streamText), return stream as-is
            const responseHeaders = new Headers(response.headers);
            if (!responseHeaders.has('content-type')) {
                responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
            }

            if (!isStreaming) {
                return await convertSseToJson(response, responseHeaders);
            }

            // Return streaming response as-is
            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders,
            });
        };
    };

    // =========================================================================
    // Register Provider
    // =========================================================================

    // =========================================================================
    // Helpers for multi-account UI exposure
    // =========================================================================

    /** Best-effort quota refresh for one account — never throws. */
    const refreshQuotaForAccount = async (accountId: string): Promise<void> => {
        try {
            const accessToken = await tokenStore.getValidAccessTokenFor(accountId);
            const quota = await fetchAccountQuota(accessToken, accountId, logger);
            await tokenStore.setAccountQuota(accountId, quota);
        } catch (error) {
            logger.warn(`[codex quota] refresh failed for ${accountId}:`, error);
        }
    };

    /** Best-effort profile fetch (avatar + name) — never throws. */
    const refreshProfileForAccount = async (accountId: string): Promise<void> => {
        try {
            const accessToken = await tokenStore.getValidAccessTokenFor(accountId);
            const record = tokenStore.getAccount(accountId);

            // Remote profile endpoint — reserved; currently returns null for
            // CLI tokens (ChatGPT's /me is Cloudflare-gated).
            const profile = await fetchAccountProfile(accessToken, accountId, logger);
            if (profile) await tokenStore.setAccountProfile(accountId, profile);

            // Gravatar fallback from email. We skip it when the record already
            // has a picture (e.g. from a future real endpoint) to avoid
            // clobbering the better value.
            if (record && !record.picture && record.email) {
                const gravatar = await avatarUrlForEmail(record.email);
                if (gravatar) await tokenStore.setAccountProfile(accountId, { picture: gravatar });
            }
        } catch (error) {
            logger.warn(`[codex profile] refresh failed for ${accountId}:`, error);
        }
    };

    /**
     * Image models exposed alongside the chat models. imageOutput routes them
     * through Alma's handleImageGenerationRequest (Images API) instead of chat
     * completions; vision lets users attach reference images for edits.
     */
    const imageModelEntries = () =>
        CODEX_IMAGE_MODELS.map(model => ({
            id: model.id,
            name: model.name,
            description: model.description,
            capabilities: {
                streaming: false,
                reasoning: false,
                functionCalling: false,
                vision: true,
                imageOutput: true,
            },
            providerOptions: {
                baseModel: model.baseModel,
            },
        }));

    // =========================================================================
    // Model catalog persistence
    //
    // The bundled CODEX_MODELS list is a snapshot that lags the live backend.
    // The freshly fetched catalog used to live only in an in-memory module
    // cache (setCachedModels), so every cold start fell back to the stale
    // snapshot — any enabled model newer than the snapshot (e.g. gpt-5.5) had
    // no catalog entry, and GET /api/models reported all-false capabilities
    // until the user manually clicked "Fetch". Persisting the catalog and
    // restoring it on startup (plus a background refresh) makes capabilities
    // load automatically on every launch.
    // =========================================================================

    const MODELS_CACHE_KEY = 'codex-models-cache-v1';

    // Memoized hydration guard. initialize() awaits hydration, but the plugin
    // host does not reliably await initialize() before the first getModels()
    // call (observed after a hot-reload: getModels() served the stale snapshot
    // until a manual Fetch, which in turn made the core read functionCalling as
    // false and drop the Project/Tools/Skills buttons). So every catalog reader
    // self-hydrates through this guard: the storage read happens at most once,
    // and callers past that point always see the persisted catalog.
    let hydrationPromise: Promise<void> | null = null;

    /**
     * Ensure the in-memory catalog is populated from persisted storage before a
     * caller trusts getActiveModels(). Idempotent and concurrency-safe: the
     * storage read is shared across all callers and skipped once the cache holds
     * a live/persisted catalog (either from a prior hydrate or a live fetch).
     */
    const ensureCatalogHydrated = (): Promise<void> => {
        if (isCatalogCached()) return Promise.resolve();
        if (!hydrationPromise) {
            hydrationPromise = (async () => {
                try {
                    const persisted = await storage.local.get<CodexModelInfo[]>(MODELS_CACHE_KEY);
                    // Re-check isCatalogCached(): a live fetch may have landed
                    // while the storage read was in flight — never clobber fresher
                    // data with the persisted snapshot.
                    if (Array.isArray(persisted) && persisted.length > 0 && !isCatalogCached()) {
                        setCachedModels(persisted);
                        logger.info(`Hydrated ${persisted.length} Codex models from storage`);
                    }
                } catch (err) {
                    logger.warn('Failed to hydrate Codex catalog from storage:', err);
                }
            })();
        }
        return hydrationPromise;
    };

    /** Persist the fetched catalog so it survives restarts. Non-blocking. */
    const persistModelCatalog = (models: CodexModelInfo[]): void => {
        void storage.local.set(MODELS_CACHE_KEY, models).catch(err =>
            logger.warn('Failed to persist Codex model catalog:', err),
        );
    };

    /**
     * Fetch the live catalog from the Codex API, update the in-memory cache and
     * persist it. Returns the models on success, or null when unavailable (no
     * account / network error / empty response) so callers can fall back to the
     * cached-or-bundled catalog.
     */
    const refreshModelCatalog = async (): Promise<CodexModelInfo[] | null> => {
        const accountId = tokenStore.getAccountId();
        if (!accountId) return null;
        try {
            const accessToken = await tokenStore.getValidAccessToken();
            const response = await globalThis.fetch(
                `${CODEX_BASE_URL}/codex/models?client_version=1.0.0`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        [OPENAI_HEADERS.ACCOUNT_ID]: accountId,
                        [OPENAI_HEADERS.ORIGINATOR]: 'codex_cli_rs',
                        [OPENAI_HEADERS.BETA]: 'responses=experimental',
                        'User-Agent': CODEX_USER_AGENT,
                    },
                },
            );

            if (!response.ok) {
                logger.warn(`Failed to fetch models: ${response.status}`);
                return null;
            }

            const data = await response.json();
            const models = buildModelsFromApiResponse(data);
            if (models.length === 0) {
                logger.warn('No models found in API response');
                return null;
            }

            setCachedModels(models);
            persistModelCatalog(models);
            logger.info(`Fetched and cached ${models.length} models from Codex API`);
            return models;
        } catch (error) {
            logger.error('Error fetching models:', error);
            return null;
        }
    };

    /**
     * Map a model's backend reasoning levels to the composer's thinking-selector
     * vocabulary. 'off' is always available (handled separately), so only
     * low..ultra are listed; 'minimal' (which Alma lacks) maps to the nearest
     * 'low'. Returns undefined when unknown, so the composer falls back to its
     * default level set. Order is canonical low→ultra.
     */
    const COMPOSER_LEVEL_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const toComposerReasoningLevels = (levels?: CodexModelInfo['supportedReasoningLevels']): string[] | undefined => {
        if (!levels || levels.length === 0) return undefined;
        const mapped = new Set(levels.map(l => (l === 'minimal' ? 'low' : l)));
        const ordered = COMPOSER_LEVEL_ORDER.filter(l => mapped.has(l as CodexModelInfo['reasoning']));
        return ordered.length ? ordered : undefined;
    };

    /**
     * Map the internal catalog to the provider's ProviderModelInfo shape.
     * Reasoning variants (gpt-5.5-high/-low/-xhigh, …) are collapsed into their
     * base model — the composer's model-aware thinking selector drives the effort
     * now (including max/ultra) — so the picker shows a single entry per model.
     */
    const toProviderModels = (models: CodexModelInfo[]) => [
        ...collapseReasoningVariants(models).map(model => ({
            id: model.id,
            name: model.name,
            description: model.description,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens,
            capabilities: {
                streaming: true,
                reasoning: model.reasoning !== 'none',
                functionCalling: true,
                // Per-model supported thinking levels (Alma vocab: 'off' is always
                // available and handled separately, so only low..ultra are listed).
                // Lets the composer render a model-aware thinking selector.
                reasoningLevels: toComposerReasoningLevels(model.supportedReasoningLevels),
            },
            providerOptions: {
                reasoning: model.reasoning,
                baseModel: model.baseModel,
            },
        })),
        // The /codex/models catalog only lists chat models; image models live on
        // the Images API and are appended manually.
        ...imageModelEntries(),
    ];

    const providerDisposable = providers.register({
        id: 'openai-codex',
        name: 'OpenAI Codex (ChatGPT)',
        description: 'Access GPT-5.3 Codex and other models via your ChatGPT subscription',
        authType: 'oauth',
        supportsMultiAccount: true,

        async initialize() {
            logger.info('Codex provider initialized');

            // Restore the last-fetched catalog before any getModels() call so
            // cold starts serve real capabilities for models newer than the
            // bundled snapshot (e.g. gpt-5.5) instead of all-false defaults.
            // getModels() also self-hydrates via the same guard, so this is a
            // best-effort warm-up rather than the sole load path.
            await ensureCatalogHydrated();

            // Refresh the catalog in the background so capabilities load
            // automatically on startup — no manual "Fetch" needed — and brand
            // new backend models are picked up. Non-blocking.
            void refreshModelCatalog();

            // Warm quota + profile caches in the background so the settings
            // page shows fresh data the first time it renders. Non-blocking.
            void (async () => {
                for (const record of tokenStore.listAccounts()) {
                    await Promise.all([
                        refreshQuotaForAccount(record.id),
                        refreshProfileForAccount(record.id),
                    ]);
                }
            })();
        },

        async isAuthenticated() {
            return tokenStore.hasValidToken();
        },

        async authenticate() {
            try {
                // Generate authorization URL
                const { url, verifier } = await getAuthorizationUrl();

                // Store verifier for code exchange
                await tokenStore.storePendingVerifier(verifier);

                // Show notification
                ui.showNotification('Opening browser for ChatGPT login...', { type: 'info' });

                // Start OAuth flow with local callback server
                logger.info('Starting OAuth flow...');
                const result = await ui.startOAuthFlow({
                    authUrl: url,
                    callbackPort: 1455,
                    callbackPath: '/auth/callback',
                    timeout: 300000, // 5 minutes
                });

                if (!result || !result.code) {
                    await tokenStore.clearPendingState();
                    return { success: false, error: 'Authorization cancelled or timed out' };
                }

                // Exchange code for tokens
                const pendingVerifier = await tokenStore.getPendingVerifier();
                if (!pendingVerifier) {
                    return { success: false, error: 'No pending authorization. Please try again.' };
                }

                const tokens = await exchangeCodeForTokens(result.code, pendingVerifier);
                const record = await tokenStore.saveTokens(tokens);
                await tokenStore.clearPendingState();

                // Fetch quota + profile in the background; failure must not
                // block login.
                void refreshQuotaForAccount(record.id);
                void refreshProfileForAccount(record.id);

                const label = record.email ? ` (${record.email})` : '';
                ui.showNotification(`Successfully connected to ChatGPT${label}!`, { type: 'success' });
                logger.info(`Codex authentication successful for ${record.id}`);

                return { success: true };
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Authentication failed';
                logger.error('Codex authentication error:', error);
                ui.showError(`Authentication failed: ${message}`);
                return { success: false, error: message };
            }
        },

        async logout() {
            await tokenStore.clearTokens();
            ui.showNotification('Logged out from ChatGPT', { type: 'info' });
            logger.info('Codex logout successful');
        },

        // =====================================================================
        // Multi-account: accounts listing, removal, quota refresh
        // =====================================================================

        async getAccounts() {
            return tokenStore.listAccounts().map(record => ({
                id: record.id,
                email: record.email,
                label: record.plan ? `ChatGPT ${record.plan}` : undefined,
                avatarUrl: record.picture,
                isRateLimited: tokenStore.isAccountLimited(record.id),
                rateLimitResetAt: record.limitedUntil && record.limitedUntil > Date.now() ? record.limitedUntil : undefined,
                quota: record.quota
                    ? {
                          models: record.quota.models,
                          lastUpdated: record.quota.lastUpdated,
                      }
                    : undefined,
            }));
        },

        async removeAccount(accountId: string) {
            await tokenStore.removeAccount(accountId);
            ui.showNotification('Account removed', { type: 'info' });
        },

        async refreshQuotas() {
            const accounts = tokenStore.listAccounts();
            await Promise.all(
                accounts.flatMap(a => [
                    refreshQuotaForAccount(a.id),
                    refreshProfileForAccount(a.id),
                ])
            );
        },

        async getModels() {
            // Self-hydrate so the very first call after a cold start / reload
            // returns the persisted catalog (real capabilities) instead of the
            // stale bundled snapshot — independent of initialize() ordering.
            await ensureCatalogHydrated();
            return toProviderModels(getActiveModels());
        },

        async fetchModels() {
            logger.info('Fetching available models from Codex API...');
            // refreshModelCatalog updates + persists the cache; on any failure
            // it returns null and we fall back to the cached-or-bundled catalog
            // (hydrated from storage rather than the raw snapshot).
            const models = await refreshModelCatalog();
            if (!models) await ensureCatalogHydrated();
            return toProviderModels(models ?? getActiveModels());
        },

        /**
         * Returns SDK configuration for AI SDK's createOpenAI().
         * This follows the opencode-openai-codex-auth pattern:
         * - apiKey: Dummy key (actual auth via OAuth)
         * - baseURL: ChatGPT backend URL
         * - fetch: Custom fetch that handles OAuth headers, URL rewriting, etc.
         */
        async getSDKConfig() {
            return {
                apiKey: DUMMY_API_KEY,
                baseURL: CODEX_BASE_URL,
                fetch: createCodexFetch(),
                useResponsesAPI: true,
            };
        },
    });

    // =========================================================================
    // Register Commands
    // =========================================================================

    const loginCommand = commands.register('login', async () => {
        ui.showNotification('Use the provider settings to connect to ChatGPT', { type: 'info' });
    });

    const logoutCommand = commands.register('logout', async () => {
        await tokenStore.clearTokens();
        ui.showNotification('Logged out from ChatGPT', { type: 'info' });
    });

    const statusCommand = commands.register('status', async () => {
        const isAuth = tokenStore.hasValidToken();
        const accountId = tokenStore.getAccountId();

        if (isAuth) {
            ui.showNotification(`Connected to ChatGPT (Account: ${accountId?.slice(0, 8)}...)`, { type: 'success' });
        } else {
            ui.showNotification('Not connected to ChatGPT', { type: 'warning' });
        }
    });

    logger.info('OpenAI Codex Auth plugin activated');

    // =========================================================================
    // Cleanup
    // =========================================================================

    return {
        dispose: () => {
            providerDisposable.dispose();
            loginCommand.dispose();
            logoutCommand.dispose();
            statusCommand.dispose();
            logger.info('OpenAI Codex Auth plugin deactivated');
        },
    };
}
