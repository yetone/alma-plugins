/**
 * Codex API Client
 *
 * Handles communication with the ChatGPT Codex backend API.
 * Implements request transformation and SSE response parsing.
 */

import type { TokenStore, Logger } from './token-store';
import type {
    CodexChatRequest,
    CodexInputItem,
    ReasoningEffort,
} from './types';
import { getBaseModelId, getReasoningEffort } from './models';

// ============================================================================
// API Configuration
// ============================================================================

const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';
const FALLBACK_CODEX_INSTRUCTIONS = [
    'You are ChatGPT, running as a coding agent in Alma.',
    'Be concise, follow the user request, and use available tools when needed.',
].join('\n');

// ============================================================================
// Request Types (from Alma's ProviderChatRequest)
// ============================================================================

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    stream?: boolean;
    temperature?: number;
    maxTokens?: number;
    providerOptions?: Record<string, unknown>;
}

// ============================================================================
// Codex API Client
// ============================================================================

export class CodexClient {
    private tokenStore: TokenStore;
    private logger: Logger;

    constructor(tokenStore: TokenStore, logger: Logger) {
        this.tokenStore = tokenStore;
        this.logger = logger;
    }

    /**
     * Create a chat completion using the Codex API.
     * Returns a ReadableStream for streaming responses.
     */
    async createChatCompletion(request: ChatRequest): Promise<ReadableStream<Uint8Array>> {
        const accessToken = await this.tokenStore.getValidAccessToken();
        const accountId = this.tokenStore.getAccountId();

        if (!accountId) {
            throw new Error('Account ID not found. Please re-authenticate.');
        }

        // Transform the request to Codex format
        const codexRequest = this.transformRequest(request);

        this.logger.debug('Codex request:', JSON.stringify(codexRequest, null, 2));

        // Make the API call
        const response = await fetch(CODEX_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
                'chatgpt-account-id': accountId,
                originator: 'codex_cli_rs',
                'OpenAI-Beta': 'responses=experimental',
            },
            body: JSON.stringify(codexRequest),
        });

        if (!response.ok) {
            const errorText = await response.text();
            this.logger.error('Codex API error:', errorText);

            // Parse error for better messaging
            try {
                const errorJson = JSON.parse(errorText);
                if (errorJson.error?.message) {
                    throw new Error(errorJson.error.message);
                }
            } catch {
                // Use raw error text
            }

            throw new Error(`Codex API error: ${response.status} ${response.statusText}`);
        }

        // Return transformed stream
        return this.transformSSEStream(response.body!);
    }

    /**
     * Transform Alma's chat request to Codex API format
     */
    private transformRequest(request: ChatRequest): CodexChatRequest {
        const baseModel = getBaseModelId(request.model);
        const reasoningEffort = this.getEffectiveReasoningEffort(request);

        // Transform messages to Codex input format
        const input = this.transformMessages(request.messages);

        const codexRequest: CodexChatRequest = {
            model: baseModel,
            store: false, // Required: stateless mode
            stream: true, // Always stream for now
            instructions: FALLBACK_CODEX_INSTRUCTIONS,
            input,
            include: ['reasoning.encrypted_content'], // Preserve reasoning context
        };

        // Add reasoning configuration if not 'none'
        if (reasoningEffort !== 'none') {
            codexRequest.reasoning = {
                effort: reasoningEffort,
                summary: 'auto',
            };
        }

        return codexRequest;
    }

    /**
     * Get effective reasoning effort from request or model default
     */
    private getEffectiveReasoningEffort(request: ChatRequest): ReasoningEffort {
        // Check if reasoning effort is specified in provider options
        const options = request.providerOptions;
        if (options?.reasoningEffort) {
            return options.reasoningEffort as ReasoningEffort;
        }

        // Fall back to model's default reasoning level
        return getReasoningEffort(request.model);
    }

    /**
     * Transform messages to Codex input format.
     * Key transformations:
     * - System messages become 'developer' role
     * - All message IDs are stripped (stateless mode requirement)
     * - Content arrays are normalized
     */
    private transformMessages(messages: ChatMessage[]): CodexInputItem[] {
        const input: CodexInputItem[] = [];

        for (const msg of messages) {
            // Get string content
            const content = typeof msg.content === 'string'
                ? msg.content
                : msg.content.map(part => part.text || '').join('');

            switch (msg.role) {
                case 'system':
                    // System messages become 'developer' role in Codex
                    input.push({ role: 'developer', content });
                    break;
                case 'user':
                    input.push({ role: 'user', content });
                    break;
                case 'assistant':
                    input.push({ role: 'assistant', content });
                    break;
            }
        }

        return input;
    }

    /**
     * Transform Codex SSE stream to plain text stream.
     * Codex returns SSE events like:
     *   data: {"type":"response.ongoing","response":{"output":[{"content":[{"text":"Hello"}]}]}}
     *
     * IMPORTANT: Codex API returns CUMULATIVE content in each event, not deltas.
     * We need to track what we've already sent and only stream the new portions.
     */
    private transformSSEStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let buffer = '';
        let previousText = ''; // Track what we've already sent

        return new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();

                    if (done) {
                        controller.close();
                        return;
                    }

                    buffer += decoder.decode(value, { stream: true });

                    // Process complete SSE events
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // Keep incomplete line in buffer

                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;

                        const data = line.slice(6); // Remove 'data: ' prefix
                        if (data === '[DONE]') {
                            controller.close();
                            return;
                        }

                        try {
                            const event = JSON.parse(data);
                            if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
                                controller.enqueue(encoder.encode(event.delta));
                                continue;
                            }
                            const fullText = extractTextFromEvent(event);

                            // Only send the delta (new portion of text)
                            if (fullText && fullText.length > previousText.length) {
                                const delta = fullText.slice(previousText.length);
                                controller.enqueue(encoder.encode(delta));
                                previousText = fullText;
                            }
                        } catch {
                            // Skip invalid JSON
                        }
                    }
                } catch (error) {
                    controller.error(error);
                }
            },
            cancel() {
                reader.cancel();
            },
        });
    }
}

/**
 * Extract text content from a Codex SSE event
 */
function extractTextFromEvent(event: Record<string, unknown>): string {
    if (event.type === 'error') {
        const error = event.error as { message?: string };
        throw new Error(error?.message || 'Unknown Codex error');
    }

    if (event.type !== 'response.ongoing' && event.type !== 'response.done') {
        return '';
    }

    const response = event.response as {
        output?: Array<{
            type: string;
            content?: Array<{ type: string; text?: string }>;
        }>;
    };

    if (!response?.output) return '';

    let text = '';
    for (const item of response.output) {
        if (item.type === 'message' && item.content) {
            for (const part of item.content) {
                if (part.type === 'output_text' && part.text) {
                    text += part.text;
                }
            }
        }
    }

    return text;
}
