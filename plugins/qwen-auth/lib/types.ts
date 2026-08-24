/**
 * Type definitions for Qwen Auth Plugin
 */

// ============================================================================
// OAuth Types
// ============================================================================

/**
 * Qwen OAuth token data returned from token endpoint
 */
export interface QwenTokens {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_at: number; // Unix timestamp in milliseconds
    resource_url?: string;
    email?: string;
}

/**
 * Device Flow response from Qwen OAuth
 */
export interface DeviceFlowResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
    code_verifier: string; // Added by client for PKCE
}

/**
 * Token response from Qwen OAuth token endpoint
 */
export interface QwenTokenResponse {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    resource_url?: string;
    expires_in: number;
}

/**
 * Error response from Qwen OAuth
 */
export interface QwenOAuthError {
    error: string;
    error_description?: string;
}

/**
 * PKCE challenge pair
 */
export interface PKCEChallenge {
    verifier: string;
    challenge: string;
}

// ============================================================================
// Storage Types
// ============================================================================

/**
 * Token storage format for persistence
 */
export interface QwenTokenStorage {
    access_token: string;
    refresh_token: string;
    last_refresh: string; // ISO timestamp
    resource_url?: string;
    email?: string;
    type: 'qwen';
    expires_at: string; // ISO timestamp
}

// ============================================================================
// Model Types
// ============================================================================

export interface QwenModelInfo {
    id: string;
    name: string;
    description?: string;
    baseModel: string; // The actual model ID sent to API
    contextWindow?: number;
    maxOutputTokens?: number;
    reasoning?: boolean; // Model supports reasoning/thinking
    vision?: boolean; // Model supports vision
    functionCalling?: boolean; // Model supports function/tool calling
}

// ============================================================================
// API Types (OpenAI Compatible Format)
// ============================================================================

export interface QwenChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | QwenContentPart[];
}

export interface QwenContentPart {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: {
        url: string;
    };
}

export interface QwenChatRequest {
    model: string;
    messages: QwenChatMessage[];
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    stop?: string | string[];
}

export interface QwenChatResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: QwenChatChoice[];
    usage?: QwenUsage;
}

export interface QwenChatChoice {
    index: number;
    message?: QwenChatMessage;
    delta?: Partial<QwenChatMessage>;
    finish_reason?: string | null;
}

export interface QwenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

// ============================================================================
// Stream Types
// ============================================================================

export interface QwenStreamChunk {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: QwenStreamChoice[];
}

export interface QwenStreamChoice {
    index: number;
    delta: {
        role?: string;
        content?: string;
    };
    finish_reason?: string | null;
}
