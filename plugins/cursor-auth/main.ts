/**
 * Cursor Auth Plugin for Alma
 *
 * Enables using Cursor subscription models (Claude, GPT, Gemini, etc.)
 * inside Alma via OAuth authentication. This plugin registers a custom
 * provider that handles authentication and API calls to the Cursor backend.
 *
 * IMPORTANT: This follows the same pattern as openai-codex-auth:
 * - Plugin returns { apiKey, baseURL, fetch } configuration
 * - Custom fetch wrapper handles gRPC translation, OAuth headers, etc.
 * - AI SDK handles all request/response logic using the provided config
 *
 * DISCLAIMER: This plugin is for personal development use only with your
 * own Cursor subscription. Not for commercial resale or multi-user services.
 */

import type { PluginContext, PluginActivation } from 'alma-plugin-api';
import { TokenStore } from './lib/token-store';
import { generateCursorAuthParams, pollCursorAuth, getTokenExpiry } from './lib/auth';
import { getCursorModels, getFallbackModels, collapseCursorModels, hydrateCatalog, setCatalogListener } from './lib/models';
import { startProxy, stopProxy, createProxyFetch } from './lib/cursor-fetch';
import type { CursorModel } from './lib/types';

const DUMMY_API_KEY = 'cursor-proxy';
const MODELS_CACHE_KEY = 'cursor-model-catalog-v1';

// ============================================================================
// Plugin Activation
// ============================================================================

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, storage, providers, commands, ui } = context;

    logger.info('Cursor Auth plugin activating...');

    // Initialize token store
    const tokenStore = new TokenStore(storage.secrets, logger);
    await tokenStore.initialize();

    // Persist every fresh catalog and hydrate the last one on startup, so
    // request-time variant resolution (collapsed id + reasoning effort →
    // concrete Cursor slug) works before the first live fetch lands.
    setCatalogListener(models => {
        void storage.local.set(MODELS_CACHE_KEY, models).catch((err: unknown) => logger.warn('Failed to persist Cursor model catalog:', err));
    });
    const catalogHydration: Promise<void> = (async () => {
        try {
            const persisted = await storage.local.get<CursorModel[]>(MODELS_CACHE_KEY);
            hydrateCatalog(persisted);
            if (Array.isArray(persisted) && persisted.length > 0) {
                logger.info(`Hydrated ${persisted.length} Cursor models from storage`);
            }
        } catch (err) {
            logger.warn('Failed to hydrate Cursor model catalog from storage:', err);
        }
    })();

    /**
     * Map the raw catalog to picker entries: effort/thinking variants collapse
     * into one entry per family whose tier is driven by the composer's
     * model-aware thinking selector (capabilities.reasoningLevels).
     */
    const toProviderModels = (models: CursorModel[]) =>
        collapseCursorModels(models).map(model => ({
            id: model.id,
            name: model.name,
            description:
                model.variantCount > 1
                    ? `Cursor: ${model.name} — ${model.variantCount} effort variants merged; the thinking selector picks the tier`
                    : `Cursor: ${model.name}${model.reasoning ? ' (reasoning)' : ''}`,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxTokens,
            capabilities: {
                temperature: true,
                streaming: true,
                reasoning: model.reasoning,
                attachment: false,
                functionCalling: true,
                // Per-model thinking levels so the composer renders a
                // model-aware effort selector (same contract as codex plugin).
                ...(model.reasoningLevels ? { reasoningLevels: model.reasoningLevels } : {}),
                input: {
                    text: true,
                    audio: false,
                    image: true,
                    video: false,
                    pdf: false,
                },
                output: {
                    text: true,
                    audio: false,
                    image: false,
                    video: false,
                    pdf: false,
                },
            },
        }));

    // Proxy port (set when proxy starts)
    let currentProxyPort: number | undefined;

    const ensureProxy = async (): Promise<number> => {
        if (currentProxyPort) return currentProxyPort;
        currentProxyPort = await startProxy(
            () => tokenStore.getValidAccessToken(),
            logger,
        );
        return currentProxyPort;
    };

    // =========================================================================
    // Register Provider
    // =========================================================================

    const providerDisposable = providers.register({
        id: 'cursor',
        name: 'Cursor',
        description: 'Access Claude, GPT, Gemini and other models via your Cursor subscription',
        authType: 'oauth',
        sdkType: 'openai-compatible',

        async initialize() {
            logger.info('Cursor provider initialized');
        },

        async isAuthenticated() {
            return tokenStore.hasValidToken();
        },

        async authenticate() {
            try {
                const { verifier, uuid, loginUrl } = await generateCursorAuthParams();

                ui.showNotification('Opening browser for Cursor login...', { type: 'info' });

                // Start OAuth flow — Cursor uses poll-based auth (no callback redirect)
                // Open browser and poll for login completion
                logger.info('Starting Cursor OAuth flow...');
                // Through the host: on alma-server (no browser) it hands the link
                // to the web UI so the user opens it on their own computer.
                if (!(await ui.openExternal(loginUrl))) openBrowser(loginUrl);

                ui.showNotification('Waiting for Cursor login to complete...', { type: 'info' });

                const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier);

                await tokenStore.saveTokens({
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    expires_at: getTokenExpiry(accessToken),
                });

                ui.showNotification('Successfully connected to Cursor!', { type: 'success' });
                logger.info('Cursor authentication successful');

                return { success: true };
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Authentication failed';
                logger.error('Cursor authentication error:', error);
                ui.showError(`Authentication failed: ${message}`);
                return { success: false, error: message };
            }
        },

        async logout() {
            await tokenStore.clearTokens();
            ui.showNotification('Logged out from Cursor', { type: 'info' });
            logger.info('Cursor logout successful');
        },

        async getModels() {
            await catalogHydration;
            const tokens = tokenStore.getTokens();
            const models = tokens
                ? await getCursorModels(tokens.access_token).catch(() => getFallbackModels())
                : getFallbackModels();

            return toProviderModels(models);
        },

        async fetchModels() {
            logger.info('Fetching available models from Cursor API...');
            try {
                await catalogHydration;
                const accessToken = await tokenStore.getValidAccessToken();
                const models = await getCursorModels(accessToken);
                const collapsed = toProviderModels(models);
                logger.info(`Fetched ${models.length} models from Cursor API (collapsed to ${collapsed.length} picker entries)`);
                return collapsed;
            } catch (error) {
                logger.error('Error fetching models:', error);
                return this.getModels();
            }
        },

        /**
         * Returns SDK configuration for AI SDK.
         * Follows opencode-cursor's pattern exactly:
         * - Start local proxy server that translates OpenAI -> Cursor gRPC
         * - baseURL points to localhost proxy
         * - fetch strips auth headers (proxy handles auth internally)
         */
        async getSDKConfig() {
            // Variant resolution in the proxy needs the catalog — make sure the
            // persisted one is loaded before the first request can race it.
            await catalogHydration;
            const port = await ensureProxy();
            return {
                apiKey: DUMMY_API_KEY,
                baseURL: `http://localhost:${port}/v1`,
                fetch: createProxyFetch(),
            };
        },
    } as any);

    // =========================================================================
    // Register Commands
    // =========================================================================

    const loginCommand = commands.register('login', async () => {
        ui.showNotification('Use the provider settings to connect to Cursor', { type: 'info' });
    });

    const logoutCommand = commands.register('logout', async () => {
        await tokenStore.clearTokens();
        ui.showNotification('Logged out from Cursor', { type: 'info' });
    });

    const statusCommand = commands.register('status', async () => {
        const isAuth = tokenStore.hasValidToken();
        if (isAuth) {
            ui.showNotification('Connected to Cursor', { type: 'success' });
        } else {
            ui.showNotification('Not connected to Cursor', { type: 'warning' });
        }
    });

    logger.info('Cursor Auth plugin activated');

    // =========================================================================
    // Cleanup
    // =========================================================================

    return {
        dispose: () => {
            stopProxy();
            providerDisposable.dispose();
            loginCommand.dispose();
            logoutCommand.dispose();
            statusCommand.dispose();
            logger.info('Cursor Auth plugin deactivated');
        },
    };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Open a URL in the default browser.
 */
function openBrowser(url: string): void {
    const { exec } = require('node:child_process');
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open'
        : platform === 'win32' ? 'start'
        : 'xdg-open';
    exec(`${cmd} "${url}"`);
}
