/**
 * xAI Grok Auth Plugin for Alma
 *
 * Enables using a SuperGrok subscription to access Grok models via OAuth,
 * mirroring OpenCode's built-in xai plugin: after login the standard xAI API
 * (https://api.x.ai/v1, OpenAI-compatible) is called with the subscription's
 * OAuth access token injected as the Bearer credential.
 *
 * DISCLAIMER: This plugin is for personal use with your own SuperGrok
 * subscription. Not for commercial resale or multi-user services.
 */

import type { PluginContext, PluginActivation } from 'alma-plugin-api';
import { TokenStore } from './lib/token-store';
import {
    getAuthorizationUrl,
    exchangeCodeForTokens,
    OAUTH_PORT,
    OAUTH_CALLBACK_PATH,
    CORS_ORIGINS,
} from './lib/auth';
import { getActiveModels, setCachedModels, isCatalogCached, buildModelsFromApiResponse, type XaiModel } from './lib/models';
import { fetchUserInfo, avatarUrlForEmail } from './lib/profile';
import { quotaFromHeaders } from './lib/rate-limits';

const XAI_BASE_URL = 'https://api.x.ai/v1';
const DUMMY_API_KEY = 'xai-oauth';

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, storage, providers, commands, ui } = context;

    logger.info('xAI Grok Auth plugin activating...');

    const tokenStore = new TokenStore(storage.secrets, logger);
    await tokenStore.initialize();

    // =========================================================================
    // Profile (email / name / avatar) — best-effort, never throws
    // =========================================================================

    /**
     * Resolve the account profile: OIDC userinfo first, JWT claims as
     * fallback, Gravatar when neither carries a picture.
     */
    const refreshProfile = async (): Promise<void> => {
        try {
            if (!tokenStore.hasTokens()) return;
            const accessToken = await tokenStore.getValidAccessToken();

            const profile = (await fetchUserInfo(accessToken, logger)) ?? tokenStore.getIdTokenClaims() ?? {};
            if (!profile.picture && profile.email) {
                const gravatar = await avatarUrlForEmail(profile.email);
                if (gravatar) profile.picture = gravatar;
            }
            if (profile.email || profile.name || profile.picture) {
                await tokenStore.setProfile(profile);
            }
        } catch (error) {
            logger.warn('[xai profile] refresh failed:', error);
        }
    };

    // Warm the profile cache in the background for pre-existing logins so the
    // settings page shows the email the first time it renders.
    if (tokenStore.hasTokens() && !tokenStore.getProfile()?.email) {
        void refreshProfile();
    }

    // =========================================================================
    // Quota — captured opportunistically from api.x.ai rate-limit headers
    // =========================================================================

    const captureQuota = (response: Response): void => {
        try {
            const quota = quotaFromHeaders(response.headers, response.status);
            if (quota) {
                void tokenStore.setQuota(quota).catch(() => {});
            }
        } catch {
            // Quota capture must never interfere with the request path.
        }
    };

    // =========================================================================
    // Custom Fetch Wrapper
    // =========================================================================

    /**
     * Injects the OAuth Bearer token into every request. No URL rewriting or
     * body transformation is needed — subscription tokens are accepted by the
     * standard OpenAI-compatible xAI API.
     */
    const createXaiFetch = (): typeof globalThis.fetch => {
        return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const accessToken = await tokenStore.getValidAccessToken();

            const headers = new Headers(init?.headers ?? {});
            headers.delete('x-api-key');
            headers.set('Authorization', `Bearer ${accessToken}`);

            let response = await globalThis.fetch(input, { ...init, headers });

            // The server can invalidate an access token before its local
            // expiry. On 401, force a refresh and retry the request once.
            if (response.status === 401) {
                const errText = await response
                    .clone()
                    .text()
                    .catch(() => '');
                logger.warn(`xAI API 401, forcing token refresh and retrying once: ${errText.slice(0, 200)}`);
                try {
                    const newToken = await tokenStore.forceRefreshAccessToken();
                    headers.set('Authorization', `Bearer ${newToken}`);
                    response = await globalThis.fetch(input, { ...init, headers });
                } catch (refreshErr) {
                    logger.error('Forced xAI token refresh failed:', refreshErr);
                }
            }

            captureQuota(response);
            return response;
        };
    };

    // =========================================================================
    // Model helpers
    // =========================================================================

    const toProviderModel = (model: XaiModel) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: {
            streaming: !model.imageOutput,
            reasoning: model.reasoning,
            functionCalling: !model.imageOutput,
            vision: model.vision,
            imageOutput: model.imageOutput,
        },
    });

    /**
     * Fetch the live model catalog. xAI splits it across endpoints: chat
     * models on /language-models, image generation models on
     * /image-generation-models (hidden from /language-models even when the
     * token can call them). The bare /models list is the last resort.
     */
    const fetchLiveModels = async (): Promise<XaiModel[]> => {
        const accessToken = await tokenStore.getValidAccessToken();
        const headers = { Authorization: `Bearer ${accessToken}` };

        const fetchCatalog = async (endpoint: string): Promise<XaiModel[]> => {
            try {
                const response = await globalThis.fetch(`${XAI_BASE_URL}${endpoint}`, { headers });
                if (!response.ok) {
                    logger.warn(`xAI ${endpoint} returned ${response.status}`);
                    return [];
                }
                return buildModelsFromApiResponse(await response.json());
            } catch (error) {
                logger.warn(`xAI ${endpoint} fetch failed:`, error);
                return [];
            }
        };

        const [chatModels, imageModels] = await Promise.all([
            fetchCatalog('/language-models'),
            fetchCatalog('/image-generation-models'),
        ]);
        const merged = [...chatModels, ...imageModels];
        if (merged.length > 0) return merged;

        return fetchCatalog('/models');
    };

    // The live catalog cache (setCachedModels) lives only in memory, so every
    // cold start fell back to the bundled FALLBACK_MODELS snapshot. Any enabled
    // model newer than that snapshot (e.g. grok-4.5) had no catalog entry, so
    // GET /api/models reported all-false capabilities — hiding the composer's
    // Project/Tools/Skills row — until the user manually clicked "Fetch".
    // Persisting the catalog and restoring it on startup (plus a background
    // refresh) makes capabilities load automatically on every launch.
    const MODELS_CACHE_KEY = 'xai-models-cache-v1';

    // Memoized hydration guard. initialize() awaits hydration, but the plugin
    // host does not reliably await initialize() before the first getModels()
    // call (after a hot-reload getModels() served the stale FALLBACK snapshot
    // until a manual Fetch, which made the core read functionCalling as false
    // and hide the Project/Tools/Skills row). So catalog readers self-hydrate
    // through this guard: the storage read happens at most once.
    let hydrationPromise: Promise<void> | null = null;

    /**
     * Ensure the in-memory catalog is populated from persisted storage before a
     * caller trusts getActiveModels(). Idempotent and concurrency-safe.
     */
    const ensureCatalogHydrated = (): Promise<void> => {
        if (isCatalogCached()) return Promise.resolve();
        if (!hydrationPromise) {
            hydrationPromise = (async () => {
                try {
                    const persisted = await storage.local.get<XaiModel[]>(MODELS_CACHE_KEY);
                    // Re-check: a live fetch may have landed while the storage
                    // read was in flight — never clobber fresher data.
                    if (Array.isArray(persisted) && persisted.length > 0 && !isCatalogCached()) {
                        setCachedModels(persisted);
                        logger.info(`Hydrated ${persisted.length} xAI models from storage`);
                    }
                } catch (err) {
                    logger.warn('Failed to hydrate xAI catalog from storage:', err);
                }
            })();
        }
        return hydrationPromise;
    };

    /** Persist the fetched catalog so it survives restarts. Non-blocking. */
    const persistModelCatalog = (models: XaiModel[]): void => {
        void storage.local.set(MODELS_CACHE_KEY, models).catch(err => logger.warn('Failed to persist xAI model catalog:', err));
    };

    /**
     * Fetch the live catalog, update the in-memory cache and persist it.
     * Returns the models on success, or null when unavailable (not logged in /
     * network error / empty response) so callers can fall back to the
     * cached-or-bundled catalog.
     */
    const refreshModelCatalog = async (): Promise<XaiModel[] | null> => {
        if (!tokenStore.hasTokens()) return null;
        try {
            const models = await fetchLiveModels();
            if (models.length === 0) {
                logger.warn('No chat models found in xAI API response');
                return null;
            }
            setCachedModels(models);
            persistModelCatalog(models);
            logger.info(`Fetched and cached ${models.length} models from xAI API`);
            return models;
        } catch (error) {
            logger.error('Error fetching xAI models:', error);
            return null;
        }
    };

    // =========================================================================
    // Register Provider
    // =========================================================================

    const providerDisposable = providers.register({
        id: 'xai-grok',
        icon: 'Grok',
        name: 'xAI Grok (SuperGrok)',
        description: 'Access Grok models via your SuperGrok subscription',
        authType: 'oauth',
        sdkType: 'openai-compatible',
        supportsMultiAccount: true,

        async initialize() {
            // Restore the last-fetched catalog before any getModels() call so
            // cold starts serve real capabilities for models newer than the
            // bundled snapshot (e.g. grok-4.5) instead of all-false defaults.
            // getModels() also self-hydrates via the same guard, so this is a
            // best-effort warm-up rather than the sole load path.
            await ensureCatalogHydrated();

            // Refresh in the background so capabilities load automatically on
            // startup — no manual "Fetch" needed — and brand new backend models
            // are picked up. Non-blocking.
            void refreshModelCatalog();
        },

        async isAuthenticated() {
            return tokenStore.hasTokens();
        },

        // =====================================================================
        // Account listing (single account, surfaced for email/avatar/quota UI)
        // =====================================================================

        async getAccounts() {
            if (!tokenStore.hasTokens()) return [];
            const profile = tokenStore.getProfile() ?? tokenStore.getIdTokenClaims() ?? {};
            const quota = tokenStore.getQuota();
            return [
                {
                    id: tokenStore.getAccountId(),
                    email: profile.email,
                    label: profile.name ?? 'SuperGrok',
                    avatarUrl: profile.picture,
                    isRateLimited: quota?.rateLimitReached === true,
                    quota: quota
                        ? {
                              models: quota.models,
                              lastUpdated: quota.lastUpdated,
                          }
                        : undefined,
                },
            ];
        },

        async removeAccount() {
            await tokenStore.clearTokens();
            ui.showNotification('xAI account removed', { type: 'info' });
        },

        async refreshQuotas() {
            await refreshProfile();
            // xAI has no quota endpoint; probe a cheap authenticated endpoint
            // and harvest whatever rate-limit headers it carries. Real quota
            // updates arrive continuously from chat traffic via captureQuota.
            try {
                if (!tokenStore.hasTokens()) return;
                const accessToken = await tokenStore.getValidAccessToken();
                const response = await globalThis.fetch(`${XAI_BASE_URL}/models`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                });
                captureQuota(response);
            } catch (error) {
                logger.warn('[xai quota] probe failed:', error);
            }
        },

        async authenticate() {
            try {
                const { url, verifier, state } = await getAuthorizationUrl();
                await tokenStore.storePendingLogin(verifier, state);

                ui.showNotification('Opening browser for xAI login...', { type: 'info' });

                // The redirect_uri host:port is part of the Grok-CLI client
                // registration — the callback server must bind exactly 56121.
                const result = await ui.startOAuthFlow({
                    authUrl: url,
                    callbackPort: OAUTH_PORT,
                    callbackPath: OAUTH_CALLBACK_PATH,
                    timeout: 300000,
                    corsOrigins: CORS_ORIGINS,
                });

                if (!result || !result.code) {
                    await tokenStore.clearPendingState();
                    return { success: false, error: 'Authorization cancelled or timed out' };
                }

                const pending = await tokenStore.getPendingLogin();
                if (!pending) {
                    return { success: false, error: 'No pending authorization. Please try again.' };
                }
                if (result.state !== pending.state) {
                    await tokenStore.clearPendingState();
                    return { success: false, error: 'OAuth state mismatch - please try again' };
                }

                const tokens = await exchangeCodeForTokens(result.code, pending.verifier);
                await tokenStore.saveTokens(tokens);
                await tokenStore.clearPendingState();

                // Resolve email/avatar before announcing success so the
                // settings page renders the account immediately.
                await refreshProfile();

                const email = tokenStore.getProfile()?.email;
                const label = email ? ` (${email})` : '';
                ui.showNotification(`Successfully connected to xAI${label}!`, { type: 'success' });
                logger.info('xAI authentication successful');

                return { success: true };
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Authentication failed';
                logger.error('xAI authentication error:', error);
                ui.showError(`Authentication failed: ${message}`);
                return { success: false, error: message };
            }
        },

        async logout() {
            await tokenStore.clearTokens();
            ui.showNotification('Logged out from xAI', { type: 'info' });
            logger.info('xAI logout successful');
        },

        async getModels() {
            // Self-hydrate so the first call after a cold start / reload returns
            // the persisted catalog (real capabilities) instead of the bundled
            // snapshot — independent of initialize() ordering.
            await ensureCatalogHydrated();
            return getActiveModels().map(toProviderModel);
        },

        async fetchModels() {
            logger.info('Fetching available models from xAI API...');
            const models = await refreshModelCatalog();
            if (!models) {
                logger.warn('Live fetch unavailable, using cached/fallback list');
                return this.getModels();
            }
            // getActiveModels merges curated extras (e.g. grok-composer-2.5-fast)
            // that the live catalogs never return.
            return getActiveModels().map(toProviderModel);
        },

        async getSDKConfig() {
            return {
                apiKey: DUMMY_API_KEY,
                baseURL: XAI_BASE_URL,
                fetch: createXaiFetch(),
            };
        },
    });

    // =========================================================================
    // Register Commands
    // =========================================================================

    const loginCommand = commands.register('login', async () => {
        ui.showNotification('Use the provider settings to connect to xAI (SuperGrok)', { type: 'info' });
    });

    const logoutCommand = commands.register('logout', async () => {
        await tokenStore.clearTokens();
        ui.showNotification('Logged out from xAI', { type: 'info' });
    });

    const statusCommand = commands.register('status', async () => {
        if (tokenStore.hasTokens()) {
            const email = tokenStore.getProfile()?.email;
            ui.showNotification(`Connected to xAI${email ? ` (${email})` : ''}`, { type: 'success' });
        } else {
            ui.showNotification('Not connected to xAI', { type: 'warning' });
        }
    });

    logger.info('xAI Grok Auth plugin activated');

    return {
        dispose: () => {
            providerDisposable.dispose();
            loginCommand.dispose();
            logoutCommand.dispose();
            statusCommand.dispose();
            logger.info('xAI Grok Auth plugin deactivated');
        },
    };
}
