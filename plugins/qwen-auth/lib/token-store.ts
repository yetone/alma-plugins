/**
 * Token Store for Qwen Auth
 *
 * Manages storage and retrieval of OAuth tokens using the plugin's secret storage.
 * Handles token refresh and expiration checking.
 */

import type { QwenTokens, QwenTokenStorage } from './types';
import { refreshTokens, isTokenExpired } from './auth';

// Storage keys
const TOKEN_STORAGE_KEY = 'qwen_tokens';
const PENDING_DEVICE_FLOW_KEY = 'pending_device_flow';

// ============================================================================
// Token Store Interface
// ============================================================================

export interface SecretStorage {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}


// ============================================================================
// Token Store Implementation
// ============================================================================

export class TokenStore {
    private secrets: SecretStorage;
    private cachedTokens: QwenTokens | null = null;
    private refreshPromise: Promise<QwenTokens> | null = null;

    constructor(secrets: SecretStorage) {
        this.secrets = secrets;
    }

    /**
     * Initialize the token store by loading cached tokens
     */
    async initialize(): Promise<void> {
        try {
            const stored = await this.secrets.get(TOKEN_STORAGE_KEY);
            if (stored) {
                const storage: QwenTokenStorage = JSON.parse(stored);
                this.cachedTokens = this.fromStorage(storage);
            }
        } catch (error) {
        }
    }

    /**
     * Convert storage format to tokens
     */
    private fromStorage(storage: QwenTokenStorage): QwenTokens {
        return {
            access_token: storage.access_token,
            refresh_token: storage.refresh_token,
            token_type: 'Bearer',
            expires_at: new Date(storage.expires_at).getTime(),
            resource_url: storage.resource_url,
            email: storage.email,
        };
    }

    /**
     * Convert tokens to storage format
     */
    private toStorage(tokens: QwenTokens): QwenTokenStorage {
        return {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            last_refresh: new Date().toISOString(),
            resource_url: tokens.resource_url,
            email: tokens.email,
            type: 'qwen',
            expires_at: new Date(tokens.expires_at).toISOString(),
        };
    }

    /**
     * Save tokens to storage
     */
    async saveTokens(tokens: QwenTokens): Promise<void> {
        this.cachedTokens = tokens;
        const storage = this.toStorage(tokens);
        await this.secrets.set(TOKEN_STORAGE_KEY, JSON.stringify(storage));
    }

    /**
     * Check if we have valid tokens
     */
    hasValidToken(): boolean {
        return this.cachedTokens !== null;
    }

    /**
     * Get current tokens (may be expired)
     */
    getTokens(): QwenTokens | null {
        return this.cachedTokens;
    }

    /**
     * Get user email if available
     */
    getEmail(): string | undefined {
        return this.cachedTokens?.email;
    }

    /**
     * Get valid access token, refreshing if necessary
     */
    async getValidAccessToken(): Promise<string> {
        if (!this.cachedTokens) {
            throw new Error('Not authenticated. Please login first.');
        }

        // Check if token needs refresh
        if (isTokenExpired(this.cachedTokens.expires_at)) {
            await this.refreshToken();
        }

        return this.cachedTokens.access_token;
    }

    /**
     * Refresh the access token
     * Uses a promise to prevent concurrent refresh attempts
     */
    private async refreshToken(): Promise<void> {
        if (!this.cachedTokens?.refresh_token) {
            throw new Error('No refresh token available. Please login again.');
        }

        // Prevent concurrent refresh attempts
        if (this.refreshPromise) {
            await this.refreshPromise;
            return;
        }

        try {
            this.refreshPromise = refreshTokens(this.cachedTokens.refresh_token);
            const newTokens = await this.refreshPromise;

            // Preserve email from old tokens if not in new response
            if (!newTokens.email && this.cachedTokens.email) {
                newTokens.email = this.cachedTokens.email;
            }

            await this.saveTokens(newTokens);
        } catch (error) {
            throw error;
        } finally {
            this.refreshPromise = null;
        }
    }

    /**
     * Force refresh the access token (even if not expired)
     * Used when receiving 401 Unauthorized responses
     */
    async forceRefreshToken(): Promise<void> {
        await this.refreshToken();
    }

    /**
     * Clear all tokens (logout)
     */
    async clearTokens(): Promise<void> {
        this.cachedTokens = null;
        await this.secrets.delete(TOKEN_STORAGE_KEY);
        await this.secrets.delete(PENDING_DEVICE_FLOW_KEY);
    }

    /**
     * Store pending device flow data
     */
    async storePendingDeviceFlow(data: { deviceCode: string; codeVerifier: string }): Promise<void> {
        await this.secrets.set(PENDING_DEVICE_FLOW_KEY, JSON.stringify(data));
    }

    /**
     * Get pending device flow data
     */
    async getPendingDeviceFlow(): Promise<{ deviceCode: string; codeVerifier: string } | null> {
        const stored = await this.secrets.get(PENDING_DEVICE_FLOW_KEY);
        if (!stored) return null;
        try {
            return JSON.parse(stored);
        } catch {
            return null;
        }
    }

    /**
     * Clear pending device flow data
     */
    async clearPendingDeviceFlow(): Promise<void> {
        await this.secrets.delete(PENDING_DEVICE_FLOW_KEY);
    }
}
