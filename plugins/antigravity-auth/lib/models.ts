/**
 * Antigravity Model Definitions
 *
 * Defines Claude and Gemini models available through Antigravity OAuth.
 * Matches Antigravity-Manager's model_mapping.rs exactly.
 */

import type { AntigravityModelInfo, ThinkingLevel, ImageSize } from './types';

// ============================================================================
// Model Mapping (matches Antigravity-Manager's CLAUDE_TO_GEMINI)
// ============================================================================

const MODEL_MAPPING: Record<string, string> = {
    // Direct support models
    'claude-opus-4-6-thinking': 'claude-opus-4-6-thinking',
    'claude-sonnet-4-5': 'claude-sonnet-4-5',
    'claude-sonnet-4-5-thinking': 'claude-sonnet-4-5-thinking',

    // Claude aliases
    'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5-thinking',
    'claude-3-5-sonnet-20241022': 'claude-sonnet-4-5',
    'claude-3-5-sonnet-20240620': 'claude-sonnet-4-5',
    'claude-opus-4': 'claude-opus-4-6-thinking',
    'claude-opus-4-5-20251101': 'claude-opus-4-6-thinking',
    'claude-haiku-4': 'claude-sonnet-4-5',
    'claude-3-haiku-20240307': 'claude-sonnet-4-5',
    'claude-haiku-4-5-20251001': 'claude-sonnet-4-5',

    // OpenAI protocol mapping (maps to Gemini)
    // All GPT-4 variants map to gemini-2.5-flash (matching Antigravity-Manager)
    'gpt-4': 'gemini-2.5-flash',
    'gpt-4-turbo': 'gemini-2.5-flash',
    'gpt-4-turbo-preview': 'gemini-2.5-flash',
    'gpt-4-0125-preview': 'gemini-2.5-flash',
    'gpt-4-1106-preview': 'gemini-2.5-flash',
    'gpt-4-0613': 'gemini-2.5-flash',
    'gpt-4o': 'gemini-2.5-flash',
    'gpt-4o-2024-05-13': 'gemini-2.5-flash',
    'gpt-4o-2024-08-06': 'gemini-2.5-flash',
    'gpt-4o-mini': 'gemini-2.5-flash',
    'gpt-4o-mini-2024-07-18': 'gemini-2.5-flash',
    'gpt-3.5-turbo': 'gemini-2.5-flash',
    'gpt-3.5-turbo-16k': 'gemini-2.5-flash',
    'gpt-3.5-turbo-0125': 'gemini-2.5-flash',
    'gpt-3.5-turbo-1106': 'gemini-2.5-flash',
    'gpt-3.5-turbo-0613': 'gemini-2.5-flash',

    // Gemini protocol mapping
    'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
    'gemini-2.5-flash-thinking': 'gemini-2.5-flash-thinking',
    // Gemini 3 Pro variants all map to gemini-3-pro-preview (matching Antigravity-Manager)
    'gemini-3-pro-low': 'gemini-3-pro-preview',
    'gemini-3-pro-high': 'gemini-3-pro-preview',
    'gemini-3-pro-preview': 'gemini-3-pro-preview',
    'gemini-3-pro': 'gemini-3-pro-preview',
    'gemini-2.5-flash': 'gemini-2.5-flash',
    'gemini-3-flash': 'gemini-3-flash',
    'gemini-3-pro-image': 'gemini-3-pro-image',
    'gemini-2.0-flash-exp': 'gemini-2.0-flash-exp',
    // Note: gemini-2.5-pro removed (matching Antigravity-Manager)
};

// Custom model mapping (user-defined, can be extended at runtime)
let customModelMapping: Record<string, string> = {};

/**
 * Set custom model mapping
 */
export function setCustomModelMapping(mapping: Record<string, string>): void {
    customModelMapping = { ...mapping };
}

/**
 * Get custom model mapping
 */
export function getCustomModelMapping(): Record<string, string> {
    return { ...customModelMapping };
}

/**
 * Wildcard match helper function
 * Supports simple * wildcard matching
 *
 * @example
 * - `gpt-4*` matches `gpt-4`, `gpt-4-turbo`, `gpt-4-0613`, etc.
 * - `claude-3-5-sonnet-*` matches all 3.5 sonnet versions
 * - `*-thinking` matches all models ending with `-thinking`
 */
function wildcardMatch(pattern: string, text: string): boolean {
    const starPos = pattern.indexOf('*');
    if (starPos === -1) {
        return pattern === text;
    }
    const prefix = pattern.slice(0, starPos);
    const suffix = pattern.slice(starPos + 1);
    return text.startsWith(prefix) && text.endsWith(suffix);
}

/**
 * Map model to target model (matches Antigravity-Manager's map_claude_model_to_gemini)
 */
export function mapModelToTarget(input: string): string {
    // 1. Check exact match in map
    if (MODEL_MAPPING[input]) {
        return MODEL_MAPPING[input];
    }

    // 2. Pass-through known prefixes (gemini-, -thinking) to support dynamic suffixes
    if (input.startsWith('gemini-') || input.includes('thinking')) {
        return input;
    }

    // 3. Fallback to default
    return 'claude-sonnet-4-5';
}

/**
 * Core model routing engine (matches Antigravity-Manager's resolve_model_route)
 * Priority: Exact match > Wildcard match > System default mapping
 *
 * @param originalModel Original model name
 * @returns Mapped target model name
 */
export function resolveModelRoute(originalModel: string): string {
    // 1. Exact match (highest priority) - check custom mapping first
    if (customModelMapping[originalModel]) {
        return customModelMapping[originalModel];
    }

    // 2. Wildcard match in custom mapping
    for (const [pattern, target] of Object.entries(customModelMapping)) {
        if (pattern.includes('*') && wildcardMatch(pattern, originalModel)) {
            return target;
        }
    }

    // 3. System default mapping
    return mapModelToTarget(originalModel);
}

/**
 * Get all supported model IDs (matches Antigravity-Manager's get_supported_models)
 */
export function getSupportedModelIds(): string[] {
    return Object.keys(MODEL_MAPPING);
}

/**
 * Get all dynamic models including custom mappings
 * (matches Antigravity-Manager's get_all_dynamic_models)
 */
export function getAllDynamicModelIds(): string[] {
    const modelIds = new Set<string>();

    // 1. Get all built-in mapping models
    for (const id of getSupportedModelIds()) {
        modelIds.add(id);
    }

    // 2. Get all custom mapping models
    for (const key of Object.keys(customModelMapping)) {
        modelIds.add(key);
    }

    // 3. Add common Gemini/image model IDs
    // Note: gemini-2.5-pro removed (matching Antigravity-Manager)
    modelIds.add('gemini-3-pro-low');
    modelIds.add('gemini-2.0-flash-exp');
    modelIds.add('gemini-2.5-flash');
    modelIds.add('gemini-3-flash');
    modelIds.add('gemini-3-pro-high');

    // 4. Generate all Image Gen Combinations (Issue #247)
    const base = 'gemini-3-pro-image';
    const resolutions = ['', '-2k', '-4k'];
    const ratios = ['', '-1x1', '-4x3', '-3x4', '-16x9', '-9x16', '-21x9'];

    for (const res of resolutions) {
        for (const ratio of ratios) {
            modelIds.add(`${base}${res}${ratio}`);
        }
    }

    const sorted = Array.from(modelIds).sort();
    return sorted;
}

// ============================================================================
// Model Definitions
// ============================================================================

export const ANTIGRAVITY_MODELS: AntigravityModelInfo[] = [
    // -------------------------------------------------------------------------
    // Claude Models (Thinking variants)
    // Budgets based on opencode-antigravity-auth: { low: 8192, medium: 16384, high: 32768 }
    // -------------------------------------------------------------------------
    {
        id: 'claude-sonnet-4-5-thinking',
        name: 'Claude Sonnet 4.5 (Thinking)',
        description: 'Claude Sonnet 4.5 with extended thinking enabled',
        baseModel: 'claude-sonnet-4-5-thinking',
        family: 'claude',
        thinking: 'medium',
        thinkingBudget: 16384,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-sonnet-4-5-thinking-high',
        name: 'Claude Sonnet 4.5 (High Thinking)',
        description: 'Claude Sonnet 4.5 with high thinking budget',
        baseModel: 'claude-sonnet-4-5-thinking',
        family: 'claude',
        thinking: 'high',
        thinkingBudget: 32768,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-sonnet-4-5-thinking-low',
        name: 'Claude Sonnet 4.5 (Low Thinking)',
        description: 'Claude Sonnet 4.5 with low thinking budget',
        baseModel: 'claude-sonnet-4-5-thinking',
        family: 'claude',
        thinking: 'low',
        thinkingBudget: 8192,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        description: 'Claude Sonnet 4.5 without thinking',
        baseModel: 'claude-sonnet-4-5',
        family: 'claude',
        thinking: 'none',
        contextWindow: 200000,
        maxOutputTokens: 8192,
    },

    // -------------------------------------------------------------------------
    // Claude Opus 4.6 (Thinking variants)
    // -------------------------------------------------------------------------
    {
        id: 'claude-opus-4-6-thinking',
        name: 'Claude Opus 4.6 (Thinking)',
        description: 'Claude Opus 4.6 with extended thinking enabled',
        baseModel: 'claude-opus-4-6-thinking',
        family: 'claude',
        thinking: 'medium',
        thinkingBudget: 16384,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-opus-4-6-thinking-high',
        name: 'Claude Opus 4.6 (High Thinking)',
        description: 'Claude Opus 4.6 with high thinking budget',
        baseModel: 'claude-opus-4-6-thinking',
        family: 'claude',
        thinking: 'high',
        thinkingBudget: 32768,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-opus-4-6-thinking-low',
        name: 'Claude Opus 4.6 (Low Thinking)',
        description: 'Claude Opus 4.6 with low thinking budget',
        baseModel: 'claude-opus-4-6-thinking',
        family: 'claude',
        thinking: 'low',
        thinkingBudget: 8192,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },

    // -------------------------------------------------------------------------
    // Claude Aliases (mapped to base models)
    // -------------------------------------------------------------------------
    {
        id: 'claude-sonnet-4-5-20250929',
        name: 'Claude Sonnet 4.5 (20250929)',
        description: 'Alias for Claude Sonnet 4.5 Thinking',
        baseModel: 'claude-sonnet-4-5-thinking',
        family: 'claude',
        thinking: 'medium',
        thinkingBudget: 16384,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet (20241022)',
        description: 'Alias for Claude Sonnet 4.5',
        baseModel: 'claude-sonnet-4-5',
        family: 'claude',
        thinking: 'none',
        contextWindow: 200000,
        maxOutputTokens: 8192,
    },
    {
        id: 'claude-3-5-sonnet-20240620',
        name: 'Claude 3.5 Sonnet (20240620)',
        description: 'Alias for Claude Sonnet 4.5',
        baseModel: 'claude-sonnet-4-5',
        family: 'claude',
        thinking: 'none',
        contextWindow: 200000,
        maxOutputTokens: 8192,
    },
    {
        id: 'claude-opus-4',
        name: 'Claude Opus 4',
        description: 'Alias for Claude Opus 4.6 Thinking',
        baseModel: 'claude-opus-4-6-thinking',
        family: 'claude',
        thinking: 'medium',
        thinkingBudget: 16384,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-opus-4-5-20251101',
        name: 'Claude Opus 4.5 (20251101)',
        description: 'Alias for Claude Opus 4.6 Thinking',
        baseModel: 'claude-opus-4-6-thinking',
        family: 'claude',
        thinking: 'medium',
        thinkingBudget: 16384,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-haiku-4',
        name: 'Claude Haiku 4',
        description: 'Alias for Claude Sonnet 4.5 (Haiku not available)',
        baseModel: 'claude-sonnet-4-5',
        family: 'claude',
        thinking: 'none',
        contextWindow: 200000,
        maxOutputTokens: 8192,
    },
    {
        id: 'claude-3-haiku-20240307',
        name: 'Claude 3 Haiku (20240307)',
        description: 'Alias for Claude Sonnet 4.5 (Haiku not available)',
        baseModel: 'claude-sonnet-4-5',
        family: 'claude',
        thinking: 'none',
        contextWindow: 200000,
        maxOutputTokens: 8192,
    },
    {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5 (20251001)',
        description: 'Alias for Claude Sonnet 4.5 (Haiku not available)',
        baseModel: 'claude-sonnet-4-5',
        family: 'claude',
        thinking: 'none',
        contextWindow: 200000,
        maxOutputTokens: 8192,
    },

    // -------------------------------------------------------------------------
    // OpenAI Aliases (mapped to Gemini models)
    // All GPT models map to gemini-2.5-flash (matching Antigravity-Manager)
    // -------------------------------------------------------------------------
    {
        id: 'gpt-4',
        name: 'GPT-4',
        description: 'Maps to Gemini 2.5 Flash',
        baseModel: 'gemini-2.5-flash',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
    {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        description: 'Maps to Gemini 2.5 Flash',
        baseModel: 'gemini-2.5-flash',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
    {
        id: 'gpt-4-turbo-preview',
        name: 'GPT-4 Turbo Preview',
        description: 'Maps to Gemini 2.5 Flash',
        baseModel: 'gemini-2.5-flash',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
    {
        id: 'gpt-4o',
        name: 'GPT-4o',
        description: 'Maps to Gemini 2.5 Flash',
        baseModel: 'gemini-2.5-flash',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
    {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        description: 'Maps to Gemini 2.5 Flash',
        baseModel: 'gemini-2.5-flash',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
    {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
        description: 'Maps to Gemini 2.5 Flash',
        baseModel: 'gemini-2.5-flash',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },

    // -------------------------------------------------------------------------
    // Gemini 2.0 Models
    // -------------------------------------------------------------------------
    {
        id: 'gemini-2.0-flash-exp',
        name: 'Gemini 2.0 Flash Exp',
        baseModel: 'gemini-2.0-flash-exp',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },

    // -------------------------------------------------------------------------
    // Gemini 2.5 Models
    // Note: gemini-2.5-pro removed (matching Antigravity-Manager)
    // -------------------------------------------------------------------------
    {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        baseModel: 'gemini-2.5-flash',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
    {
        id: 'gemini-2.5-flash-lite',
        name: 'Gemini 2.5 Flash Lite',
        baseModel: 'gemini-2.5-flash-lite',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
    {
        id: 'gemini-2.5-flash-thinking',
        name: 'Gemini 2.5 Flash Thinking',
        baseModel: 'gemini-2.5-flash-thinking',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },

    // -------------------------------------------------------------------------
    // Gemini 3.0 Models
    // All Gemini 3 Pro variants map to gemini-3-pro-preview (matching Antigravity-Manager)
    // -------------------------------------------------------------------------
    {
        id: 'gemini-3-pro',
        name: 'Gemini 3 Pro',
        description: 'Maps to Gemini 3 Pro Preview',
        baseModel: 'gemini-3-pro-preview',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
    {
        id: 'gemini-3-pro-low',
        name: 'Gemini 3 Pro Low',
        description: 'Maps to Gemini 3 Pro Preview',
        baseModel: 'gemini-3-pro-preview',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
    {
        id: 'gemini-3-pro-high',
        name: 'Gemini 3 Pro High',
        description: 'Maps to Gemini 3 Pro Preview',
        baseModel: 'gemini-3-pro-preview',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
    {
        id: 'gemini-3-pro-preview',
        name: 'Gemini 3 Pro Preview',
        baseModel: 'gemini-3-pro-preview',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
    {
        id: 'gemini-3-flash',
        name: 'Gemini 3 Flash',
        baseModel: 'gemini-3-flash',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },

    // -------------------------------------------------------------------------
    // Gemini 3 Pro Image Models
    // Dynamically generated combinations of resolution and aspect ratio
    // Matches Antigravity-Manager format
    // -------------------------------------------------------------------------
    ...generateImageModels(),
];

/**
 * Generate all Gemini 3 Pro Image model variants
 * Combinations: resolutions × ratios = 3 × 7 = 21 models
 */
function generateImageModels(): AntigravityModelInfo[] {
    const base = 'gemini-3-pro-image';
    const resolutions = ['', '-2k', '-4k'] as const;
    const ratios = ['', '-1x1', '-4x3', '-3x4', '-16x9', '-9x16', '-21x9'] as const;

    const resolutionLabels: Record<string, string> = {
        '': '',
        '-2k': '2K ',
        '-4k': '4K ',
    };

    const ratioLabels: Record<string, string> = {
        '': '', // Empty = default (no explicit ratio), different from '-1x1' which is explicit 1:1
        '-1x1': '1:1',
        '-4x3': '4:3',
        '-3x4': '3:4',
        '-16x9': '16:9',
        '-9x16': '9:16',
        '-21x9': '21:9',
    };

    const models: AntigravityModelInfo[] = [];

    for (const res of resolutions) {
        for (const ratio of ratios) {
            const id = `${base}${res}${ratio}`;
            const resLabel = resolutionLabels[res];
            const ratioLabel = ratioLabels[ratio];
            // Build name parts, filtering out empty strings
            // e.g., "Gemini 3 Pro (Image 4K 16:9)" or "Gemini 3 Pro (Image)" for default
            const nameParts = ['Image', resLabel.trim(), ratioLabel].filter(Boolean);
            const name = `Gemini 3 Pro (${nameParts.join(' ')})`;

            models.push({
                id,
                name,
                baseModel: base,
                family: 'gemini',
                contextWindow: 1048576,
                maxOutputTokens: 65536,
                imageOutput: true,
                functionCalling: true,
                reasoning: true,
            });
        }
    }

    return models;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Strip provider prefix from model ID (e.g., "antigravity:claude-sonnet-4-5" -> "claude-sonnet-4-5")
 */
export function stripProviderPrefix(modelId: string): string {
    const colonIndex = modelId.indexOf(':');
    if (colonIndex !== -1) {
        return modelId.slice(colonIndex + 1);
    }
    return modelId;
}

/**
 * Get model info by ID
 */
export function getModelInfo(modelId: string): AntigravityModelInfo | undefined {
    const cleanId = stripProviderPrefix(modelId);
    return ANTIGRAVITY_MODELS.find((m) => m.id === cleanId);
}

/**
 * Get the base model ID for API calls (with routing support)
 */
export function getBaseModelId(modelId: string): string {
    const cleanId = stripProviderPrefix(modelId);

    // First check if we have model info
    const model = getModelInfo(cleanId);
    if (model) {
        return model.baseModel;
    }

    // Use model routing for unknown models
    return resolveModelRoute(cleanId);
}

/**
 * Get model family (claude or gemini)
 */
export function getModelFamily(modelId: string): 'claude' | 'gemini' {
    const cleanId = stripProviderPrefix(modelId);
    const model = getModelInfo(cleanId);
    if (model) {
        return model.family;
    }

    // Use routing to determine family
    const resolved = resolveModelRoute(cleanId);
    if (resolved.includes('claude')) {
        return 'claude';
    }
    return 'gemini';
}

/**
 * Check if model is a Claude thinking model
 */
export function isClaudeThinkingModel(modelId: string): boolean {
    const cleanId = stripProviderPrefix(modelId);
    const model = getModelInfo(cleanId);
    if (model) {
        return model.family === 'claude' && model.thinking !== 'none' && model.thinking !== undefined;
    }
    // Fallback detection from model ID
    const lower = cleanId.toLowerCase();
    return lower.includes('claude') && lower.includes('thinking');
}

/**
 * Get thinking budget for a model
 */
export function getThinkingBudget(modelId: string): number | undefined {
    const cleanId = stripProviderPrefix(modelId);
    const model = getModelInfo(cleanId);
    return model?.thinkingBudget;
}

/**
 * Get thinking level for a model
 */
export function getThinkingLevel(modelId: string): ThinkingLevel {
    const cleanId = stripProviderPrefix(modelId);
    const model = getModelInfo(cleanId);
    return model?.thinking ?? 'none';
}

/**
 * Check if a model is an image generation model
 */
export function isImageModel(modelId: string): boolean {
    const cleanId = stripProviderPrefix(modelId);
    const model = getModelInfo(cleanId);
    if (model) {
        return model.imageOutput === true;
    }
    // Fallback detection from model ID
    return cleanId.toLowerCase().includes('gemini-3-pro-image');
}

/**
 * Parse image size from model ID (matches Antigravity-Manager logic)
 * Uses 'contains' matching like Antigravity-Manager
 * e.g., 'gemini-3-pro-image-4k' -> '4K'
 * e.g., 'gemini-3-pro-image-hd' -> '4K'
 * e.g., 'gemini-3-pro-image-2k' -> '2K'
 * e.g., 'gemini-3-pro-image-2k-16x9' -> '2K'
 */
export function parseImageSize(modelId: string): ImageSize | undefined {
    const cleanId = stripProviderPrefix(modelId).toLowerCase();

    // -4k and -hd both map to '4K' (matches Antigravity-Manager)
    if (cleanId.includes('-4k') || cleanId.includes('-hd')) {
        return '4K';
    }
    if (cleanId.includes('-2k')) {
        return '2K';
    }

    return undefined;
}

/**
 * Parse aspect ratio from image model ID (matches Antigravity-Manager logic)
 * Uses 'contains' matching like Antigravity-Manager
 * e.g., 'gemini-3-pro-image-16x9' -> '16:9'
 * e.g., 'gemini-3-pro-image-2k-16x9' -> '16:9'
 */
export function parseImageAspectRatio(modelId: string): string {
    const cleanId = stripProviderPrefix(modelId).toLowerCase();

    // Check aspect ratio patterns (matches Antigravity-Manager)
    if (cleanId.includes('-21x9') || cleanId.includes('-21-9')) return '21:9';
    if (cleanId.includes('-16x9') || cleanId.includes('-16-9')) return '16:9';
    if (cleanId.includes('-9x16') || cleanId.includes('-9-16')) return '9:16';
    if (cleanId.includes('-4x3') || cleanId.includes('-4-3')) return '4:3';
    if (cleanId.includes('-3x4') || cleanId.includes('-3-4')) return '3:4';
    if (cleanId.includes('-1x1') || cleanId.includes('-1-1')) return '1:1';

    // Default aspect ratio
    return '1:1';
}

/**
 * Parse model ID with tier suffix (e.g., claude-sonnet-4-5-thinking-high)
 * Returns the base model and thinking tier
 */
export function parseModelWithTier(modelId: string): {
    baseModel: string;
    thinkingLevel: ThinkingLevel;
    thinkingBudget?: number;
} {
    const cleanId = stripProviderPrefix(modelId);
    const model = getModelInfo(cleanId);
    if (model) {
        return {
            baseModel: model.baseModel,
            thinkingLevel: model.thinking ?? 'none',
            thinkingBudget: model.thinkingBudget,
        };
    }

    // Fallback: try to parse tier suffix (budgets match opencode-antigravity-auth)
    const tierMap: Record<string, { level: ThinkingLevel; budget: number }> = {
        '-high': { level: 'high', budget: 32768 },
        '-medium': { level: 'medium', budget: 16384 },
        '-low': { level: 'low', budget: 8192 },
    };

    for (const [suffix, config] of Object.entries(tierMap)) {
        if (cleanId.endsWith(suffix)) {
            return {
                baseModel: cleanId.slice(0, -suffix.length),
                thinkingLevel: config.level,
                thinkingBudget: config.budget,
            };
        }
    }

    return {
        baseModel: cleanId,
        thinkingLevel: 'none',
    };
}
