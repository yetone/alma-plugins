/**
 * Token Store for OpenAI Codex Auth — multi-account aware.
 *
 * Manages storage and retrieval of OAuth tokens for one or more ChatGPT accounts,
 * using the plugin's secret storage. Handles automatic token refresh when tokens
 * are about to expire. One account is marked "active" and is used by the SDK
 * fetch wrapper; all accounts can be enumerated via {@link listAccounts} for
 * display in the provider settings page.
 *
 * Storage layout:
 *   - `codex_accounts_v2`   → JSON<Record<accountId, CodexAccountRecord>>
 *   - `codex_active_account` → string (accountId)
 *   - `codex_tokens` (legacy) → JSON<CodexTokens> — migrated into v2 on load
 */

import type { CodexTokens, CodexAccountRecord, CodexAccountQuota } from './types';
import { refreshTokens, isTokenExpired, extractAccountClaims } from './auth';

// Storage keys
const STORAGE_KEY_V2 = 'codex_accounts_v2';
const ACTIVE_ACCOUNT_KEY = 'codex_active_account';
const LEGACY_STORAGE_KEY = 'codex_tokens';
const PENDING_VERIFIER_KEY = 'pending_verifier';
const PENDING_STATE_KEY = 'pending_state';

// ============================================================================
// Token Store Interface
// ============================================================================

export interface SecretStorage {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

export interface Logger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
}

// ============================================================================
// Token Store Implementation
// ============================================================================

export class TokenStore {
    private secrets: SecretStorage;
    private logger: Logger;
    private accounts: Map<string, CodexAccountRecord> = new Map();
    private activeAccountId: string | null = null;
    private refreshPromises: Map<string, Promise<CodexTokens>> = new Map();

    constructor(secrets: SecretStorage, logger: Logger) {
        this.secrets = secrets;
        this.logger = logger;
    }

    /**
     * Initialize the token store by loading cached accounts.
     * Migrates from the legacy single-account layout (codex_tokens) if needed.
     */
    async initialize(): Promise<void> {
        try {
            const stored = await this.secrets.get(STORAGE_KEY_V2);
            if (stored) {
                const parsed = JSON.parse(stored) as Record<string, CodexAccountRecord>;
                for (const [id, record] of Object.entries(parsed)) {
                    if (record && record.tokens && record.id) {
                        this.accounts.set(id, record);
                    }
                }
                this.logger.info(`Loaded ${this.accounts.size} cached Codex account(s)`);
            } else {
                // Attempt migration from legacy single-account storage
                await this.migrateLegacy();
            }

            const active = await this.secrets.get(ACTIVE_ACCOUNT_KEY);
            if (active && this.accounts.has(active)) {
                this.activeAccountId = active;
            } else {
                this.activeAccountId = this.accounts.keys().next().value ?? null;
                if (this.activeAccountId) {
                    await this.secrets.set(ACTIVE_ACCOUNT_KEY, this.activeAccountId);
                }
            }
        } catch (error) {
            this.logger.warn('Failed to load cached tokens:', error);
            this.accounts.clear();
            this.activeAccountId = null;
        }
    }

    private async migrateLegacy(): Promise<void> {
        const legacy = await this.secrets.get(LEGACY_STORAGE_KEY);
        if (!legacy) return;
        try {
            const tokens = JSON.parse(legacy) as CodexTokens;
            if (!tokens?.access_token || !tokens?.account_id) return;

            const claims = safeExtractClaims(tokens);
            const record: CodexAccountRecord = {
                id: tokens.account_id,
                tokens,
                email: claims.email,
                picture: claims.picture,
                plan: claims.plan,
            };
            this.accounts.set(record.id, record);
            await this.persistAccounts();
            await this.secrets.delete(LEGACY_STORAGE_KEY);
            this.logger.info(`Migrated legacy Codex token for account ${record.id}`);
        } catch (error) {
            this.logger.warn('Failed to migrate legacy Codex tokens:', error);
        }
    }

    // =========================================================================
    // Account enumeration
    // =========================================================================

    /**
     * List all connected accounts (stable order: insertion order).
     */
    listAccounts(): CodexAccountRecord[] {
        return Array.from(this.accounts.values());
    }

    getAccount(accountId: string): CodexAccountRecord | undefined {
        return this.accounts.get(accountId);
    }

    getActiveAccountId(): string | null {
        return this.activeAccountId;
    }

    async setActiveAccount(accountId: string): Promise<void> {
        if (!this.accounts.has(accountId)) {
            throw new Error(`Unknown account: ${accountId}`);
        }
        this.activeAccountId = accountId;
        await this.secrets.set(ACTIVE_ACCOUNT_KEY, accountId);
    }

    /**
     * True when at least one account has a refresh token we can use.
     */
    hasValidToken(): boolean {
        for (const record of this.accounts.values()) {
            if (record.tokens?.refresh_token) return true;
        }
        return false;
    }

    /**
     * ID of the active account, or null when no accounts are connected.
     * Exposed for backwards compatibility with callers that used the old
     * single-account API (`getAccountId`).
     */
    getAccountId(): string | null {
        return this.activeAccountId;
    }

    // =========================================================================
    // Token CRUD
    // =========================================================================

    /**
     * Save tokens for a new or existing account. The account id is taken from
     * the tokens themselves (account_id claim). If no account is currently
     * active, the newly saved account becomes active.
     */
    async saveTokens(tokens: CodexTokens): Promise<CodexAccountRecord> {
        const claims = safeExtractClaims(tokens);
        const existing = this.accounts.get(tokens.account_id);
        const record: CodexAccountRecord = {
            id: tokens.account_id,
            tokens,
            email: claims.email ?? existing?.email,
            picture: claims.picture ?? existing?.picture,
            plan: claims.plan ?? existing?.plan,
            quota: existing?.quota,
        };
        this.accounts.set(record.id, record);
        await this.persistAccounts();

        if (!this.activeAccountId) {
            this.activeAccountId = record.id;
            await this.secrets.set(ACTIVE_ACCOUNT_KEY, record.id);
        }

        this.logger.info(`Saved Codex tokens for account ${record.id}`);
        return record;
    }

    /**
     * Cache quota data against an account record. Quota is best-effort — a
     * failure here never blocks login or API calls.
     */
    async setAccountQuota(accountId: string, quota: CodexAccountQuota | null): Promise<void> {
        const record = this.accounts.get(accountId);
        if (!record) return;
        if (quota) {
            record.quota = quota;
            // The usage endpoint is the authority: when it says the account is
            // not limited (and nothing is at 0%), a local mark from an earlier
            // 429 is stale — drop it so the account is eligible again.
            if (record.limitedUntil && !quota.rateLimitReached && !quota.models.some(m => m.percentage <= 0)) {
                delete record.limitedUntil;
            }
        } else {
            delete record.quota;
        }
        await this.persistAccounts();
    }

    // =========================================================================
    // Usage-limit bookkeeping (multi-account rotation)
    // =========================================================================

    /** Remember that `accountId` is out of quota until `until` (ms epoch). */
    async markAccountLimited(accountId: string, until: number): Promise<void> {
        const record = this.accounts.get(accountId);
        if (!record) return;
        record.limitedUntil = until;
        await this.persistAccounts();
        this.logger.info(`Codex account ${accountId} marked out of quota until ${new Date(until).toISOString()}`);
    }

    /** A request on `accountId` went through: it evidently has quota again. */
    async clearAccountLimited(accountId: string): Promise<void> {
        const record = this.accounts.get(accountId);
        if (!record?.limitedUntil) return;
        delete record.limitedUntil;
        await this.persistAccounts();
    }

    /**
     * True when the account is believed to have no quota right now: a 429 mark
     * that has not expired, or a cached usage snapshot with the limit reached
     * whose reset is still ahead.
     */
    isAccountLimited(accountId: string, now = Date.now()): boolean {
        const record = this.accounts.get(accountId);
        if (!record) return false;
        if (record.limitedUntil && record.limitedUntil > now) return true;
        const quota = record.quota;
        if (quota?.rateLimitReached) {
            const resets = quota.models.map(m => Date.parse(m.resetTime)).filter(t => Number.isFinite(t));
            // No usable reset time: trust the flag only while the snapshot is fresh.
            if (resets.length === 0) return now - quota.lastUpdated < 10 * 60 * 1000;
            return Math.min(...resets) > now;
        }
        return false;
    }

    /**
     * The next account with quota, in round-robin order after the active one,
     * skipping `exclude` (accounts already tried in this request). Null when
     * every other account is limited too.
     */
    pickAvailableAccount(exclude: Iterable<string> = [], now = Date.now()): CodexAccountRecord | null {
        const skip = new Set(exclude);
        const ids = Array.from(this.accounts.keys());
        if (ids.length === 0) return null;
        const start = this.activeAccountId ? ids.indexOf(this.activeAccountId) : -1;
        for (let step = 1; step <= ids.length; step++) {
            const id = ids[(start + step) % ids.length];
            if (skip.has(id) || id === this.activeAccountId) continue;
            if (!this.accounts.get(id)?.tokens?.refresh_token) continue;
            if (this.isAccountLimited(id, now)) continue;
            return this.accounts.get(id) ?? null;
        }
        return null;
    }

    /** Earliest moment any account is expected to have quota again, if known. */
    earliestLimitReset(now = Date.now()): number | null {
        let earliest: number | null = null;
        for (const record of this.accounts.values()) {
            const candidates: number[] = [];
            if (record.limitedUntil && record.limitedUntil > now) candidates.push(record.limitedUntil);
            for (const m of record.quota?.models ?? []) {
                const t = Date.parse(m.resetTime);
                if (Number.isFinite(t) && t > now && m.percentage <= 0) candidates.push(t);
            }
            for (const t of candidates) if (earliest === null || t < earliest) earliest = t;
        }
        return earliest;
    }

    /**
     * Merge freshly fetched profile fields (email, picture, plan) into an
     * account record. JWT claims win when present; this call only fills gaps
     * or updates with newer values.
     */
    async setAccountProfile(
        accountId: string,
        profile: { email?: string; picture?: string; name?: string }
    ): Promise<void> {
        const record = this.accounts.get(accountId);
        if (!record) return;
        let changed = false;
        if (profile.email && profile.email !== record.email) {
            record.email = profile.email;
            changed = true;
        }
        if (profile.picture && profile.picture !== record.picture) {
            record.picture = profile.picture;
            changed = true;
        }
        if (changed) await this.persistAccounts();
    }

    /**
     * Remove a specific account. If the removed account was active, pick the
     * next available account as active (or clear active when none remain).
     */
    async removeAccount(accountId: string): Promise<void> {
        if (!this.accounts.delete(accountId)) return;
        this.refreshPromises.delete(accountId);

        if (this.activeAccountId === accountId) {
            this.activeAccountId = this.accounts.keys().next().value ?? null;
            if (this.activeAccountId) {
                await this.secrets.set(ACTIVE_ACCOUNT_KEY, this.activeAccountId);
            } else {
                await this.secrets.delete(ACTIVE_ACCOUNT_KEY);
            }
        }
        await this.persistAccounts();
        this.logger.info(`Removed Codex account ${accountId}`);
    }

    /**
     * Clear all tokens (full logout across every account).
     */
    async clearTokens(): Promise<void> {
        this.accounts.clear();
        this.activeAccountId = null;
        this.refreshPromises.clear();
        await this.secrets.delete(STORAGE_KEY_V2);
        await this.secrets.delete(ACTIVE_ACCOUNT_KEY);
        await this.secrets.delete(LEGACY_STORAGE_KEY);
        await this.secrets.delete(PENDING_VERIFIER_KEY);
        await this.secrets.delete(PENDING_STATE_KEY);
        this.logger.info('Cleared all Codex tokens');
    }

    // =========================================================================
    // Access token acquisition
    // =========================================================================

    /**
     * Get a valid access token for the active account, refreshing if needed.
     */
    async getValidAccessToken(): Promise<string> {
        if (!this.activeAccountId) {
            throw new Error('Not authenticated. Please login first.');
        }
        return this.getValidAccessTokenFor(this.activeAccountId);
    }

    /**
     * Get a valid access token for a specific account. Concurrent callers
     * share the same in-flight refresh.
     */
    async getValidAccessTokenFor(accountId: string): Promise<string> {
        const record = this.accounts.get(accountId);
        if (!record) {
            throw new Error(`Account not found: ${accountId}`);
        }

        if (!isTokenExpired(record.tokens.expires_at)) {
            return record.tokens.access_token;
        }

        this.logger.info(`Access token for ${accountId} expired, refreshing...`);

        let pending = this.refreshPromises.get(accountId);
        if (!pending) {
            pending = this.doRefresh(accountId);
            this.refreshPromises.set(accountId, pending);
        }

        try {
            const tokens = await pending;
            return tokens.access_token;
        } finally {
            this.refreshPromises.delete(accountId);
        }
    }

    /**
     * Force-refresh tokens regardless of local expiry.
     * Needed when the server invalidates an access token before it expires
     * (e.g. "Your authentication token has been invalidated" after the same
     * ChatGPT account logs in elsewhere and rotates the session).
     * Concurrent callers share the same in-flight refresh.
     */
    async forceRefreshAccessToken(accountId?: string): Promise<string> {
        const id = accountId ?? this.activeAccountId;
        if (!id) {
            throw new Error('Not authenticated. Please login first.');
        }

        let pending = this.refreshPromises.get(id);
        if (!pending) {
            pending = this.doRefresh(id);
            this.refreshPromises.set(id, pending);
        }

        try {
            const tokens = await pending;
            return tokens.access_token;
        } finally {
            this.refreshPromises.delete(id);
        }
    }

    private async doRefresh(accountId: string): Promise<CodexTokens> {
        const record = this.accounts.get(accountId);
        if (!record?.tokens.refresh_token) {
            throw new Error(`No refresh token for account ${accountId}. Please login again.`);
        }

        try {
            const newTokens = await refreshTokens(record.tokens.refresh_token);
            // The refreshed token may change account_id only in rare edge cases;
            // trust the id claim and re-key the record accordingly.
            const saved = await this.saveTokens(newTokens);
            this.logger.info(`Successfully refreshed Codex tokens for ${saved.id}`);
            return newTokens;
        } catch (error) {
            this.logger.error(`Failed to refresh tokens for ${accountId}:`, error);
            await this.removeAccount(accountId);
            throw new Error('Token refresh failed. Please login again.');
        }
    }

    // =========================================================================
    // Persistence helper
    // =========================================================================

    private async persistAccounts(): Promise<void> {
        if (this.accounts.size === 0) {
            await this.secrets.delete(STORAGE_KEY_V2);
            return;
        }
        const serialized: Record<string, CodexAccountRecord> = {};
        for (const [id, record] of this.accounts.entries()) {
            serialized[id] = record;
        }
        await this.secrets.set(STORAGE_KEY_V2, JSON.stringify(serialized));
    }

    // =========================================================================
    // Pending OAuth state management
    // =========================================================================

    async storePendingVerifier(verifier: string): Promise<void> {
        await this.secrets.set(PENDING_VERIFIER_KEY, verifier);
    }

    async getPendingVerifier(): Promise<string | null> {
        const verifier = await this.secrets.get(PENDING_VERIFIER_KEY);
        if (verifier) {
            await this.secrets.delete(PENDING_VERIFIER_KEY);
        }
        return verifier ?? null;
    }

    async storePendingState(state: string): Promise<void> {
        await this.secrets.set(PENDING_STATE_KEY, state);
    }

    async getPendingState(): Promise<string | null> {
        const state = await this.secrets.get(PENDING_STATE_KEY);
        return state ?? null;
    }

    async clearPendingState(): Promise<void> {
        await this.secrets.delete(PENDING_STATE_KEY);
    }
}

// ============================================================================
// Helpers
// ============================================================================

function safeExtractClaims(tokens: CodexTokens): {
    email?: string;
    picture?: string;
    plan?: string;
} {
    try {
        const claims = extractAccountClaims(tokens.access_token, tokens.id_token);
        return { email: claims.email, picture: claims.picture, plan: claims.plan };
    } catch {
        return {};
    }
}
