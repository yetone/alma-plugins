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
import { getActiveModels, setCachedModels, buildModelsFromApiResponse, getBaseModelId, getReasoningEffort } from './lib/models';
import { getCodexInstructions } from './lib/codex-instructions';
import { addAlmaBridgeMessage } from './lib/alma-codex-bridge';
import { fetchAccountQuota } from './lib/rate-limits';
import { fetchAccountProfile, avatarUrlForEmail } from './lib/profile';

// ============================================================================
// Constants (matching opencode-openai-codex-auth)
// ============================================================================

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const DUMMY_API_KEY = 'chatgpt-oauth';

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

// HTTP status codes (matching opencode)
const HTTP_STATUS = {
    NOT_FOUND: 404,
    TOO_MANY_REQUESTS: 429,
    UNAUTHORIZED: 401,
} as const;

const FALLBACK_CODEX_INSTRUCTIONS = [
    'You are ChatGPT, running as a coding agent in Alma.',
    'Be concise, follow the user request, and use available tools when needed.',
].join('\n');

// ============================================================================
// Plugin Activation
// ============================================================================

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, storage, providers, commands, ui } = context;

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

        // Parse SSE events to extract the final response and rebuild output
        // because the final response.completed payload can carry output: [].
        const lines = fullText.split('\n');
        let finalResponse: any = null;
        const outputByIndex = new Map<number, any>();

        const ensureMessageItem = (outputIndex: number, itemId?: string) => {
            let item = outputByIndex.get(outputIndex);
            if (!item) {
                item = {
                    id: itemId,
                    type: 'message',
                    status: 'completed',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: '' }],
                };
                outputByIndex.set(outputIndex, item);
            }
            if (!Array.isArray(item.content)) item.content = [{ type: 'output_text', text: '' }];
            if (!item.content[0]) item.content[0] = { type: 'output_text', text: '' };
            return item;
        };

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                try {
                    const data = JSON.parse(line.substring(6));
                    if (typeof data.output_index === 'number') {
                        if (data.type === 'response.output_item.added' && data.item) {
                            outputByIndex.set(data.output_index, data.item);
                        }
                        if (data.type === 'response.output_item.done' && data.item) {
                            outputByIndex.set(data.output_index, data.item);
                        }
                        if (data.type === 'response.output_text.delta') {
                            const item = ensureMessageItem(data.output_index, data.item_id);
                            const contentIndex = data.content_index ?? 0;
                            if (!item.content[contentIndex]) item.content[contentIndex] = { type: 'output_text', text: '' };
                            item.content[contentIndex].text = `${item.content[contentIndex].text ?? ''}${data.delta ?? ''}`;
                        }
                        if (data.type === 'response.output_text.done') {
                            const item = ensureMessageItem(data.output_index, data.item_id);
                            const contentIndex = data.content_index ?? 0;
                            item.content[contentIndex] = {
                                type: 'output_text',
                                annotations: data.annotations ?? [],
                                logprobs: data.logprobs ?? [],
                                text: data.text ?? item.content[contentIndex]?.text ?? '',
                            };
                        }
                        if (data.type === 'response.content_part.done' && data.part?.type === 'output_text') {
                            const item = ensureMessageItem(data.output_index, data.item_id);
                            const contentIndex = data.content_index ?? 0;
                            item.content[contentIndex] = data.part;
                        }
                    }
                    if (data.type === 'response.done' || data.type === 'response.completed') {
                        finalResponse = data.response;
                    }
                } catch {
                    // Skip malformed JSON
                }
            }
        }

        if (!finalResponse) {
            logger.error('Could not find final response in SSE stream');
            return new Response(fullText, {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        }

        if ((!Array.isArray(finalResponse.output) || finalResponse.output.length === 0) && outputByIndex.size > 0) {
            finalResponse.output = Array.from(outputByIndex.entries())
                .sort(([a], [b]) => a - b)
                .map(([, item]) => item);
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

    const getCodexInstructionsForRequest = async (model: string): Promise<string> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                getCodexInstructions(model),
                new Promise<string>(resolve => {
                    timeout = setTimeout(() => resolve(''), 1500);
                }),
            ]);
        } catch (error) {
            logger.warn(`Codex instructions fetch failed for ${model}:`, error);
            return '';
        } finally {
            if (timeout) clearTimeout(timeout);
        }
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
            // Step 1: Get fresh access token
            const accessToken = await tokenStore.getValidAccessToken();
            const accountId = tokenStore.getAccountId();

            if (!accountId) {
                throw new Error('Account ID not found. Please re-authenticate.');
            }

            // Step 2: Extract URL string
            let url: string;
            if (typeof input === 'string') {
                url = input;
            } else if (input instanceof URL) {
                url = input.toString();
            } else {
                url = input.url;
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

                    // Normalize model name (e.g., gpt-5.2-codex-low -> gpt-5.2-codex)
                    const originalModel = parsed.model || '';
                    const normalizedModel = getBaseModelId(originalModel);
                    const reasoningEffort = getReasoningEffort(originalModel);

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
                    const codexInstructions = await getCodexInstructionsForRequest(normalizedModel);
                    const instructions = codexInstructions?.trim() || FALLBACK_CODEX_INSTRUCTIONS;

                    // Build reasoning config (matching official Codex CLI's build_responses_request)
                    const hasReasoning = reasoningEffort !== 'none';
                    const reasoning = hasReasoning ? {
                        effort: reasoningEffort,
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

                    // Codex backend requires non-empty instructions.
                    transformedBody.instructions = instructions;

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

                    // Preserve prompt_cache_key from AI SDK for cache continuity
                    if (parsed.prompt_cache_key) {
                        transformedBody.prompt_cache_key = parsed.prompt_cache_key;
                    }

                    // Remove unsupported parameters (matching opencode)
                    // These are not supported by Codex API
                    delete transformedBody.max_output_tokens;
                    delete transformedBody.max_completion_tokens;

                    body = JSON.stringify(transformedBody);
                    logger.debug(`Transformed request: model=${originalModel}->${normalizedModel}, reasoning=${reasoningEffort}, streaming=${isStreaming}`);
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

            if (response.status === HTTP_STATUS.UNAUTHORIZED) {
                const authErrorText = await response.clone().text().catch(() => '');
                if (/token_invalidated|expired|unauthorized/i.test(authErrorText)) {
                    try {
                        logger.warn('Codex access token was rejected; refreshing and retrying once');
                        const refreshedToken = await tokenStore.forceRefreshAccessToken(accountId);
                        headers.set('Authorization', `Bearer ${refreshedToken}`);
                        response = await globalThis.fetch(codexUrl, {
                            ...init,
                            body,
                            headers,
                        });
                    } catch (error) {
                        logger.error('Codex token refresh after 401 failed:', error);
                    }
                }
            }

            // Step 7: Handle error response (matching opencode's handleErrorResponse)
            if (!response.ok) {
                // Map 404 usage limit errors to 429 for proper rate limit handling
                const mappedResponse = await mapUsageLimit404(response);
                if (mappedResponse) {
                    logger.warn('Usage limit reached, returning 429 status');
                    return mappedResponse;
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

    const providerDisposable = providers.register({
        id: 'openai-codex',
        name: 'OpenAI Codex (ChatGPT)',
        description: 'Access GPT-5.3 Codex and other models via your ChatGPT subscription',
        authType: 'oauth',
        supportsMultiAccount: true,

        async initialize() {
            logger.info('Codex provider initialized');

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
                isRateLimited: record.quota?.rateLimitReached === true,
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
            return getActiveModels().map(model => ({
                id: model.id,
                name: model.name,
                description: model.description,
                contextWindow: model.contextWindow,
                maxOutputTokens: model.maxOutputTokens,
                capabilities: {
                    streaming: true,
                    reasoning: model.reasoning !== 'none',
                    functionCalling: true,
                },
                providerOptions: {
                    reasoning: model.reasoning,
                    baseModel: model.baseModel,
                },
            }));
        },

        async fetchModels() {
            logger.info('Fetching available models from Codex API...');
            try {
                let accessToken = await tokenStore.getValidAccessToken();
                const accountId = tokenStore.getAccountId();
                if (!accountId) {
                    logger.warn('No account ID, returning default models');
                    return this.getModels();
                }

                const fetchModelList = () => globalThis.fetch(
                    `${CODEX_BASE_URL}/codex/models?client_version=1.0.0`,
                    {
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            [OPENAI_HEADERS.ACCOUNT_ID]: accountId,
                            [OPENAI_HEADERS.ORIGINATOR]: 'codex_cli_rs',
                            [OPENAI_HEADERS.BETA]: 'responses=experimental',
                        },
                    },
                );

                let response = await fetchModelList();

                if (response.status === HTTP_STATUS.UNAUTHORIZED) {
                    const authErrorText = await response.clone().text().catch(() => '');
                    if (/token_invalidated|expired|unauthorized/i.test(authErrorText)) {
                        try {
                            logger.warn('Codex model fetch token was rejected; refreshing and retrying once');
                            accessToken = await tokenStore.forceRefreshAccessToken(accountId);
                            response = await fetchModelList();
                        } catch (error) {
                            logger.error('Codex token refresh before model fetch failed:', error);
                        }
                    }
                }

                if (!response.ok) {
                    logger.warn(`Failed to fetch models: ${response.status}`);
                    return this.getModels();
                }

                const data = await response.json();
                const models = buildModelsFromApiResponse(data);
                if (models.length === 0) {
                    logger.warn('No models found in API response');
                    return this.getModels();
                }

                setCachedModels(models);
                logger.info(`Fetched and cached ${models.length} models from Codex API`);

                return models.map(model => ({
                    id: model.id,
                    name: model.name,
                    description: model.description,
                    contextWindow: model.contextWindow,
                    maxOutputTokens: model.maxOutputTokens,
                    capabilities: {
                        streaming: true,
                        reasoning: model.reasoning !== 'none',
                        functionCalling: true,
                    },
                    providerOptions: {
                        reasoning: model.reasoning,
                        baseModel: model.baseModel,
                    },
                }));
            } catch (error) {
                logger.error('Error fetching models:', error);
                return this.getModels();
            }
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
