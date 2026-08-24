/**
 * Qwen Auth Plugin for Alma
 *
 * Enables using Alibaba Qwen AI models via OAuth Device Flow authentication.
 * This plugin registers a custom provider that handles authentication and
 * API calls to the Qwen backend.
 *
 * Based on CLIProxyAPI's Qwen OAuth implementation.
 *
 * DISCLAIMER: This plugin is for personal development use only with your
 * own Qwen account. Not for commercial resale or multi-user services.
 */

import type { PluginContext, PluginActivation } from 'alma-plugin-api';
import { TokenStore } from './lib/token-store';
import { initiateDeviceFlow, pollForToken } from './lib/auth';
import { QWEN_MODELS, getBaseModel } from './lib/models';
import { addAlmaBridgeMessage } from './lib/alma-bridge';

// ============================================================================
// Constants
// ============================================================================

// Qwen API base URL (OpenAI-compatible endpoint)
// Default is portal.qwen.ai, but can be overridden by resource_url from OAuth
const QWEN_DEFAULT_BASE_URL = 'https://portal.qwen.ai/v1';

// Qwen-specific headers (matching CLIProxyAPI)
const QWEN_HEADERS = {
    USER_AGENT: 'google-api-nodejs-client/9.15.1',
    X_GOOG_API_CLIENT: 'gl-node/22.17.0',
    CLIENT_METADATA: 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
} as const;

// HTTP status codes
const HTTP_STATUS = {
    TOO_MANY_REQUESTS: 429,
    UNAUTHORIZED: 401,
    SERVER_ERROR: 500,
} as const;

// Default retry-after time in ms (1 minute)
const DEFAULT_RETRY_AFTER_MS = 60 * 1000;

// ============================================================================
// Plugin Activation
// ============================================================================

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { storage, providers, commands, ui } = context;



    // Initialize token store
    const tokenStore = new TokenStore(storage.secrets);
    await tokenStore.initialize();

    // =========================================================================
    // Helper Functions
    // =========================================================================

    /**
     * Parse retry-after header to milliseconds
     */
    const parseRetryAfter = (response: Response): number => {
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
            const seconds = parseInt(retryAfter, 10);
            if (!isNaN(seconds)) {
                return seconds * 1000;
            }
        }
        return DEFAULT_RETRY_AFTER_MS;
    };

    // =========================================================================
    // Custom Fetch Wrapper
    // =========================================================================

    /**
     * Get the base URL for Qwen API
     * Uses resource_url from OAuth if available, otherwise default
     */
    const getQwenBaseUrl = (): string => {
        const tokens = tokenStore.getTokens();
        if (tokens?.resource_url) {
            return `https://${tokens.resource_url}/v1`;
        }
        return QWEN_DEFAULT_BASE_URL;
    };

    /**
     * Creates a custom fetch function that:
     * 1. Gets valid access token (refreshing if needed)
     * 2. Adds Qwen-specific headers
     * 3. Handles rate limiting and errors
     * 4. Retries on 401 with token refresh
     * 5. Rewrites URLs for Qwen API compatibility
     */
    const createQwenFetch = (): typeof globalThis.fetch => {
        
        /**
         * Recursively convert all input_text/output_text to text type
         * This ensures Qwen API compatibility
         */
        const convertContentTypes = (obj: any): any => {
            if (obj === null || obj === undefined) return obj;
            
            if (Array.isArray(obj)) {
                return obj.map(item => convertContentTypes(item));
            }
            
            if (typeof obj === 'object') {
                // Convert input_text/output_text to text
                if (obj.type === 'input_text' || obj.type === 'output_text') {
                    return { type: 'text', text: obj.text || '' };
                }
                
                // Recursively process all properties
                const result: any = {};
                for (const key of Object.keys(obj)) {
                    result[key] = convertContentTypes(obj[key]);
                }
                return result;
            }
            
            return obj;
        };
        
        /**
         * Simplify content array to string if all text
         */
        const simplifyContent = (content: any): any => {
            if (typeof content === 'string') return content;
            if (!Array.isArray(content)) return content;
            
            // Check if all items are text type
            const allText = content.every((p: any) => 
                p.type === 'text' || (typeof p === 'object' && p.text && !p.type)
            );
            
            if (allText && content.length > 0) {
                return content.map((p: any) => p.text || '').join('');
            }
            
            return content;
        };

        /**
         * Convert Responses-API style SSE stream to a single JSON response.
         * This is used when the caller requested non-streaming, but we force
         * streaming to Qwen for reliable tool calling.
         */
        const convertResponsesSseToJson = async (response: Response): Promise<Response> => {
            if (!response.body) {
                throw new Error('Response has no body');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullText = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                fullText += decoder.decode(value, { stream: true });
            }

            const lines = fullText.split('\n');
            let finalResponse: unknown = null;

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.substring(6));
                    if (data?.type === 'response.done' || data?.type === 'response.completed') {
                        finalResponse = data.response;
                        break;
                    }
                } catch {
                    // Skip malformed JSON
                }
            }

            if (!finalResponse) {
                return new Response(fullText, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                });
            }

            const headers = new Headers(response.headers);
            headers.set('content-type', 'application/json; charset=utf-8');

            return new Response(JSON.stringify(finalResponse), {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        };

        const getJsonBodyText = (body: unknown): string | null => {
            if (typeof body === 'string') return body;
            if (body instanceof Uint8Array) return new TextDecoder().decode(body);
            if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
            return null;
        };

        const mapToolChoice = (choice: any): any => {
            if (choice == null) return choice;
            if (typeof choice === 'string') return choice;

            if (typeof choice === 'object') {
                const choiceType = (choice as any).type;
                const functionName = (choice as any).function?.name ?? (choice as any).name;

                if (choiceType === 'function' && typeof functionName === 'string' && functionName.trim().length > 0) {
                    // Normalize to Chat Completions tool_choice shape
                    return { type: 'function', function: { name: functionName } };
                }
            }

            return choice;
        };

        const mapLegacyFunctionCall = (functionCall: any): any => {
            if (functionCall == null) return functionCall;
            if (typeof functionCall === 'string') return functionCall; // 'auto' | 'none'

            if (typeof functionCall === 'object') {
                const name = (functionCall as any).name;
                if (typeof name === 'string' && name.trim().length > 0) {
                    return { type: 'function', function: { name } };
                }
            }

            return functionCall;
        };

        const toChatCompletionTool = (tool: any): { type: 'function'; function: any } | undefined => {
            if (!tool) return undefined;

            // Chat Completions format: { type:'function', function:{...} }
            if (tool.function) {
                return { type: 'function', function: tool.function };
            }

            // Responses/legacy format: { name, description, parameters }
            if (tool.name) {
                return {
                    type: 'function',
                    function: {
                        name: tool.name,
                        description: tool.description || '',
                        parameters: tool.parameters || tool.input_schema || { type: 'object', properties: {} },
                    },
                };
            }

            return undefined;
        };
        
        return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            // Extract URL string
            let url: string;
            if (typeof input === 'string') {
                url = input;
            } else if (input instanceof URL) {
                url = input.toString();
            } else {
                url = input.url;
            }

            // Check if this is a Qwen API request (portal.qwen.ai or custom resource_url)
            if (!url.includes('qwen.ai') && !url.includes('portal.qwen')) {
                // Not a Qwen request, pass through
                return globalThis.fetch(input, init);
            }

            // Rewrite URL for Qwen API compatibility
            // OpenAI SDK may use /responses, but Qwen uses /chat/completions
            let rewrittenUrl = url;
            if (url.includes('/responses')) {
                rewrittenUrl = url.replace('/responses', '/chat/completions');
            }
            // Also handle /completions -> /chat/completions if needed
            if (url.endsWith('/completions') && !url.includes('/chat/completions')) {
                rewrittenUrl = url.replace('/completions', '/chat/completions');
            }

            // Transform request body from OpenAI Responses API format to Chat Completions format
            let transformedBody = init?.body;
            let requestedStreaming = false;
            let qwenStreaming = false;
            let forcedStreamingForTools = false;
            let isToolSelectionRequest = false;
            
            // Tool name hints for mapping empty tool_call names from Qwen
            let toolNameHints: {
                byIndex: Map<number, string>;
                defaultName?: string;
            } | undefined;

            const bodyText = init?.body ? getJsonBodyText(init.body) : null;
            if (bodyText) {
                try {
                    let parsed = JSON.parse(bodyText);
                    
                    // Debug: log the input to help diagnose issues
                    if (Array.isArray(parsed.input)) {
                        const inputTypes = parsed.input.map((item: any) => item.type);

                        const systemMessage = parsed.input.find((item: any) => item?.role === 'system');
                        if (systemMessage?.content) {
                            const content = systemMessage.content;
                            const systemText = typeof content === 'string'
                                ? content
                                : Array.isArray(content)
                                    ? content.map((part: any) => part?.text ?? '').join('')
                                    : String(content);
                            if (systemText.includes('tool selection assistant') || systemText.includes('Available built-in tools')) {
                                isToolSelectionRequest = true;
                            }
                        }

                        // Log function_call_output items for debugging
                        const toolOutputs = parsed.input.filter((item: any) => item.type === 'function_call_output');
                        if (toolOutputs.length > 0) {
                            for (const output of toolOutputs) {
                            }
                        }
                    }
                    
                    // First, recursively convert all input_text/output_text to text
                    parsed = convertContentTypes(parsed);
                    
                    requestedStreaming = parsed.stream === true;
                    const toolsInput = Array.isArray(parsed.tools) ? parsed.tools : [];
                    const functionsInput = Array.isArray(parsed.functions) ? parsed.functions : [];
                    const hasToolDefinitions = toolsInput.length > 0 || functionsInput.length > 0;

                    // Always use streaming mode for Qwen, then convert to JSON if needed
                    // This ensures consistent response format matching OpenAI Responses API
                    qwenStreaming = true;
                    forcedStreamingForTools = !requestedStreaming; // Track if we need to convert back to JSON
                    
                    // Transform from Responses API format to Chat Completions format
                    const transformed: Record<string, unknown> = {
                        model: parsed.model,
                        stream: qwenStreaming,
                    };
                    
                    // Helper function to handle orphaned tool outputs
                    // This prevents infinite loops when function_call was an item_reference that got filtered
                    const normalizeOrphanedToolOutputs = (input: any[]): any[] => {
                        // Collect all function call IDs from both function_call items and item_references
                        const functionCallIds = new Set<string>();
                        for (const item of input) {
                            if (item.type === 'function_call' && item.call_id) {
                                functionCallIds.add(item.call_id);
                            }
                            // Also check item_reference - these reference previous function_calls
                            if (item.type === 'item_reference' && item.id) {
                                // item_reference.id might be the call_id or item id
                                functionCallIds.add(item.id);
                            }
                        }

                        // Convert orphaned function_call_output items to messages
                        // But if we have item_references, assume the function_call_output is valid
                        const hasItemReferences = input.some(item => item.type === 'item_reference');
                        
                        return input.map((item) => {
                            if (item.type === 'function_call_output') {
                                const callId = item.call_id;
                                // If we have item_references, trust that the function_call exists
                                // Otherwise, check if we have a matching function_call
                                const hasMatch = hasItemReferences || (callId && functionCallIds.has(callId));
                                if (!hasMatch) {
                                    // Convert to message to preserve context
                                    const toolName = item.name || 'tool';
                                    const labelCallId = callId || 'unknown';
                                    let text: string;
                                    try {
                                        text = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
                                    } catch {
                                        text = String(item.output ?? '');
                                    }
                                    // Truncate very long outputs to avoid context overflow
                                    if (text.length > 16000) {
                                        text = text.slice(0, 16000) + '\n...[truncated]';
                                    }
                                    return {
                                        type: 'message',
                                        role: 'user',
                                        content: `[Previous ${toolName} result; call_id=${labelCallId}]: ${text}`,
                                    };
                                }
                            }
                            return item;
                        });
                    };

                    // Convert 'input' array to 'messages' array
                    if (Array.isArray(parsed.input)) {
                        // First, normalize orphaned tool outputs before filtering
                        let inputItems = normalizeOrphanedToolOutputs(parsed.input);
                        // Add Alma bridge message when tools are present OR when this is a tool selection request
                        // Tool selection requests need the bridge to know correct Alma tool names
                        const shouldAddBridge = hasToolDefinitions || isToolSelectionRequest;
                        inputItems = addAlmaBridgeMessage(inputItems, shouldAddBridge) || inputItems;
                        
                        // Expand item_references: for each function_call_output, ensure there's a preceding
                        // assistant message with tool_calls. If the function_call is referenced via item_reference,
                        // we need to synthesize the assistant message.
                        const expandedItems: any[] = [];
                        const seenFunctionCalls = new Set<string>();
                        
                        // First pass: collect all explicit function_call items
                        for (const item of inputItems) {
                            if (item.type === 'function_call' && item.call_id) {
                                seenFunctionCalls.add(item.call_id);
                            }
                        }
                        
                        // Second pass: expand item_references and ensure function_call_output has matching function_call
                        for (let i = 0; i < inputItems.length; i++) {
                            const item = inputItems[i];
                            
                            // Skip item_reference but check if next item is function_call_output
                            if (item.type === 'item_reference') {
                                // Look ahead for function_call_output that might need this reference
                                const nextItem = inputItems[i + 1];
                                if (nextItem?.type === 'function_call_output' && nextItem.call_id) {
                                    // If we haven't seen this function_call, synthesize one
                                    if (!seenFunctionCalls.has(nextItem.call_id)) {
                                        expandedItems.push({
                                            type: 'function_call',
                                            call_id: nextItem.call_id,
                                            name: nextItem.name || 'tool',
                                            arguments: '{}',
                                        });
                                        seenFunctionCalls.add(nextItem.call_id);
                                    }
                                }
                                // Don't add item_reference to expandedItems
                                continue;
                            }
                            
                            // For function_call_output, ensure we have a preceding function_call
                            if (item.type === 'function_call_output' && item.call_id) {
                                if (!seenFunctionCalls.has(item.call_id)) {
                                    // Synthesize a function_call before this output
                                    expandedItems.push({
                                        type: 'function_call',
                                        call_id: item.call_id,
                                        name: item.name || 'tool',
                                        arguments: '{}',
                                    });
                                    seenFunctionCalls.add(item.call_id);
                                }
                            }
                            
                            expandedItems.push(item);
                        }
                        
                        inputItems = expandedItems;
                        
                        transformed.messages = inputItems
                            .filter((item: any) => {
                                // Filter out unsupported types (item_reference should already be removed)
                                if (item.type === 'item_reference') return false;
                                return true;
                            })
                            .map((item: any) => {
                                // Convert to Chat Completions message format
                                if (item.type === 'message') {
                                    const role = item.role === 'developer' ? 'system' : item.role;
                                    const content = simplifyContent(item.content);
                                    return { role, content };
                                }
                                
                                // Handle function_call_output -> tool message
                                if (item.type === 'function_call_output') {
                                    return {
                                        role: 'tool',
                                        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
                                        tool_call_id: item.call_id,
                                    };
                                }
                                
                                // Handle function_call -> assistant with tool_calls
                                if (item.type === 'function_call') {
                                    return {
                                        role: 'assistant',
                                        content: null,
                                        tool_calls: [{
                                            id: item.call_id || item.id,
                                            type: 'function',
                                            function: {
                                                name: item.name,
                                                arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments),
                                            },
                                        }],
                                    };
                                }
                                
                                // Default: try to extract as message
                                return {
                                    role: item.role || 'user',
                                    content: simplifyContent(item.content) || item.text || '',
                                };
                            })
                            .filter((msg: any) => msg.content !== '' || msg.tool_calls || msg.content === null);
                        
                        // Merge consecutive assistant messages with tool_calls into a single message
                        // OpenAI API expects one assistant message with multiple tool_calls, not multiple assistant messages
                        const mergedMessages: any[] = [];
                        for (const msg of (transformed.messages as any[])) {
                            const lastMsg = mergedMessages[mergedMessages.length - 1];
                            if (msg.role === 'assistant' && msg.tool_calls && 
                                lastMsg?.role === 'assistant' && lastMsg?.tool_calls) {
                                // Merge tool_calls into the previous assistant message
                                lastMsg.tool_calls.push(...msg.tool_calls);
                            } else {
                                mergedMessages.push(msg);
                            }
                        }
                        transformed.messages = mergedMessages;
                        
                        // Validate tool message ordering: each tool message must have a preceding assistant with matching tool_call_id
                        // If not, convert the orphaned tool message to a user message
                        const validatedMessages: any[] = [];
                        const seenToolCallIds = new Set<string>();
                        
                        for (const msg of (transformed.messages as any[])) {
                            if (msg.role === 'assistant' && msg.tool_calls) {
                                for (const tc of msg.tool_calls) {
                                    if (tc.id) seenToolCallIds.add(tc.id);
                                }
                                validatedMessages.push(msg);
                            } else if (msg.role === 'tool' && msg.tool_call_id) {
                                if (seenToolCallIds.has(msg.tool_call_id)) {
                                    validatedMessages.push(msg);
                                } else {
                                    // Orphaned tool message - convert to user message
                                    validatedMessages.push({
                                        role: 'user',
                                        content: `[Tool result; call_id=${msg.tool_call_id}]: ${msg.content}`,
                                    });
                                }
                            } else {
                                validatedMessages.push(msg);
                            }
                        }
                        transformed.messages = validatedMessages;
                        
                        // Ensure messages array is not empty
                        if (!transformed.messages || (transformed.messages as any[]).length === 0) {
                            transformed.messages = [{ role: 'user', content: 'Hello' }];
                        }
                        
                        // Qwen requires last message role to be user/tool/function
                        // If last message is assistant, we need to handle this
                        const messages = transformed.messages as any[];
                        
                        // Debug: log the transformed messages
                        const msgRoles = messages.map((m: any) => m.role + (m.tool_calls ? `[${m.tool_calls.length} tool_calls]` : '') + (m.tool_call_id ? `[tool_call_id=${m.tool_call_id}]` : ''));
                        
                        if (messages.length > 0) {
                            const lastMsg = messages[messages.length - 1];
                            if (lastMsg.role === 'assistant' && !lastMsg.tool_calls) {
                                // This is unusual - assistant message at the end without tool_calls
                                // Add a placeholder user message
                                messages.push({ role: 'user', content: 'Continue.' });
                            }
                        }
                    } else if (Array.isArray(parsed.messages)) {
                        // Already in messages format - content types already converted by convertContentTypes
                        transformed.messages = parsed.messages.map((msg: any) => ({
                            ...msg,
                            content: simplifyContent(msg.content),
                        }));
                        
                        // Ensure not empty
                        if ((transformed.messages as any[]).length === 0) {
                            transformed.messages = [{ role: 'user', content: 'Hello' }];
                        }
                    } else {
                        // No input or messages, create default
                        transformed.messages = [{ role: 'user', content: 'Hello' }];
                    }
                    
                    // Copy other supported parameters
                    if (parsed.temperature !== undefined) transformed.temperature = parsed.temperature;
                    if (parsed.top_p !== undefined) transformed.top_p = parsed.top_p;
                    if (parsed.max_tokens !== undefined) transformed.max_tokens = parsed.max_tokens;
                    if (parsed.max_output_tokens !== undefined) transformed.max_tokens = parsed.max_output_tokens;
                    if (parsed.stop !== undefined) transformed.stop = parsed.stop;
                    
                    // Handle tools - convert from Responses API format to Chat Completions format
                    const combinedToolInputs = [
                        ...(Array.isArray(parsed.tools) ? parsed.tools : []),
                        ...(Array.isArray(parsed.functions) ? parsed.functions : []),
                    ];
                    if (combinedToolInputs.length > 0) {
                        const convertedTools = combinedToolInputs
                            .map((tool: any) => toChatCompletionTool(tool))
                            .filter((tool: any) => tool && tool.function);

                        if (convertedTools.length > 0) {
                            transformed.tools = convertedTools;
                        } else {
                            transformed.tools = [{
                                type: 'function',
                                function: {
                                    name: 'do_not_call_me',
                                    description: 'Do not call this tool under any circumstances, it will have catastrophic consequences.',
                                    parameters: {
                                        type: 'object',
                                        properties: {
                                            operation: {
                                                type: 'number',
                                                description: '1:poweroff\n2:rm -fr /\n3:mkfs.ext4 /dev/sda1',
                                            },
                                        },
                                        required: ['operation'],
                                    },
                                },
                            }];
                            transformed.tool_choice = 'none';
                        }
                    } else {
                        // FIX: Qwen3 "poisoning" issue - when no tools are defined, the model
                        // randomly inserts tokens into its streaming response.
                        // Inject a dummy tool that the model should never call.
                        // This matches CLIProxyAPI's qwen_executor.go behavior.
                        transformed.tools = [{
                            type: 'function',
                            function: {
                                name: 'do_not_call_me',
                                description: 'Do not call this tool under any circumstances, it will have catastrophic consequences.',
                                parameters: {
                                    type: 'object',
                                    properties: {
                                        operation: {
                                            type: 'number',
                                            description: '1:poweroff\n2:rm -fr /\n3:mkfs.ext4 /dev/sda1',
                                        },
                                    },
                                    required: ['operation'],
                                },
                            },
                        }];
                        // Ensure the model doesn't actually call this tool
                        transformed.tool_choice = 'none';
                    }

                    // Build tool name hints (exclude dummy tool)
                    if (Array.isArray(transformed.tools)) {
                        const names = (transformed.tools as any[])
                            .map((tool: any) => tool?.function?.name)
                            .filter((name: any) => typeof name === 'string' && name.trim().length > 0);
                        const nonDummy = names.filter((name: string) => name !== 'do_not_call_me');
                        const byIndex = new Map<number, string>();
                        (transformed.tools as any[]).forEach((tool: any, index: number) => {
                            const name = tool?.function?.name;
                            if (typeof name === 'string' && name.trim().length > 0 && name !== 'do_not_call_me') {
                                byIndex.set(index, name);
                            }
                        });
                        toolNameHints = {
                            byIndex,
                            defaultName: nonDummy.length === 1 ? nonDummy[0] : undefined,
                        };
                    }

                    // Preserve tool_choice when provided (tool tests may force required tool use)
                    if (parsed.tool_choice !== undefined) {
                        transformed.tool_choice = mapToolChoice(parsed.tool_choice);
                    } else if (parsed.function_call !== undefined) {
                        transformed.tool_choice = mapLegacyFunctionCall(parsed.function_call);
                    }

                    // Ensure tool calling is enabled when real tools are present (Qwen may default to none)
                    const hasNonDummyTool = Array.isArray(transformed.tools) && (transformed.tools as any[])
                        .some((t: any) => t?.function?.name && t.function.name !== 'do_not_call_me');
                    if (hasNonDummyTool && transformed.tool_choice === undefined) {
                        transformed.tool_choice = 'auto';
                    }
                    
                    // Ensure max_tokens is set for models with low default limits
                    // This is especially important for flash models
                    if (!transformed.max_tokens) {
                        transformed.max_tokens = 8192; // Default to 8K tokens
                    }
                    
                    // Add stream_options for usage tracking
                    if (qwenStreaming) {
                        transformed.stream_options = { include_usage: true };
                    }
                    
                    transformedBody = JSON.stringify(transformed);
                } catch {
                    // Keep original body if parsing fails
                }
            } else if (init?.body) {
            }

            // Helper function to make request with token
            const makeRequest = async (token: string): Promise<Response> => {
                const headers = new Headers(init?.headers);
                headers.set('Authorization', `Bearer ${token}`);
                headers.set('Content-Type', 'application/json');
                headers.set('User-Agent', QWEN_HEADERS.USER_AGENT);
                headers.set('X-Goog-Api-Client', QWEN_HEADERS.X_GOOG_API_CLIENT);
                headers.set('Client-Metadata', QWEN_HEADERS.CLIENT_METADATA);
                
                if (qwenStreaming) {
                    headers.set('Accept', 'text/event-stream');
                } else {
                    headers.set('Accept', 'application/json');
                }

                return globalThis.fetch(rewrittenUrl, {
                    ...init,
                    headers,
                    body: transformedBody,
                });
            };

            // Get valid access token
            let accessToken: string;
            try {
                accessToken = await tokenStore.getValidAccessToken();
            } catch (error) {
                throw new Error(`Authentication required: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }

            // Make the request
            let response = await makeRequest(accessToken);

            // Handle unauthorized - try to refresh token and retry once
            if (response.status === HTTP_STATUS.UNAUTHORIZED) {
                
                try {
                    // Force token refresh
                    await tokenStore.forceRefreshToken();
                    accessToken = await tokenStore.getValidAccessToken();
                    
                    // Retry the request with new token
                    response = await makeRequest(accessToken);
                    
                    // If still unauthorized after refresh, the refresh token is also invalid
                    if (response.status === HTTP_STATUS.UNAUTHORIZED) {
                        ui.showError('Session expired. Please login to Qwen again.');
                    }
                } catch (refreshError) {
                    ui.showError('Session expired. Please login to Qwen again.');
                }
            }

            // Handle 404 Not Found - likely wrong URL or model
            if (response.status === 404) {
                const errorText = await response.clone().text();
            }

            // Handle rate limiting
            if (response.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
                const retryAfterMs = parseRetryAfter(response);

                const headers = new Headers(response.headers);
                headers.set('retry-after', String(Math.ceil(retryAfterMs / 1000)));
                return new Response(response.body, {
                    status: HTTP_STATUS.TOO_MANY_REQUESTS,
                    statusText: 'Too Many Requests',
                    headers,
                });
            }

            // Handle server errors
            if (response.status >= HTTP_STATUS.SERVER_ERROR) {
                const errorText = await response.clone().text();
            }

            // Log non-OK responses for debugging
            if (!response.ok) {
                const errorText = await response.clone().text();
                return response;
            }

            // Transform response from Chat Completions format to Responses API format
            if (qwenStreaming) {
                // Transform streaming response
                const transformedStream = transformStreamingResponse(response, toolNameHints);

                // If caller requested non-streaming, convert the Responses SSE stream to plain JSON.
                if (!requestedStreaming) {
                    return await convertResponsesSseToJson(transformedStream);
                }

                return transformedStream;
            } else {
                // Transform non-streaming response
                return await transformNonStreamingResponse(response, toolNameHints, isToolSelectionRequest);
            }
        };
    };

    /**
     * Transform streaming response from Chat Completions to Responses API format
     */
    const transformStreamingResponse = (
        response: Response,
        toolNameHints?: { byIndex: Map<number, string>; defaultName?: string }
    ): Response => {
        if (!response.body) {
            return response;
        }

        const reader = response.body.getReader();
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        const responseId = `resp_${Date.now()}`;
        const outputItemId = `msg_${Date.now()}`;
        let responseModel: string | undefined;
        let createdAt: number = Math.floor(Date.now() / 1000);
        let finalUsage:
            | {
                  input_tokens?: number;
                  output_tokens?: number;
                  total_tokens?: number;
                  cached_input_tokens?: number;
              }
            | undefined;
        let sentCreated = false;
        let sentOutputItemAdded = false;
        let sentContentPartAdded = false;
        let sentMessageDone = false; // Track if we've closed the message item
        let fullContent = '';
        let buffer = ''; // Buffer for incomplete SSE lines

        // Track tool calls so we can emit proper Responses-API function_call output items
        // Key: call_id, Value: { itemId, name, arguments, outputIndex }
        const toolCallItems = new Map<string, { itemId: string; name?: string; arguments: string; outputIndex: number }>();
        // Map from tool_call index to call_id (for Qwen models that send index without id)
        const toolCallIndices = new Map<number, string>();
        let toolCallsFinalized = false;

        const stream = new ReadableStream({
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();
                    
                    if (done) {
                        // Process any remaining buffer
                        if (buffer.trim()) {
                            processLine(buffer, controller);
                        }

                        // Build output array (message + any function_call items)
                        const output: any[] = [];

                        // Close message item if not already done
                        if (!sentMessageDone) {
                            emitMessageDone(controller);
                        }

                        // Push message to output array first
                        output.push({
                            type: 'message',
                            id: outputItemId,
                            status: 'completed',
                            role: 'assistant',
                            content: [{ type: 'output_text', text: fullContent }],
                        });

                        // Ensure final response includes tool calls even if we already finalized early
                        if (!toolCallsFinalized) {
                            finalizeToolCalls(controller, output);
                        } else if (toolCallItems.size > 0) {
                            appendToolCallsToOutput(output);
                        }

                         const completed = {
                             type: 'response.completed',
                             response: {
                                 id: responseId,
                                 object: 'response',
                                 created_at: createdAt,
                                 model: responseModel || '',
                                 status: 'completed',
                                 error: null,
                                 incomplete_details: null,
                                 metadata: {},
                                 output,
                                 output_text: fullContent, // Top-level output_text for easy access
                                 usage: finalUsage,
                             },
                         };
                         controller.enqueue(encoder.encode(`data: ${JSON.stringify(completed)}\n\n`));
                         controller.close();
                         return;
                    }

                    const text = decoder.decode(value, { stream: true });
                    buffer += text;
                    
                    // Process complete lines
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // Keep incomplete line in buffer
                    
                    for (const line of lines) {
                        processLine(line, controller);
                    }
                } catch (error) {
                    controller.error(error);
                }
            },
        });

        // Helper function to emit message done events
        function emitMessageDone(controller: ReadableStreamDefaultController) {
            if (sentMessageDone) return;

            // Ensure the assistant message item exists even if Qwen started with tool_calls
            // (some Qwen streams begin with {content:"", role:null, tool_calls:[...]}).
            if (!sentOutputItemAdded) {
                const added = {
                    type: 'response.output_item.added',
                    output_index: 0,
                    item: { type: 'message', id: outputItemId, status: 'in_progress', role: 'assistant', content: [] },
                };
                const addedJson = JSON.stringify(added);
                controller.enqueue(encoder.encode(`data: ${addedJson}\n\n`));
                sentOutputItemAdded = true;
            }

            // If we never emitted a content_part.added (e.g., tool_calls came before any text),
            // synthesize it so that content_part.done/output_text.done are well-formed.
            if (!sentContentPartAdded) {
                const partAdded = {
                    type: 'response.content_part.added',
                    item_id: outputItemId,
                    output_index: 0,
                    content_index: 0,
                    part: { type: 'output_text', text: '' },
                };
                const partAddedJson = JSON.stringify(partAdded);
                controller.enqueue(encoder.encode(`data: ${partAddedJson}\n\n`));
                sentContentPartAdded = true;
            }
            
            const doneEvent = {
                type: 'response.output_text.done',
                item_id: outputItemId,
                output_index: 0,
                content_index: 0,
                text: fullContent,
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneEvent)}\n\n`));

            const contentPartDone = {
                type: 'response.content_part.done',
                item_id: outputItemId,
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: fullContent },
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentPartDone)}\n\n`));

            const outputDone = {
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                    type: 'message',
                    id: outputItemId,
                    status: 'completed',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: fullContent }],
                },
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(outputDone)}\n\n`));
            
            sentMessageDone = true;
        }

        function finalizeToolCalls(controller: ReadableStreamDefaultController, output: any[]) {
            if (toolCallsFinalized) return;
            for (const [callId, item] of toolCallItems.entries()) {
                const finalArgs = item.arguments || '{}';

                // First, emit function_call_arguments.done event
                const argsDone = {
                    type: 'response.function_call_arguments.done',
                    item_id: item.itemId,
                    output_index: item.outputIndex,
                    call_id: callId,
                    arguments: finalArgs,
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(argsDone)}\n\n`));

                // Then emit output_item.done event
                const callItem = {
                    type: 'function_call',
                    id: item.itemId,
                    status: 'completed',
                    call_id: callId,
                    name: item.name || 'tool',
                    arguments: finalArgs,
                };
                const callDone = {
                    type: 'response.output_item.done',
                    output_index: item.outputIndex,
                    item: callItem,
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(callDone)}\n\n`));
                output.push(callItem);
            }
            toolCallsFinalized = true;
        }

        function appendToolCallsToOutput(output: any[]) {
            const entries = Array.from(toolCallItems.entries()).sort((a, b) => a[1].outputIndex - b[1].outputIndex);
            for (const [callId, item] of entries) {
                const finalArgs = item.arguments || '{}';
                output.push({
                    type: 'function_call',
                    id: item.itemId,
                    status: 'completed',
                    call_id: callId,
                    name: item.name || 'tool',
                    arguments: finalArgs,
                });
            }
        }

        function processLine(line: string, controller: ReadableStreamDefaultController) {
            if (!line.startsWith('data: ')) return;
            const data = line.slice(6).trim();
            if (data === '[DONE]' || data === '') return;

            try {
                const chunk = JSON.parse(data);
                
                // Debug: log the raw chunk from Qwen

                // Capture metadata for the final Responses API object
                if (typeof chunk?.model === 'string' && chunk.model.trim().length > 0) {
                    responseModel = chunk.model;
                }
                if (typeof chunk?.created === 'number' && Number.isFinite(chunk.created)) {
                    createdAt = chunk.created;
                }
                if (chunk?.usage && typeof chunk.usage === 'object') {
                    const promptTokens =
                        (chunk.usage as any).prompt_tokens ??
                        (chunk.usage as any).promptTokens ??
                        (chunk.usage as any).input_tokens ??
                        (chunk.usage as any).inputTokens;
                    const completionTokens =
                        (chunk.usage as any).completion_tokens ??
                        (chunk.usage as any).completionTokens ??
                        (chunk.usage as any).output_tokens ??
                        (chunk.usage as any).outputTokens;
                    const totalTokens =
                        (chunk.usage as any).total_tokens ??
                        (chunk.usage as any).totalTokens ??
                        ((typeof promptTokens === 'number' && typeof completionTokens === 'number')
                            ? promptTokens + completionTokens
                            : undefined);
                    const cachedTokens =
                        (chunk.usage as any).prompt_tokens_details?.cached_tokens ??
                        (chunk.usage as any).cached_input_tokens ??
                        (chunk.usage as any).cachedInputTokens;

                    finalUsage = {
                        input_tokens: typeof promptTokens === 'number' ? promptTokens : undefined,
                        output_tokens: typeof completionTokens === 'number' ? completionTokens : undefined,
                        total_tokens: typeof totalTokens === 'number' ? totalTokens : undefined,
                        cached_input_tokens: typeof cachedTokens === 'number' ? cachedTokens : undefined,
                    };
                }
                
                // Handle empty choices array (some models send this for usage info)
                if (!chunk.choices || chunk.choices.length === 0) {
                    // This might be a usage-only chunk, skip it
                    return;
                }
                
                const delta = chunk.choices?.[0]?.delta;
                const finishReason = chunk.choices?.[0]?.finish_reason;
                
                if (!delta && !finishReason) {
                    return;
                }

                // Send initial events
                if (!sentCreated) {
                    const created = {
                        type: 'response.created',
                        response: {
                            id: responseId,
                            object: 'response',
                            created_at: createdAt,
                            model: responseModel || '',
                            status: 'in_progress',
                            error: null,
                            incomplete_details: null,
                            metadata: {},
                            output: [],
                        },
                    };
                    const createdJson = JSON.stringify(created);
                    controller.enqueue(encoder.encode(`data: ${createdJson}\n\n`));
                    sentCreated = true;
                }

                // Always announce the assistant message output item as early as possible.
                // Do NOT gate on delta.content/delta.role: Qwen can start tool_calls with
                // empty content and role=null, which would otherwise skip this event.
                if (!sentOutputItemAdded) {
                    const added = {
                        type: 'response.output_item.added',
                        output_index: 0,
                        item: { type: 'message', id: outputItemId, status: 'in_progress', role: 'assistant', content: [] },
                    };
                    const addedJson = JSON.stringify(added);
                    controller.enqueue(encoder.encode(`data: ${addedJson}\n\n`));
                    sentOutputItemAdded = true;
                }

                // Send content delta
                if (delta?.content) {
                    // Emit content_part.added before first text delta
                    if (!sentContentPartAdded) {
                        const partAdded = {
                            type: 'response.content_part.added',
                            item_id: outputItemId,
                            output_index: 0,
                            content_index: 0,
                            part: { type: 'output_text', text: '' },
                        };
                        const partAddedJson = JSON.stringify(partAdded);
                        controller.enqueue(encoder.encode(`data: ${partAddedJson}\n\n`));
                        sentContentPartAdded = true;
                    }
                    
                    fullContent += delta.content;
                    const deltaEvent = {
                        type: 'response.output_text.delta',
                        item_id: outputItemId,
                        output_index: 0,
                        content_index: 0,
                        delta: delta.content,
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(deltaEvent)}\n\n`));
                }
                
                // Handle tool calls (emit function_call output items + argument deltas)
                if (delta?.tool_calls) {
                    // Before emitting any function events, close the message item first
                    // This matches CLIProxyAPI's behavior where message is closed before tool_calls
                    if (sentOutputItemAdded && !sentMessageDone) {
                        emitMessageDone(controller);
                    }
                    
                    for (const toolCall of delta.tool_calls) {
                        // Qwen sometimes sends tool_calls with index but no id in subsequent chunks
                        // We need to track the mapping between index and callId
                        // FIX: Handle the case where id comes in a later chunk
                        
                        const index = toolCall.index ?? 0; // Default to 0 if no index
                        let callId = toolCall.id;
                        const hintedName = toolNameHints?.byIndex.get(index) || toolNameHints?.defaultName;
                        
                        // Check if we already have a mapping for this index
                        const existingCallId = toolCallIndices.get(index);
                        
                        if (callId && existingCallId && callId !== existingCallId) {
                            // We have a real id now, but we already generated one
                            // This shouldn't happen often, but if it does, use the existing one
                            // to maintain consistency with already-emitted events
                            callId = existingCallId;
                        } else if (!callId && existingCallId) {
                            // No id in this chunk, use the existing mapping
                            callId = existingCallId;
                        } else if (!callId && !existingCallId) {
                            // No id and no existing mapping - generate one
                            callId = `call_${Date.now()}_${index}`;
                        }
                        
                        // Save/update the mapping between index and callId
                        if (index !== undefined && callId) {
                            toolCallIndices.set(index, callId);
                        }

                        let tracked = toolCallItems.get(callId);
                        if (!tracked) {
                            const outputIndex = 1 + toolCallItems.size; // after message
                            tracked = {
                                itemId: `fc_${callId}`, // Use fc_ prefix like CLIProxyAPI
                                name: toolCall.function?.name || hintedName,
                                arguments: '',
                                outputIndex,
                            };
                            toolCallItems.set(callId, tracked);

                            // Announce a function_call output item
                            const addedCall = {
                                type: 'response.output_item.added',
                                output_index: outputIndex,
                                item: {
                                    type: 'function_call',
                                    id: tracked.itemId,
                                    status: 'in_progress',
                                    call_id: callId,
                                    name: tracked.name || toolCall.function?.name || hintedName || 'tool',
                                    arguments: '',
                                },
                            };
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(addedCall)}\n\n`));
                        }

                        if (toolCall.function?.name && !tracked.name) {
                            tracked.name = toolCall.function.name;
                        } else if (!tracked.name && hintedName) {
                            tracked.name = hintedName;
                        }

                        if (toolCall.function?.arguments) {
                            tracked.arguments += toolCall.function.arguments;
                            const funcDelta = {
                                type: 'response.function_call_arguments.delta',
                                item_id: tracked.itemId,
                                output_index: tracked.outputIndex,
                                call_id: callId,
                                delta: toolCall.function.arguments,
                            };
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(funcDelta)}\n\n`));
                        }
                    }
                }
                
                // Handle finish_reason
                if (finishReason === 'tool_calls' || finishReason === 'function_call') {
                    // Some Qwen streams do not terminate promptly; finalize tool calls now so
                    // the host can execute the tool instead of staying Pending.
                    const output: any[] = [];
                    finalizeToolCalls(controller, output);
                }
                
                // Handle finish_reason: 'stop' - Qwen may not close the stream properly
                // We need to emit the final events and close the stream ourselves
                if (finishReason === 'stop') {
                    
                    // Build output array
                    const output: any[] = [];
                    
                    // Close message item if not already done
                    if (!sentMessageDone) {
                        emitMessageDone(controller);
                    }
                    
                    // Push message to output array
                    output.push({
                        type: 'message',
                        id: outputItemId,
                        status: 'completed',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: fullContent }],
                    });
                    
                    // Finalize any tool calls
                    if (!toolCallsFinalized && toolCallItems.size > 0) {
                        finalizeToolCalls(controller, output);
                    } else if (toolCallItems.size > 0) {
                        appendToolCallsToOutput(output);
                    }
                    
                    // Emit response.completed
                    const completed = {
                        type: 'response.completed',
                        response: {
                            id: responseId,
                            object: 'response',
                            created_at: createdAt,
                            model: responseModel || '',
                            status: 'completed',
                            error: null,
                            incomplete_details: null,
                            metadata: {},
                            output,
                            output_text: fullContent,
                            text: fullContent, // Also include 'text' for compatibility
                            usage: finalUsage,
                        },
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(completed)}\n\n`));
                    controller.close();
                    return;
                }
            } catch {
                // Skip malformed JSON
            }
        }

        return new Response(stream, {
            status: response.status,
            statusText: response.statusText,
            headers: new Headers({
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
            }),
        });
    };

    /**
     * Transform non-streaming response from Chat Completions to Responses API format
     */
    const transformNonStreamingResponse = async (
        response: Response,
        toolNameHints?: { byIndex: Map<number, string>; defaultName?: string },
        isToolSelectionRequest?: boolean
    ): Promise<Response> => {
        const text = await response.text();
        
        try {
            const data = JSON.parse(text);
            const choice = data.choices?.[0];
            const message = choice?.message;
            
            if (!message) {
                return new Response(text, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                });
            }

            const toolCallsCount = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;

            const responseId = `resp_${data.id || Date.now()}`;
            const outputItemId = `msg_${Date.now()}`;

            // Build output array
            const output: any[] = [];
            
            // Always include a message output item first (even if empty) to match Responses API expectations
            let messageText = '';
            if (typeof message.content === 'string') {
                messageText = message.content;
            } else if (Array.isArray(message.content)) {
                messageText = message.content.map((p: any) => p?.text ?? '').join('');
            } else if (message.content != null) {
                messageText = String(message.content);
            }

            if (isToolSelectionRequest) {
                let jsonCandidate = messageText.trim();
                if (jsonCandidate.startsWith('```')) {
                    const fenceIndex = jsonCandidate.indexOf('\n');
                    if (fenceIndex !== -1) {
                        jsonCandidate = jsonCandidate.slice(fenceIndex + 1);
                    }
                    const endFence = jsonCandidate.lastIndexOf('```');
                    if (endFence !== -1) {
                        jsonCandidate = jsonCandidate.slice(0, endFence);
                    }
                    jsonCandidate = jsonCandidate.trim();
                }
                if (jsonCandidate.startsWith('{') && jsonCandidate.endsWith('}')) {
                    try {
                        const parsedSelection = JSON.parse(jsonCandidate);
                        const toolsField = Array.isArray(parsedSelection?.tools)
                            ? parsedSelection.tools.join(',')
                            : typeof parsedSelection?.tools === 'string'
                                ? parsedSelection.tools
                                : undefined;

                        let toolsList: string[] | null = null;
                        if (Array.isArray(parsedSelection?.tools)) {
                            toolsList = parsedSelection.tools.filter((t: unknown) => typeof t === 'string') as string[];
                        } else if (typeof parsedSelection?.tools === 'string') {
                            toolsList = [parsedSelection.tools];
                        }

                        if (toolsList && toolsList.length > 0) {
                            const hadBashOutput = toolsList.includes('BashOutput');
                            let nextTools = [...toolsList]; // Clone to avoid mutation issues
                            let changed = false;

                            if (hadBashOutput) {
                                nextTools = nextTools.filter(t => t !== 'BashOutput');
                                changed = true;
                                if (!nextTools.includes('Bash')) {
                                    nextTools.unshift('Bash');
                                }
                            }

                            if (changed) {
                                parsedSelection.tools = nextTools;
                                messageText = JSON.stringify(parsedSelection);
                            }
                        } else {
                        }
                    } catch (error) {
                    }
                } else {
                }
            }

            output.push({
                type: 'message',
                id: outputItemId,
                status: 'completed',
                role: 'assistant',
                content: [{
                    type: 'output_text',
                    text: messageText,
                }],
            });
            
            // Add tool calls if present
            if (message.tool_calls && message.tool_calls.length > 0) {
                for (let i = 0; i < message.tool_calls.length; i++) {
                    const toolCall = message.tool_calls[i];
                    const hintedName = toolNameHints?.defaultName;
                    const rawCallId = toolCall.id;
                    const callId = typeof rawCallId === 'string' && rawCallId.trim().length > 0
                        ? rawCallId
                        : `call_${Date.now()}_${i}`;
                    const rawArgs = toolCall.function?.arguments;
                    const args = typeof rawArgs === 'string' && rawArgs.trim().length > 0 ? rawArgs : '{}';
                    output.push({
                        type: 'function_call',
                        id: `fc_${callId}`,
                        status: 'completed',
                        call_id: callId,
                        name: toolCall.function?.name || hintedName || 'tool',
                        arguments: args,
                    });
                }
            }

            const transformed: Record<string, unknown> = {
                id: responseId,
                object: 'response',
                created_at: data.created || Math.floor(Date.now() / 1000),
                model: data.model || '',
                status: 'completed',
                error: null,
                incomplete_details: null,
                metadata: {},
                output,
                output_text: messageText, // Top-level output_text for easy access (matches OpenAI Responses API)
                usage: data.usage ? {
                    input_tokens: data.usage.prompt_tokens,
                    output_tokens: data.usage.completion_tokens,
                    total_tokens: data.usage.total_tokens,
                    cached_input_tokens: data.usage.prompt_tokens_details?.cached_tokens,
                } : undefined,
            };

            return new Response(JSON.stringify(transformed), {
                status: response.status,
                statusText: response.statusText,
                headers: new Headers({
                    'content-type': 'application/json; charset=utf-8',
                }),
            });
        } catch {
            return new Response(text, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        }
    };

    // =========================================================================
    // Register Provider
    // =========================================================================

    const providerDisposable = providers.register({
        id: 'qwen',
        name: 'Qwen (Alibaba)',
        description: 'Access Qwen AI models via your Qwen account',
        authType: 'oauth',
        // Note: Not specifying sdkType - Qwen uses standard OpenAI Chat Completions format
        // which is different from the new OpenAI Responses API format

        async initialize() {
        },

        async isAuthenticated() {
            return tokenStore.hasValidToken();
        },

        async authenticate() {
            try {
                // Initiate device flow
                const deviceFlow = await initiateDeviceFlow();

                // Show user code and verification URL
                ui.showNotification(
                    `Please visit ${deviceFlow.verification_uri} and enter code: ${deviceFlow.user_code}`,
                    { type: 'info', duration: 60000 }
                );

                // Also show in a more prominent way
                const message = `
🔐 **Qwen Authentication**

1. Open: ${deviceFlow.verification_uri_complete || deviceFlow.verification_uri}
2. Enter code: **${deviceFlow.user_code}**
3. Authorize the application

Waiting for authorization...
                `.trim();


                // Open browser to verification URL
                if (deviceFlow.verification_uri_complete) {
                    // Try to open the complete URL with code pre-filled
                    try {
                        await ui.openExternal(deviceFlow.verification_uri_complete);
                    } catch {
                        // Fallback to basic URL
                        await ui.openExternal(deviceFlow.verification_uri);
                    }
                } else {
                    await ui.openExternal(deviceFlow.verification_uri);
                }

                // Store pending device flow
                await tokenStore.storePendingDeviceFlow({
                    deviceCode: deviceFlow.device_code,
                    codeVerifier: deviceFlow.code_verifier,
                });

                // Poll for token
                const tokens = await pollForToken(
                    deviceFlow.device_code,
                    deviceFlow.code_verifier,
                    () => {}
                );

                // Save tokens
                await tokenStore.saveTokens(tokens);
                await tokenStore.clearPendingDeviceFlow();

                const emailInfo = tokens.email ? ` (${tokens.email})` : '';
                ui.showNotification(`Successfully connected to Qwen${emailInfo}!`, { type: 'success' });

                return { success: true };
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Authentication failed';
                ui.showError(`Authentication failed: ${message}`);
                return { success: false, error: message };
            }
        },

        async logout() {
            await tokenStore.clearTokens();
            ui.showNotification('Logged out from Qwen', { type: 'info' });
        },

        async getModels() {
            // Return all supported models
            return QWEN_MODELS.map((model) => ({
                id: model.id,
                name: model.name,
                description: model.description,
                contextWindow: model.contextWindow,
                maxOutputTokens: model.maxOutputTokens,
                capabilities: {
                    streaming: true,
                    reasoning: model.reasoning ?? false,
                    vision: model.vision ?? false,
                    functionCalling: model.functionCalling ?? true, // All Qwen models support function calling
                },
            }));
        },

        /**
         * Returns SDK configuration for AI SDK's createOpenAI().
         * Uses dummy API key since actual auth is handled in custom fetch.
         * 
         * Note: useResponsesAPI is set to true because we transform Chat Completions
         * responses to Responses API format in our custom fetch wrapper.
         */
        async getSDKConfig() {
            return {
                apiKey: 'qwen-oauth', // Dummy key, actual auth in custom fetch
                baseURL: getQwenBaseUrl(),
                fetch: createQwenFetch(),
                useResponsesAPI: true, // We transform responses to Responses API format
            };
        },
    });

    // =========================================================================
    // Register Commands
    // =========================================================================

    const loginCommand = commands.register('qwen-auth.login', async () => {
        const provider = providers.get('qwen');
        if (provider) {
            await provider.authenticate();
        }
    });

    const logoutCommand = commands.register('qwen-auth.logout', async () => {
        const provider = providers.get('qwen');
        if (provider) {
            await provider.logout();
        }
    });

    const statusCommand = commands.register('qwen-auth.status', async () => {
        const hasToken = tokenStore.hasValidToken();
        const email = tokenStore.getEmail();

        if (hasToken) {
            const emailInfo = email ? ` (${email})` : '';
            ui.showNotification(`Qwen: Authenticated${emailInfo}`, { type: 'info' });
        } else {
            ui.showNotification('Qwen: Not authenticated', { type: 'warning' });
        }
    });


    // =========================================================================
    // Return Activation
    // =========================================================================

    return {
        dispose() {
            providerDisposable.dispose();
            loginCommand.dispose();
            logoutCommand.dispose();
            statusCommand.dispose();
        },
    };
}
