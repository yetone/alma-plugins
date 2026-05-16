/**
 * Codex Instructions Fetcher
 *
 * Fetches Codex system prompts from GitHub with ETag-based caching.
 * Matches opencode-openai-codex-auth implementation exactly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Constants
// ============================================================================

const GITHUB_API_RELEASES = 'https://api.github.com/repos/openai/codex/releases/latest';
const GITHUB_HTML_RELEASES = 'https://github.com/openai/codex/releases/latest';
const CACHE_DIR = join(homedir(), '.alma', 'cache', 'codex');
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Model family type for prompt selection
 */
export type ModelFamily = 'gpt-5.5' | 'gpt-5.4' | 'gpt-5.3-codex' | 'gpt-5.3' | 'gpt-5.2-codex' | 'codex-max' | 'codex' | 'gpt-5.2' | 'gpt-5.1';

/**
 * Prompt file mapping for each model family
 * Note: GPT-5.4 and GPT-5.3 use the generic prompt.md since no model-specific
 * prompt files exist in the Codex CLI releases for these models.
 */
const PROMPT_FILES: Record<ModelFamily, string> = {
    'gpt-5.5': 'prompt.md',
    'gpt-5.4': 'prompt.md',
    'gpt-5.3-codex': 'gpt-5.3-codex_prompt.md',
    'gpt-5.3': 'prompt.md',
    'gpt-5.2-codex': 'gpt-5.2-codex_prompt.md',
    'codex-max': 'gpt-5.1-codex-max_prompt.md',
    codex: 'gpt_5_codex_prompt.md',
    'gpt-5.2': 'gpt_5_2_prompt.md',
    'gpt-5.1': 'gpt_5_1_prompt.md',
};

/**
 * Cache file mapping for each model family
 */
const CACHE_FILES: Record<ModelFamily, string> = {
    'gpt-5.5': 'gpt-5.5-instructions.md',
    'gpt-5.4': 'gpt-5.4-instructions.md',
    'gpt-5.3-codex': 'gpt-5.3-codex-instructions.md',
    'gpt-5.3': 'gpt-5.3-instructions.md',
    'gpt-5.2-codex': 'gpt-5.2-codex-instructions.md',
    'codex-max': 'codex-max-instructions.md',
    codex: 'codex-instructions.md',
    'gpt-5.2': 'gpt-5.2-instructions.md',
    'gpt-5.1': 'gpt-5.1-instructions.md',
};

interface CacheMetadata {
    etag: string | null;
    tag: string | null;
    lastChecked: number;
    url: string;
}

// ============================================================================
// Model Family Detection
// ============================================================================

/**
 * Determine the model family based on the normalized model name
 */
export function getModelFamily(normalizedModel: string): ModelFamily {
    // Order matters - check more specific patterns first
    if (normalizedModel.includes('gpt-5.5') || normalizedModel.includes('gpt 5.5')) {
        return 'gpt-5.5';
    }
    if (normalizedModel.includes('gpt-5.4') || normalizedModel.includes('gpt 5.4')) {
        return 'gpt-5.4';
    }
    if (
        normalizedModel.includes('gpt-5.3-codex') ||
        normalizedModel.includes('gpt 5.3 codex')
    ) {
        return 'gpt-5.3-codex';
    }
    if (normalizedModel.includes('gpt-5.3') || normalizedModel.includes('gpt 5.3')) {
        return 'gpt-5.3';
    }
    if (
        normalizedModel.includes('gpt-5.2-codex') ||
        normalizedModel.includes('gpt 5.2 codex')
    ) {
        return 'gpt-5.2-codex';
    }
    if (normalizedModel.includes('codex-max')) {
        return 'codex-max';
    }
    if (
        normalizedModel.includes('codex') ||
        normalizedModel.startsWith('codex-')
    ) {
        return 'codex';
    }
    if (normalizedModel.includes('gpt-5.2')) {
        return 'gpt-5.2';
    }
    return 'gpt-5.1';
}

// ============================================================================
// GitHub Release Fetching
// ============================================================================

interface GitHubRelease {
    tag_name?: string;
}

/**
 * Get the latest release tag from GitHub
 */
async function getLatestReleaseTag(): Promise<string> {
    try {
        const response = await fetch(GITHUB_API_RELEASES);
        if (response.ok) {
            const data = (await response.json()) as GitHubRelease;
            if (data.tag_name) {
                return data.tag_name;
            }
        }
    } catch {
        // Fall through to HTML fallback
    }

    // Fallback: parse from HTML redirect
    const htmlResponse = await fetch(GITHUB_HTML_RELEASES);
    if (!htmlResponse.ok) {
        throw new Error(`Failed to fetch latest release: ${htmlResponse.status}`);
    }

    const finalUrl = htmlResponse.url;
    if (finalUrl) {
        const parts = finalUrl.split('/tag/');
        const last = parts[parts.length - 1];
        if (last && !last.includes('/')) {
            return last;
        }
    }

    const html = await htmlResponse.text();
    const match = html.match(/\/openai\/codex\/releases\/tag\/([^"]+)/);
    if (match && match[1]) {
        return match[1];
    }

    throw new Error('Failed to determine latest release tag from GitHub');
}

// ============================================================================
// Instructions Fetching with Cache
// ============================================================================

/**
 * Fetch Codex instructions from GitHub with ETag-based caching
 * Matches opencode-openai-codex-auth implementation exactly.
 *
 * @param normalizedModel - The normalized model name
 * @returns Codex instructions for the specified model family
 */
export async function getCodexInstructions(normalizedModel = 'gpt-5.1-codex'): Promise<string> {
    const modelFamily = getModelFamily(normalizedModel);
    const promptFile = PROMPT_FILES[modelFamily];
    const cacheFile = join(CACHE_DIR, CACHE_FILES[modelFamily]);
    const cacheMetaFile = join(CACHE_DIR, `${CACHE_FILES[modelFamily].replace('.md', '-meta.json')}`);

    try {
        // Load cached metadata
        let cachedETag: string | null = null;
        let cachedTag: string | null = null;
        let cachedTimestamp: number | null = null;

        if (existsSync(cacheMetaFile)) {
            const metadata = JSON.parse(readFileSync(cacheMetaFile, 'utf8')) as CacheMetadata;
            cachedETag = metadata.etag;
            cachedTag = metadata.tag;
            cachedTimestamp = metadata.lastChecked;
        }

        // Rate limit protection: If cache is less than 15 minutes old, use it
        if (
            cachedTimestamp &&
            Date.now() - cachedTimestamp < CACHE_TTL_MS &&
            existsSync(cacheFile)
        ) {
            return readFileSync(cacheFile, 'utf8');
        }

        // Get the latest release tag
        const latestTag = await getLatestReleaseTag();
        const CODEX_INSTRUCTIONS_URL = `https://raw.githubusercontent.com/openai/codex/${latestTag}/codex-rs/core/${promptFile}`;

        // If tag changed, force re-fetch
        if (cachedTag !== latestTag) {
            cachedETag = null;
        }

        // Make conditional request with If-None-Match header
        const headers: Record<string, string> = {};
        if (cachedETag) {
            headers['If-None-Match'] = cachedETag;
        }

        const response = await fetch(CODEX_INSTRUCTIONS_URL, { headers });

        // 304 Not Modified - cached version is still current
        if (response.status === 304) {
            if (existsSync(cacheFile)) {
                // Update lastChecked timestamp
                const metadata: CacheMetadata = {
                    etag: cachedETag,
                    tag: latestTag,
                    lastChecked: Date.now(),
                    url: CODEX_INSTRUCTIONS_URL,
                };
                writeFileSync(cacheMetaFile, JSON.stringify(metadata), 'utf8');
                return readFileSync(cacheFile, 'utf8');
            }
        }

        // 200 OK - new content or first fetch
        if (response.ok) {
            const instructions = await response.text();
            const newETag = response.headers.get('etag');

            // Create cache directory if needed
            if (!existsSync(CACHE_DIR)) {
                mkdirSync(CACHE_DIR, { recursive: true });
            }

            // Cache the instructions
            writeFileSync(cacheFile, instructions, 'utf8');
            writeFileSync(
                cacheMetaFile,
                JSON.stringify({
                    etag: newETag,
                    tag: latestTag,
                    lastChecked: Date.now(),
                    url: CODEX_INSTRUCTIONS_URL,
                } satisfies CacheMetadata),
                'utf8'
            );

            return instructions;
        }

        throw new Error(`HTTP ${response.status}`);
    } catch (error) {
        const err = error as Error;
        console.error(`[openai-codex-auth] Failed to fetch ${modelFamily} instructions:`, err.message);

        // Try to use cached version even if stale
        if (existsSync(cacheFile)) {
            console.error(`[openai-codex-auth] Using cached ${modelFamily} instructions`);
            return readFileSync(cacheFile, 'utf8');
        }

        // Return empty string if no cache available
        // The model will work without instructions, just with default behavior
        console.error(`[openai-codex-auth] No cached instructions available for ${modelFamily}`);
        return '';
    }
}
