/**
 * Qwen Model Definitions
 *
 * Defines the available Qwen models and their capabilities.
 * Based on CLIProxyAPI's GetQwenModels() function.
 * 
 * Note: Only models supported by Qwen OAuth are included here.
 * Other models like qwen3-max are available via iFlow provider, not Qwen OAuth.
 */

import type { QwenModelInfo } from './types';

// ============================================================================
// Model Definitions (from CLIProxyAPI GetQwenModels)
// ============================================================================

export const QWEN_MODELS: QwenModelInfo[] = [
    // Qwen3 Coder Models
    {
        id: 'qwen3-coder-plus',
        name: 'Qwen3 Coder Plus',
        description: 'Advanced code generation and understanding model',
        baseModel: 'qwen3-coder-plus',
        contextWindow: 32768,
        maxOutputTokens: 8192,
        functionCalling: true,
    },
    {
        id: 'qwen3-coder-flash',
        name: 'Qwen3 Coder Flash',
        description: 'Fast code generation model',
        baseModel: 'qwen3-coder-flash',
        contextWindow: 8192,
        maxOutputTokens: 2048,
        functionCalling: true,
    },

    // Qwen3 Vision Model
    {
        id: 'vision-model',
        name: 'Qwen3 Vision Model',
        description: 'Vision model for image understanding',
        baseModel: 'vision-model',
        contextWindow: 32768,
        maxOutputTokens: 2048,
        vision: true,
        functionCalling: true,
    },
];

// ============================================================================
// Model Helpers
// ============================================================================

/**
 * Get model info by ID
 */
export function getModelById(modelId: string): QwenModelInfo | undefined {
    return QWEN_MODELS.find(m => m.id === modelId);
}

/**
 * Check if a model supports vision
 */
export function isVisionModel(modelId: string): boolean {
    const model = getModelById(modelId);
    return model?.vision ?? false;
}

/**
 * Check if a model supports reasoning/thinking
 */
export function isReasoningModel(modelId: string): boolean {
    const model = getModelById(modelId);
    return model?.reasoning ?? false;
}

/**
 * Get the base model ID for API calls
 */
export function getBaseModel(modelId: string): string {
    const model = getModelById(modelId);
    return model?.baseModel ?? modelId;
}
