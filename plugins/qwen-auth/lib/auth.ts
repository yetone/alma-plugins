/**
 * OAuth Authentication for Qwen
 *
 * Implements OAuth 2.0 Device Authorization Flow with PKCE for Qwen API.
 * Based on CLIProxyAPI's Qwen authentication implementation.
 */

import type { PKCEChallenge, DeviceFlowResponse, QwenTokens, QwenTokenResponse, QwenOAuthError } from './types';

// ============================================================================
// OAuth Configuration (from CLIProxyAPI)
// ============================================================================

export const QWEN_OAUTH_CONFIG = {
    clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
    deviceCodeEndpoint: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
    tokenEndpoint: 'https://chat.qwen.ai/api/v1/oauth2/token',
    scope: 'openid profile email model.completion',
    grantType: 'urn:ietf:params:oauth:grant-type:device_code',
};

// Polling configuration
const DEFAULT_POLL_INTERVAL_MS = 5000; // 5 seconds
const MAX_POLL_ATTEMPTS = 60; // 5 minutes max

// ============================================================================
// PKCE Helpers
// ============================================================================

/**
 * Generate a cryptographically random string for PKCE code verifier
 */
function generateCodeVerifier(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
}

/**
 * Generate SHA-256 hash of the code verifier for PKCE code challenge
 */
async function generateCodeChallenge(codeVerifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Base64 URL encode bytes
 */
function base64UrlEncode(bytes: Uint8Array): string {
    const base64 = btoa(String.fromCharCode(...bytes));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate PKCE challenge and verifier pair
 */
export async function generatePKCE(): Promise<PKCEChallenge> {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    return { verifier, challenge };
}

// ============================================================================
// Device Flow OAuth
// ============================================================================

/**
 * Initiate the OAuth 2.0 Device Authorization Flow
 * Returns device code, user code, and verification URL
 */
export async function initiateDeviceFlow(): Promise<DeviceFlowResponse> {
    const pkce = await generatePKCE();

    const params = new URLSearchParams({
        client_id: QWEN_OAUTH_CONFIG.clientId,
        scope: QWEN_OAUTH_CONFIG.scope,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
    });

    const response = await fetch(QWEN_OAUTH_CONFIG.deviceCodeEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
        },
        body: params.toString(),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Device authorization failed: ${response.status} ${response.statusText}. ${errorText}`);
    }

    const data = await response.json();

    if (!data.device_code) {
        throw new Error('Device authorization failed: device_code not found in response');
    }

    return {
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        verification_uri_complete: data.verification_uri_complete,
        expires_in: data.expires_in,
        interval: data.interval || 5,
        code_verifier: pkce.verifier,
    };
}

/**
 * Poll for token after user authorization
 * Implements OAuth RFC 8628 standard error handling
 */
export async function pollForToken(
    deviceCode: string,
    codeVerifier: string,
    onProgress?: (attempt: number, maxAttempts: number) => void
): Promise<QwenTokens> {
    let pollInterval = DEFAULT_POLL_INTERVAL_MS;

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        if (onProgress) {
            onProgress(attempt + 1, MAX_POLL_ATTEMPTS);
        }

        const params = new URLSearchParams({
            grant_type: QWEN_OAUTH_CONFIG.grantType,
            client_id: QWEN_OAUTH_CONFIG.clientId,
            device_code: deviceCode,
            code_verifier: codeVerifier,
        });

        try {
            const response = await fetch(QWEN_OAUTH_CONFIG.tokenEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                },
                body: params.toString(),
            });

            const body = await response.text();

            if (response.ok) {
                // Success - parse token data
                const tokenResponse: QwenTokenResponse = JSON.parse(body);
                const expiresAt = Date.now() + tokenResponse.expires_in * 1000;

                return {
                    access_token: tokenResponse.access_token,
                    refresh_token: tokenResponse.refresh_token || '',
                    token_type: tokenResponse.token_type,
                    expires_at: expiresAt,
                    resource_url: tokenResponse.resource_url,
                };
            }

            // Handle OAuth RFC 8628 standard errors
            if (response.status === 400) {
                try {
                    const errorData: QwenOAuthError = JSON.parse(body);

                    switch (errorData.error) {
                        case 'authorization_pending':
                            // User has not yet approved. Continue polling.
                            await sleep(pollInterval);
                            continue;

                        case 'slow_down':
                            // Increase poll interval
                            pollInterval = Math.min(pollInterval * 1.5, 10000);
                            await sleep(pollInterval);
                            continue;

                        case 'expired_token':
                            throw new Error('Device code expired. Please restart the authentication process.');

                        case 'access_denied':
                            throw new Error('Authorization denied by user. Please restart the authentication process.');

                        default:
                            throw new Error(`Token poll failed: ${errorData.error} - ${errorData.error_description || ''}`);
                    }
                } catch (parseError) {
                    if (parseError instanceof SyntaxError) {
                        throw new Error(`Token poll failed: ${response.status} ${response.statusText}. ${body}`);
                    }
                    throw parseError;
                }
            }

            // Other error status
            throw new Error(`Token poll failed: ${response.status} ${response.statusText}. ${body}`);
        } catch (error) {
            if (error instanceof Error && (
                error.message.includes('expired') ||
                error.message.includes('denied') ||
                error.message.includes('Token poll failed')
            )) {
                throw error;
            }
            // Network error, continue polling
            await sleep(pollInterval);
        }
    }

    throw new Error('Authentication timeout. Please restart the authentication process.');
}

/**
 * Refresh access token using refresh token
 */
export async function refreshTokens(refreshToken: string): Promise<QwenTokens> {
    const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: QWEN_OAUTH_CONFIG.clientId,
    });

    const response = await fetch(QWEN_OAUTH_CONFIG.tokenEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
        },
        body: params.toString(),
    });

    if (!response.ok) {
        const errorText = await response.text();
        try {
            const errorData: QwenOAuthError = JSON.parse(errorText);
            throw new Error(`Token refresh failed: ${errorData.error} - ${errorData.error_description || ''}`);
        } catch (parseError) {
            if (parseError instanceof SyntaxError) {
                throw new Error(`Token refresh failed: ${response.status} ${response.statusText}. ${errorText}`);
            }
            throw parseError;
        }
    }

    const tokenResponse: QwenTokenResponse = await response.json();
    const expiresAt = Date.now() + tokenResponse.expires_in * 1000;

    return {
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token || refreshToken, // Keep old refresh token if not returned
        token_type: tokenResponse.token_type,
        expires_at: expiresAt,
        resource_url: tokenResponse.resource_url,
    };
}

/**
 * Check if token is expired or about to expire (within 5 minutes)
 */
export function isTokenExpired(expiresAt: number, bufferMs: number = 5 * 60 * 1000): boolean {
    return Date.now() >= expiresAt - bufferMs;
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
