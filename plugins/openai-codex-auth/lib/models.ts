/**
 * Codex Model Definitions
 *
 * Supports both hardcoded defaults and dynamic model fetching from API.
 * Each base model generates reasoning effort variants automatically.
 */

import type { CodexModelInfo, ReasoningEffort } from './types';

// ============================================================================
// Module Cache
// ============================================================================

let cachedModels: CodexModelInfo[] | null = null;

/** Get active model list (cached from API or hardcoded defaults) */
export function getActiveModels(): CodexModelInfo[] {
    return cachedModels ?? CODEX_MODELS;
}

/** Set cached models fetched from API */
export function setCachedModels(models: CodexModelInfo[]): void {
    cachedModels = models;
}

// ============================================================================
// Dynamic Model Building from /codex/models API
// ============================================================================

const REASONING_LABELS: Record<string, string> = {
    minimal: 'Minimal Reasoning',
    none: 'No Reasoning',
    low: 'Low Reasoning',
    medium: 'Medium Reasoning',
    high: 'High Reasoning',
    xhigh: 'XHigh Reasoning',
};

/**
 * Build models from the /backend-api/codex/models API response.
 * Uses actual API data (slug, display_name, context_window,
 * supported_reasoning_levels, etc.) instead of guessing.
 */
export function buildModelsFromApiResponse(data: any): CodexModelInfo[] {
    const apiModels: any[] = data?.models ?? [];
    if (!Array.isArray(apiModels) || apiModels.length === 0) return [];

    const models: CodexModelInfo[] = [];

    for (const m of apiModels) {
        const slug: string = m.slug;
        if (!slug) continue;

        const displayName: string = m.display_name || slug;
        const description: string = m.description || '';
        const contextWindow: number = m.context_window || 272000;
        const defaultEffort: ReasoningEffort = (m.default_reasoning_level || 'medium') as ReasoningEffort;
        const levels: Array<{ effort: string }> = m.supported_reasoning_levels || [];

        // Default variant (with the model's default reasoning level)
        models.push({
            id: slug,
            name: displayName,
            description,
            baseModel: slug,
            reasoning: defaultEffort,
            contextWindow,
            maxOutputTokens: 128000,
        });

        // Additional reasoning variants
        for (const level of levels) {
            const effort = level.effort as ReasoningEffort;
            if (effort === defaultEffort) continue;
            const label = REASONING_LABELS[effort] || `${effort.charAt(0).toUpperCase()}${effort.slice(1)} Reasoning`;

            models.push({
                id: `${slug}-${effort}`,
                name: `${displayName} (${label})`,
                baseModel: slug,
                reasoning: effort,
                contextWindow,
                maxOutputTokens: 128000,
            });
        }
    }

    return models;
}

// ============================================================================
// Default Model Definitions (fallback when API is unavailable)
// ============================================================================

export const CODEX_MODELS: CodexModelInfo[] = [
    // -------------------------------------------------------------------------
    // GPT-5.5 (current frontier model - supports low/medium/high/xhigh)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        description: 'GPT-5.5 - frontier model for complex coding and research',
        baseModel: 'gpt-5.5',
        reasoning: 'medium',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.5-low',
        name: 'GPT-5.5 (Low Reasoning)',
        baseModel: 'gpt-5.5',
        reasoning: 'low',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.5-high',
        name: 'GPT-5.5 (High Reasoning)',
        baseModel: 'gpt-5.5',
        reasoning: 'high',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.5-xhigh',
        name: 'GPT-5.5 (XHigh Reasoning)',
        baseModel: 'gpt-5.5',
        reasoning: 'xhigh',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },

    // -------------------------------------------------------------------------
    // GPT-5.4 (flagship frontier model - supports none/low/medium/high/xhigh)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        description: 'GPT-5.4 - flagship frontier model for professional work',
        baseModel: 'gpt-5.4',
        reasoning: 'medium',
        contextWindow: 1050000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.4-none',
        name: 'GPT-5.4 (No Reasoning)',
        baseModel: 'gpt-5.4',
        reasoning: 'none',
        contextWindow: 1050000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.4-low',
        name: 'GPT-5.4 (Low Reasoning)',
        baseModel: 'gpt-5.4',
        reasoning: 'low',
        contextWindow: 1050000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.4-high',
        name: 'GPT-5.4 (High Reasoning)',
        baseModel: 'gpt-5.4',
        reasoning: 'high',
        contextWindow: 1050000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.4-xhigh',
        name: 'GPT-5.4 (XHigh Reasoning)',
        baseModel: 'gpt-5.4',
        reasoning: 'xhigh',
        contextWindow: 1050000,
        maxOutputTokens: 128000,
    },

    // -------------------------------------------------------------------------
    // GPT-5.4 Mini (fast/cost-efficient model - supports low/medium/high/xhigh)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 Mini',
        description: 'GPT-5.4 Mini - fast and cost-efficient model',
        baseModel: 'gpt-5.4-mini',
        reasoning: 'medium',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.4-mini-low',
        name: 'GPT-5.4 Mini (Low Reasoning)',
        baseModel: 'gpt-5.4-mini',
        reasoning: 'low',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.4-mini-high',
        name: 'GPT-5.4 Mini (High Reasoning)',
        baseModel: 'gpt-5.4-mini',
        reasoning: 'high',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.4-mini-xhigh',
        name: 'GPT-5.4 Mini (XHigh Reasoning)',
        baseModel: 'gpt-5.4-mini',
        reasoning: 'xhigh',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },

    // -------------------------------------------------------------------------
    // GPT-5.3 Codex (4 variants - no 'none' reasoning)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5.3-codex',
        name: 'GPT-5.3 Codex',
        description: 'GPT-5.3 Codex - most capable agentic coding model',
        baseModel: 'gpt-5.3-codex',
        reasoning: 'medium',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.3-codex-low',
        name: 'GPT-5.3 Codex (Low Reasoning)',
        baseModel: 'gpt-5.3-codex',
        reasoning: 'low',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.3-codex-high',
        name: 'GPT-5.3 Codex (High Reasoning)',
        baseModel: 'gpt-5.3-codex',
        reasoning: 'high',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.3-codex-xhigh',
        name: 'GPT-5.3 Codex (XHigh Reasoning)',
        baseModel: 'gpt-5.3-codex',
        reasoning: 'xhigh',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },

    // -------------------------------------------------------------------------
    // GPT-5.3 Codex Spark (2 variants - speed-optimized, text-only)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5.3-codex-spark',
        name: 'GPT-5.3 Codex Spark',
        description: 'GPT-5.3 Codex Spark - real-time coding, 1000+ tok/s',
        baseModel: 'gpt-5.3-codex-spark',
        reasoning: 'medium',
        contextWindow: 128000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.3-codex-spark-high',
        name: 'GPT-5.3 Codex Spark (High Reasoning)',
        baseModel: 'gpt-5.3-codex-spark',
        reasoning: 'high',
        contextWindow: 128000,
        maxOutputTokens: 128000,
    },

    // -------------------------------------------------------------------------
    // GPT-5.3 General (6 variants - supports none/low/medium/high/xhigh)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5.3',
        name: 'GPT-5.3',
        description: 'GPT-5.3 general purpose model',
        baseModel: 'gpt-5.3',
        reasoning: 'none',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.3-low',
        name: 'GPT-5.3 (Low Reasoning)',
        baseModel: 'gpt-5.3',
        reasoning: 'low',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.3-medium',
        name: 'GPT-5.3 (Medium Reasoning)',
        baseModel: 'gpt-5.3',
        reasoning: 'medium',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.3-high',
        name: 'GPT-5.3 (High Reasoning)',
        baseModel: 'gpt-5.3',
        reasoning: 'high',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.3-xhigh',
        name: 'GPT-5.3 (XHigh Reasoning)',
        baseModel: 'gpt-5.3',
        reasoning: 'xhigh',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.3-none',
        name: 'GPT-5.3 (No Reasoning)',
        baseModel: 'gpt-5.3',
        reasoning: 'none',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },

    // -------------------------------------------------------------------------
    // GPT-5.2 General (5 variants)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5.2',
        name: 'GPT-5.2',
        description: 'GPT-5.2 general purpose model',
        baseModel: 'gpt-5.2',
        reasoning: 'none',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.2-low',
        name: 'GPT-5.2 (Low Reasoning)',
        baseModel: 'gpt-5.2',
        reasoning: 'low',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.2-medium',
        name: 'GPT-5.2 (Medium Reasoning)',
        baseModel: 'gpt-5.2',
        reasoning: 'medium',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.2-high',
        name: 'GPT-5.2 (High Reasoning)',
        baseModel: 'gpt-5.2',
        reasoning: 'high',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.2-xhigh',
        name: 'GPT-5.2 (XHigh Reasoning)',
        baseModel: 'gpt-5.2',
        reasoning: 'xhigh',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },

    // -------------------------------------------------------------------------
    // GPT-5.2 Codex (4 variants - no 'none' reasoning)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5.2-codex',
        name: 'GPT-5.2 Codex',
        description: 'GPT-5.2 Codex - advanced agentic coding model',
        baseModel: 'gpt-5.2-codex',
        reasoning: 'medium',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.2-codex-low',
        name: 'GPT-5.2 Codex (Low Reasoning)',
        baseModel: 'gpt-5.2-codex',
        reasoning: 'low',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.2-codex-high',
        name: 'GPT-5.2 Codex (High Reasoning)',
        baseModel: 'gpt-5.2-codex',
        reasoning: 'high',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.2-codex-xhigh',
        name: 'GPT-5.2 Codex (XHigh Reasoning)',
        baseModel: 'gpt-5.2-codex',
        reasoning: 'xhigh',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },

    // -------------------------------------------------------------------------
    // GPT-5.1 Codex Max (4 variants)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5.1-codex-max',
        name: 'GPT-5.1 Codex Max',
        description: 'GPT-5.1 Codex Max - long-running with compaction',
        baseModel: 'gpt-5.1-codex-max',
        reasoning: 'high',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.1-codex-max-low',
        name: 'GPT-5.1 Codex Max (Low Reasoning)',
        baseModel: 'gpt-5.1-codex-max',
        reasoning: 'low',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.1-codex-max-medium',
        name: 'GPT-5.1 Codex Max (Medium Reasoning)',
        baseModel: 'gpt-5.1-codex-max',
        reasoning: 'medium',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.1-codex-max-xhigh',
        name: 'GPT-5.1 Codex Max (XHigh Reasoning)',
        baseModel: 'gpt-5.1-codex-max',
        reasoning: 'xhigh',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },

    // -------------------------------------------------------------------------
    // GPT-5.1 Codex (3 variants)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5.1-codex',
        name: 'GPT-5.1 Codex',
        description: 'GPT-5.1 Codex - balanced coding model',
        baseModel: 'gpt-5.1-codex',
        reasoning: 'medium',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.1-codex-low',
        name: 'GPT-5.1 Codex (Low Reasoning)',
        baseModel: 'gpt-5.1-codex',
        reasoning: 'low',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.1-codex-high',
        name: 'GPT-5.1 Codex (High Reasoning)',
        baseModel: 'gpt-5.1-codex',
        reasoning: 'high',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },

    // -------------------------------------------------------------------------
    // GPT-5.1 Codex Mini (2 variants)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5.1-codex-mini',
        name: 'GPT-5.1 Codex Mini',
        description: 'GPT-5.1 Codex Mini - fast and efficient',
        baseModel: 'gpt-5.1-codex-mini',
        reasoning: 'medium',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.1-codex-mini-high',
        name: 'GPT-5.1 Codex Mini (High Reasoning)',
        baseModel: 'gpt-5.1-codex-mini',
        reasoning: 'high',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },

    // -------------------------------------------------------------------------
    // GPT-5.1 General (4 variants)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5.1',
        name: 'GPT-5.1',
        description: 'GPT-5.1 general purpose model',
        baseModel: 'gpt-5.1',
        reasoning: 'none',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.1-low',
        name: 'GPT-5.1 (Low Reasoning)',
        baseModel: 'gpt-5.1',
        reasoning: 'low',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.1-medium',
        name: 'GPT-5.1 (Medium Reasoning)',
        baseModel: 'gpt-5.1',
        reasoning: 'medium',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5.1-high',
        name: 'GPT-5.1 (High Reasoning)',
        baseModel: 'gpt-5.1',
        reasoning: 'high',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },

    // -------------------------------------------------------------------------
    // GPT-5 Codex (4 variants)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5-codex',
        name: 'GPT-5 Codex',
        description: 'GPT-5 Codex - original coding model',
        baseModel: 'gpt-5-codex',
        reasoning: 'medium',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5-codex-low',
        name: 'GPT-5 Codex (Low Reasoning)',
        baseModel: 'gpt-5-codex',
        reasoning: 'low',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5-codex-high',
        name: 'GPT-5 Codex (High Reasoning)',
        baseModel: 'gpt-5-codex',
        reasoning: 'high',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5-codex-xhigh',
        name: 'GPT-5 Codex (XHigh Reasoning)',
        baseModel: 'gpt-5-codex',
        reasoning: 'xhigh',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },

    // -------------------------------------------------------------------------
    // GPT-5 Codex Mini (2 variants)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5-codex-mini',
        name: 'GPT-5 Codex Mini',
        description: 'GPT-5 Codex Mini - lightweight coding model',
        baseModel: 'gpt-5-codex-mini',
        reasoning: 'medium',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5-codex-mini-high',
        name: 'GPT-5 Codex Mini (High Reasoning)',
        baseModel: 'gpt-5-codex-mini',
        reasoning: 'high',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },

    // -------------------------------------------------------------------------
    // GPT-5 General (4 variants)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-5',
        name: 'GPT-5',
        description: 'GPT-5 general purpose model',
        baseModel: 'gpt-5',
        reasoning: 'none',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5-low',
        name: 'GPT-5 (Low Reasoning)',
        baseModel: 'gpt-5',
        reasoning: 'low',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5-medium',
        name: 'GPT-5 (Medium Reasoning)',
        baseModel: 'gpt-5',
        reasoning: 'medium',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
    {
        id: 'gpt-5-high',
        name: 'GPT-5 (High Reasoning)',
        baseModel: 'gpt-5',
        reasoning: 'high',
        contextWindow: 400000,
        maxOutputTokens: 128000,
    },
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get model info by ID (searches active model list)
 */
export function getModelInfo(modelId: string): CodexModelInfo | undefined {
    const normalizedId = normalizeModelId(modelId);
    return getActiveModels().find(m => m.id === normalizedId);
}

/**
 * Alma can pass fully-qualified IDs such as
 * openai-codex-auth:openai-codex:gpt-5.5. Codex only accepts the slug.
 */
export function normalizeModelId(modelId: string): string {
    return modelId.includes(':') ? modelId.split(':').pop() || modelId : modelId;
}

/**
 * Get the base model ID for API calls
 * Strips the reasoning suffix to get the actual model name
 */
export function getBaseModelId(modelId: string): string {
    const model = getModelInfo(modelId);
    return model?.baseModel ?? normalizeModelId(modelId);
}

/**
 * Get the reasoning effort for a model
 */
export function getReasoningEffort(modelId: string): ReasoningEffort {
    const model = getModelInfo(modelId);
    return model?.reasoning ?? 'medium';
}

/**
 * Check if a model supports a specific reasoning level
 * Codex models don't support 'none' reasoning
 */
export function supportsReasoningLevel(modelId: string, level: ReasoningEffort): boolean {
    const baseModel = getBaseModelId(modelId);

    // Codex models don't support 'none' reasoning
    if (baseModel.includes('codex') && level === 'none') {
        return false;
    }

    // Mini and Spark models only support 'medium' and 'high'
    if (baseModel.includes('mini') || baseModel.includes('spark')) {
        return level === 'medium' || level === 'high';
    }

    return true;
}
