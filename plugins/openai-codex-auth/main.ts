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

// ============================================================================
// Constants (matching opencode-openai-codex-auth)
// ============================================================================

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const DUMMY_API_KEY = 'chatgpt-oauth';
const DEFAULT_CODEX_INSTRUCTIONS = 'You are Codex running inside Alma. Help the user accurately, stay concise, and use available tools when needed.';

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
} as const;

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

        // Parse SSE events to extract the final response
        const lines = fullText.split('\n');
        let finalResponse: unknown = null;

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                try {
                    const data = JSON.parse(line.substring(6));
                    if (data.type === 'response.done' || data.type === 'response.completed') {
                        finalResponse = data.response;
                        break;
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

    const extractTextContent = (content: unknown): string => {
        if (typeof content === 'string') return content;
        if (content == null) return '';
        if (Array.isArray(content)) {
            return content
                .map((part) => {
                    if (typeof part === 'string') return part;
                    if (typeof part !== 'object' || part === null) return '';
                    const record = part as Record<string, any>;
                    if (typeof record.text === 'string') return record.text;
                    if (typeof record.content === 'string') return record.content;
                    return '';
                })
                .join('');
        }
        if (typeof content === 'object') {
            const record = content as Record<string, any>;
            if (typeof record.text === 'string') return record.text;
            if (typeof record.content === 'string') return record.content;
        }
        return String(content);
    };

    const toCodexUserContent = (content: unknown): string | Array<{ type: 'input_text' | 'input_image'; text?: string; image_url?: string }> => {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return extractTextContent(content);

        const parts: Array<{ type: 'input_text' | 'input_image'; text?: string; image_url?: string }> = [];

        for (const part of content) {
            if (typeof part === 'string') {
                parts.push({ type: 'input_text', text: part });
                continue;
            }
            if (typeof part !== 'object' || part === null) continue;

            const record = part as Record<string, any>;
            if ((record.type === 'text' || record.type === 'input_text') && typeof record.text === 'string') {
                parts.push({ type: 'input_text', text: record.text });
                continue;
            }

            if ((record.type === 'image_url' || record.type === 'input_image') && record.image_url) {
                const imageUrl = typeof record.image_url === 'string'
                    ? record.image_url
                    : record.image_url?.url;
                if (typeof imageUrl === 'string' && imageUrl.length > 0) {
                    parts.push({ type: 'input_image', image_url: imageUrl });
                }
                continue;
            }

            if (record.type === 'image' && record.image) {
                const imageUrl = typeof record.image === 'string' ? record.image : record.image?.url;
                if (typeof imageUrl === 'string' && imageUrl.length > 0) {
                    parts.push({ type: 'input_image', image_url: imageUrl });
                }
            }
        }

        if (parts.length === 0) return '';
        if (parts.every((part) => part.type === 'input_text')) {
            return parts.map((part) => part.text || '').join('');
        }
        return parts;
    };

    const toCodexFunctionTools = (tools: any[] | undefined): any[] | undefined => {
        if (!Array.isArray(tools) || tools.length === 0) return undefined;

        const mapped = tools
            .filter((tool) => tool?.type === 'function' && tool.function?.name)
            .map((tool) => ({
                type: 'function',
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters,
            }));

        return mapped.length > 0 ? mapped : undefined;
    };

    const toCodexInputFromChatMessages = (messages: any[] | undefined): any[] => {
        if (!Array.isArray(messages)) return [];

        const input: any[] = [];

        for (const message of messages) {
            if (!message || typeof message !== 'object') continue;

            const role = message.role;
            if (role === 'system' || role === 'developer') {
                input.push({
                    role: 'developer',
                    content: extractTextContent(message.content),
                });
                continue;
            }

            if (role === 'user') {
                input.push({
                    role: 'user',
                    content: toCodexUserContent(message.content),
                });
                continue;
            }

            if (role === 'assistant') {
                const assistantText = extractTextContent(message.content);
                if (assistantText) {
                    input.push({
                        role: 'assistant',
                        content: assistantText,
                    });
                }

                const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
                for (const toolCall of toolCalls) {
                    const callId = toolCall?.id || crypto.randomUUID();
                    const name = toolCall?.function?.name || toolCall?.name || 'tool';
                    const args = toolCall?.function?.arguments ?? toolCall?.arguments ?? '{}';
                    input.push({
                        type: 'function_call',
                        call_id: callId,
                        name,
                        arguments: typeof args === 'string' ? args : JSON.stringify(args),
                    });
                }
                continue;
            }

            if (role === 'tool') {
                const callId = message.tool_call_id || message.call_id || 'unknown';
                input.push({
                    type: 'function_call_output',
                    call_id: callId,
                    output: extractTextContent(message.content),
                });
            }
        }

        return input;
    };

    const extractCodexResponsePayload = (payload: any): {
        id: string;
        text: string;
        toolCalls: Array<{ id: string; name: string; arguments: string }>;
        usage?: { input_tokens?: number; output_tokens?: number; reasoning_tokens?: number };
    } => {
        const response = payload?.response ?? payload;
        const output = Array.isArray(response?.output) ? response.output : [];
        let text = '';
        const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

        for (const item of output) {
            if (item?.type === 'message' && Array.isArray(item.content)) {
                for (const part of item.content) {
                    if (part?.type === 'output_text' && typeof part.text === 'string') {
                        text += part.text;
                    }
                }
            }

            if (item?.type === 'function_call') {
                toolCalls.push({
                    id: item.call_id || crypto.randomUUID(),
                    name: item.name || 'tool',
                    arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
                });
            }
        }

        return {
            id: response?.id || crypto.randomUUID(),
            text,
            toolCalls,
            usage: response?.usage,
        };
    };

    const createCodexEventState = () => ({
        id: crypto.randomUUID(),
        text: '',
        toolCalls: new Map<string, { id: string; name: string; arguments: string }>(),
        usage: undefined as { input_tokens?: number; output_tokens?: number; reasoning_tokens?: number } | undefined,
    });

    const applyCodexEventToState = (state: ReturnType<typeof createCodexEventState>, event: any) => {
        if (event?.response?.id) {
            state.id = event.response.id;
        }

        if (event?.response?.usage) {
            state.usage = event.response.usage;
        }

        if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            state.text += event.delta;
            return;
        }

        if (event?.type === 'response.output_text.done' && typeof event.text === 'string') {
            state.text = event.text;
            return;
        }

        if (event?.type === 'response.output_item.done') {
            const item = event.item;

            if (item?.type === 'message' && Array.isArray(item.content)) {
                const itemText = item.content
                    .filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string')
                    .map((part: any) => part.text)
                    .join('');
                if (itemText) {
                    state.text = itemText;
                }
                return;
            }

            if (item?.type === 'function_call') {
                const toolCallId = item.call_id || item.id || crypto.randomUUID();
                state.toolCalls.set(toolCallId, {
                    id: toolCallId,
                    name: item.name || 'tool',
                    arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
                });
            }
        }
    };

    const toOpenAIUsage = (usage: { input_tokens?: number; output_tokens?: number; reasoning_tokens?: number } | undefined) => {
        if (!usage) return undefined;
        const promptTokens = usage.input_tokens ?? 0;
        const completionTokens = usage.output_tokens ?? 0;
        return {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
        };
    };

    const buildOpenAICompletion = (payload: any, requestedModel: string) => {
        const parsed = extractCodexResponsePayload(payload);
        const message: Record<string, any> = {
            role: 'assistant',
            content: parsed.toolCalls.length > 0 && parsed.text.length === 0 ? null : parsed.text,
        };

        if (parsed.toolCalls.length > 0) {
            message.tool_calls = parsed.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: 'function',
                function: {
                    name: toolCall.name,
                    arguments: toolCall.arguments,
                },
            }));
        }

        return {
            id: parsed.id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [
                {
                    index: 0,
                    message,
                    finish_reason: parsed.toolCalls.length > 0 ? 'tool_calls' : 'stop',
                },
            ],
            usage: toOpenAIUsage(parsed.usage),
        };
    };

    const buildOpenAICompletionFromState = (state: ReturnType<typeof createCodexEventState>, requestedModel: string) => {
        const toolCalls = Array.from(state.toolCalls.values());
        const message: Record<string, any> = {
            role: 'assistant',
            content: toolCalls.length > 0 && state.text.length === 0 ? null : state.text,
        };

        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: 'function',
                function: {
                    name: toolCall.name,
                    arguments: toolCall.arguments,
                },
            }));
        }

        return {
            id: state.id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [
                {
                    index: 0,
                    message,
                    finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
                },
            ],
            usage: toOpenAIUsage(state.usage),
        };
    };

    const convertCodexSseToOpenAIJson = async (response: Response, requestedModel: string): Promise<Response> => {
        if (!response.body) {
            throw new Error('Response has no body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const state = createCodexEventState();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.substring(6).trim();
                if (!data || data === '[DONE]') continue;

                const event = JSON.parse(data);
                if (event.type === 'error') {
                    throw new Error(event.error?.message || 'Unknown Codex error');
                }

                applyCodexEventToState(state, event);
            }
        }

        return new Response(JSON.stringify(buildOpenAICompletionFromState(state, requestedModel)), {
            status: response.status,
            statusText: response.statusText,
            headers: {
                'content-type': 'application/json; charset=utf-8',
            },
        });
    };

    const convertCodexSseToOpenAI = async (response: Response, requestedModel: string): Promise<Response> => {
        if (!response.body) {
            throw new Error('Response has no body');
        }

        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        const state = createCodexEventState();

        let buffer = '';
        let emittedRole = false;
        const emittedToolCalls = new Set<string>();
        let finished = false;

        const emitFinalChunk = (controller: ReadableStreamDefaultController<Uint8Array>) => {
            if (finished) return;
            finished = true;

            const chunkBase = {
                id: state.id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: requestedModel,
            };

            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                ...chunkBase,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: state.toolCalls.size > 0 ? 'tool_calls' : 'stop',
                }],
                usage: toOpenAIUsage(state.usage),
            })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        };

        const processEvent = (event: any, controller: ReadableStreamDefaultController<Uint8Array>) => {
            if (event.type === 'error') {
                throw new Error(event.error?.message || 'Unknown Codex error');
            }

            applyCodexEventToState(state, event);

            const chunkBase = {
                id: state.id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: requestedModel,
            };

            if (!emittedRole && (event.type === 'response.output_text.delta' || event.type === 'response.output_item.done')) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                    ...chunkBase,
                    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
                })}\n\n`));
                emittedRole = true;
            }

            if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta.length > 0) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                    ...chunkBase,
                    choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
                })}\n\n`));
            }

            if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
                const toolCallId = event.item.call_id || event.item.id || crypto.randomUUID();
                if (!emittedToolCalls.has(toolCallId)) {
                    emittedToolCalls.add(toolCallId);
                    const toolCalls = Array.from(state.toolCalls.values());
                    const index = toolCalls.findIndex((toolCall) => toolCall.id === toolCallId);
                    const toolCall = state.toolCalls.get(toolCallId);
                    if (toolCall) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                            ...chunkBase,
                            choices: [{
                                index: 0,
                                delta: {
                                    tool_calls: [{
                                        index: index >= 0 ? index : 0,
                                        id: toolCall.id,
                                        type: 'function',
                                        function: {
                                            name: toolCall.name,
                                            arguments: toolCall.arguments,
                                        },
                                    }],
                                },
                                finish_reason: null,
                            }],
                        })}\n\n`));
                    }
                }
            }

            if (event.type === 'response.completed' || event.type === 'response.done') {
                emitFinalChunk(controller);
            }
        };

        const processBuffer = (chunk: string, controller: ReadableStreamDefaultController<Uint8Array>, flush = false) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = flush ? '' : (lines.pop() || '');
            const completeLines = flush ? lines.filter((line) => line.length > 0) : lines;

            for (const line of completeLines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.substring(6).trim();
                if (!data || data === '[DONE]') continue;
                processEvent(JSON.parse(data), controller);
                if (finished) return;
            }
        };

        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        processBuffer(decoder.decode(value, { stream: true }), controller);
                        if (finished) return;
                    }

                    processBuffer(decoder.decode(), controller, true);

                    if (!finished) {
                        emitFinalChunk(controller);
                    }
                } catch (error) {
                    controller.error(error);
                }
            },
            cancel() {
                reader.cancel();
            },
        });

        return new Response(stream, {
            status: response.status,
            statusText: response.statusText,
            headers: {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
            },
        });
    };

    const transformChatCompletionsRequest = async (parsed: any): Promise<{
        body: string;
        isStreaming: boolean;
        normalizedModel: string;
    }> => {
        const originalModel = parsed.model || '';
        const normalizedModel = getBaseModelId(originalModel);
        const reasoningEffort = getReasoningEffort(originalModel);
        const isStreaming = parsed.stream === true;
        const codexInstructions = await getCodexInstructions(normalizedModel);
        const hasReasoning = reasoningEffort !== 'none';

        const transformedBody: Record<string, any> = {
            model: normalizedModel,
            store: false,
            stream: true,
            input: toCodexInputFromChatMessages(parsed.messages),
            include: hasReasoning ? ['reasoning.encrypted_content'] : [],
            tool_choice: parsed.tool_choice ?? 'auto',
            parallel_tool_calls: parsed.parallel_tool_calls ?? true,
            text: { verbosity: 'medium' },
        };

        const tools = toCodexFunctionTools(parsed.tools);
        if (tools) {
            transformedBody.tools = tools;
        }

        transformedBody.instructions = codexInstructions || DEFAULT_CODEX_INSTRUCTIONS;

        if (hasReasoning) {
            transformedBody.reasoning = {
                effort: reasoningEffort,
                summary: 'auto',
            };
        }

        return {
            body: JSON.stringify(transformedBody),
            isStreaming,
            normalizedModel,
        };
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
            const isChatCompletionsRequest = /\/chat\/completions(?:\?|$)/.test(url);
            const isModelsRequest = /\/models(?:\?|$)/.test(url);
            const codexUrl = isChatCompletionsRequest
                ? `${CODEX_BASE_URL}${URL_PATHS.CODEX_RESPONSES}`
                : url.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES);
            logger.debug(`Rewriting URL: ${url} -> ${codexUrl}`);

            if (isModelsRequest && (!init?.method || init.method === 'GET')) {
                return new Response(JSON.stringify({
                    object: 'list',
                    data: getActiveModels().map((model) => ({
                        id: model.id,
                        object: 'model',
                        created: Math.floor(Date.now() / 1000),
                        owned_by: 'openai-codex-auth',
                    })),
                }), {
                    status: 200,
                    headers: {
                        'content-type': 'application/json; charset=utf-8',
                    },
                });
            }

            // Step 4: Transform request body (matching opencode-openai-codex-auth exactly)
            let body = init?.body;
            let isStreaming = true; // Default to streaming
            let promptCacheKey: string | undefined; // For prompt caching headers
            let requestedModel = '';

            if (isChatCompletionsRequest && body && typeof body === 'string') {
                try {
                    const parsed = JSON.parse(body);
                    requestedModel = parsed.model || '';
                    const transformed = await transformChatCompletionsRequest(parsed);
                    body = transformed.body;
                    isStreaming = transformed.isStreaming;
                    logger.debug(`Translated chat/completions request: model=${requestedModel || transformed.normalizedModel}, streaming=${isStreaming}`);
                } catch (e) {
                    logger.error('Error transforming chat completion request body:', e);
                }
            }

            if (!isChatCompletionsRequest && body && typeof body === 'string') {
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
                    const codexInstructions = await getCodexInstructions(normalizedModel);

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

                    // Set Codex instructions (matching opencode's body.instructions = codexInstructions)
                    transformedBody.instructions = codexInstructions || DEFAULT_CODEX_INSTRUCTIONS;

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
            const response = await globalThis.fetch(codexUrl, {
                ...init,
                body,
                headers,
            });

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
                if (isChatCompletionsRequest) {
                    return await convertCodexSseToOpenAIJson(response, requestedModel || 'unknown');
                }
                return await convertSseToJson(response, responseHeaders);
            }

            if (isChatCompletionsRequest) {
                return await convertCodexSseToOpenAI(response, requestedModel || 'unknown');
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

    const providerDisposable = providers.register({
        id: 'openai-codex',
        name: 'OpenAI Codex (ChatGPT)',
        description: 'Access GPT-5.3 Codex and other models via your ChatGPT subscription',
        authType: 'oauth',
        sdkType: 'openai-compatible',

        async initialize() {
            logger.info('Codex provider initialized');
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
                await tokenStore.saveTokens(tokens);
                await tokenStore.clearPendingState();

                ui.showNotification('Successfully connected to ChatGPT!', { type: 'success' });
                logger.info('Codex authentication successful');

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
                const accessToken = await tokenStore.getValidAccessToken();
                const accountId = tokenStore.getAccountId();
                if (!accountId) {
                    logger.warn('No account ID, returning default models');
                    return this.getModels();
                }

                const response = await globalThis.fetch(
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
