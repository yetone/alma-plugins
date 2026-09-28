/**
 * Type definitions for OpenAI Codex Auth Plugin
 */

// ============================================================================
// OAuth Types
// ============================================================================

export interface CodexTokens {
    access_token: string;
    refresh_token: string;
    expires_at: number; // Unix timestamp in milliseconds
    account_id: string; // ChatGPT account ID extracted from JWT
    id_token?: string;  // Raw OIDC id_token from token endpoint (used for profile claims)
}

/** User-facing claims extracted from access_token / id_token JWTs. */
export interface CodexAccountClaims {
    accountId: string;
    email?: string;
    picture?: string;
    plan?: string;
}

/** A single ChatGPT account (tokens + cached profile/quota). */
export interface CodexAccountRecord {
    id: string;        // Same as tokens.account_id — duplicated for stable key access
    tokens: CodexTokens;
    email?: string;
    picture?: string;
    plan?: string;
    quota?: CodexAccountQuota;
    /**
     * Until when (ms since epoch) this account is known to be out of quota:
     * set when the backend answers a request with usage_limit_reached, from
     * its `resets_in_seconds`. Requests prefer another account while it is
     * in the future; cleared by the next successful request on it.
     */
    limitedUntil?: number;
}

/** Per-limit quota info returned to the host via ProviderAccountInfo.quota. */
export interface CodexQuotaEntry {
    name: string;           // e.g. "primary", "secondary", "codex (primary)"
    percentage: number;     // Remaining percentage (0-100), i.e. 100 - used_percent
    resetTime: string;      // ISO 8601
}

export interface CodexAccountQuota {
    models: CodexQuotaEntry[];
    lastUpdated: number;
    /** Optional plan type reported by backend (e.g. "plus", "pro"). */
    planType?: string;
    /** True if the backend reported rate_limit_reached. */
    rateLimitReached?: boolean;
}

export interface PKCEChallenge {
    verifier: string;
    challenge: string;
}

export interface OAuthConfig {
    clientId: string;
    authUrl: string;
    tokenUrl: string;
    redirectUri: string;
    scopes: string;
}

// ============================================================================
// Model Types
// ============================================================================

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export interface CodexModelInfo {
    id: string;
    name: string;
    description?: string;
    baseModel: string; // The actual model ID sent to API
    reasoning: ReasoningEffort;
    // The reasoning efforts this base model supports (from the backend's
    // supported_reasoning_levels). Carried on the base entry so the composer's
    // thinking selector can show exactly the levels this model allows.
    supportedReasoningLevels?: ReasoningEffort[];
    contextWindow?: number;
    maxOutputTokens?: number;
    // Service tiers the backend offers for this model beyond the default
    // (from the catalog's service_tiers, e.g. "priority" = Fast mode).
    serviceTiers?: string[];
}

// ============================================================================
// API Types
// ============================================================================

export interface CodexChatRequest {
    model: string;
    store: false; // Required: stateless mode
    stream: boolean;
    instructions?: string;
    input: CodexInputItem[];
    tools?: CodexTool[];
    reasoning?: {
        effort: ReasoningEffort;
        summary?: 'auto' | 'concise' | 'detailed';
    };
    text?: {
        verbosity?: 'low' | 'medium' | 'high';
    };
    include?: string[];
    prompt_cache_key?: string;
}

export type CodexInputItem =
    | { role: 'developer'; content: string }
    | { role: 'user'; content: string | CodexContentPart[] }
    | { role: 'assistant'; content: string }
    | { type: 'function_call'; call_id: string; name: string; arguments: string }
    | { type: 'function_call_output'; call_id: string; output: string };

export interface CodexContentPart {
    type: 'input_text' | 'input_image';
    text?: string;
    image_url?: string;
}

export interface CodexTool {
    type: 'function';
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}

// ============================================================================
// SSE Response Types
// ============================================================================

export interface CodexSSEEvent {
    type: 'response.start' | 'response.ongoing' | 'response.done' | 'error';
    response?: CodexResponse;
    error?: { message: string; code?: string };
}

export interface CodexResponse {
    id: string;
    output: CodexOutputItem[];
    usage?: {
        input_tokens: number;
        output_tokens: number;
        reasoning_tokens?: number;
    };
}

export interface CodexOutputItem {
    type: 'message' | 'function_call';
    content?: Array<{ type: 'output_text'; text: string }>;
    call_id?: string;
    name?: string;
    arguments?: string;
}
