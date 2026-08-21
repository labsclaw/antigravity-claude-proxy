/**
 * Session Management for Cloud Code
 *
 * Handles session ID derivation for prompt caching continuity.
 * Session IDs are derived from the first user message to ensure
 * the same conversation uses the same session across turns.
 */

import crypto from 'crypto';
import { deriveAffinityKey } from './affinity-key.js';
import { config as runtimeConfig } from '../config.js';


// Runtime storage for session IDs per conversation and account. This preserves
// upstream cache continuity without leaking one account-wide ID across unrelated
// clients or conversations.
const runtimeSessionStore = new Map();
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSION_ENTRIES = 10000;

function boundedNumber(value, fallback, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return fallback;
    return value;
}

function getStoreSettings() {
    const settings = runtimeConfig.accountSelection?.sessionHybrid || {};
    return {
        ttlMs: boundedNumber(settings.sessionStoreTtlMs, DEFAULT_SESSION_TTL_MS, 1, 365 * 24 * 60 * 60 * 1000),
        maxEntries: Math.trunc(boundedNumber(settings.maxSessionEntries, DEFAULT_MAX_SESSION_ENTRIES, 1, 1000000))
    };
}

function pruneSessionStore(now, ttlMs) {
    for (const [key, entry] of runtimeSessionStore) {
        if (now - entry.updatedAt > ttlMs) runtimeSessionStore.delete(key);
    }
}

/**
 * Get or create a session ID for the given account.
 * 
 * The binary generates a session ID once at startup: `p.sessionID = rs() + Date.now()`.
 * Since our proxy is long-running, we simulate this "per-launch" behavior by storing
 * a generated ID in memory for each account.
 *
 * - If the proxy restarts, the ID changes (matching binary/VS Code restart behavior).
 * - Within a running proxy instance, the ID is stable for that account.
 * - This enables prompt caching while using the EXACT random logic of the binary.
 *
 * @param {Object} anthropicRequest - The Anthropic-format request (unused for ID generation now)
 * @param {string} accountEmail - The account email to scope the session ID
 * @returns {string} A stable session ID string matching binary format
 */
export function deriveSessionId(anthropicRequest, accountEmail, affinityKey = null) {
    if (!accountEmail) {
        // Fallback for requests without an account (should differ every time)
        return generateBinaryStyleId();
    }

    const conversationKey = deriveAffinityKey(anthropicRequest, affinityKey);
    const modelId = typeof anthropicRequest?.model === 'string' && anthropicRequest.model ? anthropicRequest.model : 'default';
    const storeKey = JSON.stringify([accountEmail, conversationKey, modelId]);
    const now = Date.now();
    const { ttlMs, maxEntries } = getStoreSettings();
    pruneSessionStore(now, ttlMs);

    if (runtimeSessionStore.has(storeKey)) {
        const entry = runtimeSessionStore.get(storeKey);
        entry.updatedAt = now;
        runtimeSessionStore.delete(storeKey);
        runtimeSessionStore.set(storeKey, entry);
        return entry.sessionId;
    }

    // Generate a new ID using the binary's exact logic
    const newSessionId = generateBinaryStyleId();

    // Store it for future requests from this account
    while (runtimeSessionStore.size >= maxEntries) runtimeSessionStore.delete(runtimeSessionStore.keys().next().value);
    runtimeSessionStore.set(storeKey, { sessionId: newSessionId, updatedAt: now });

    return newSessionId;
}

/**
 * Generate a Session ID using the binary's exact logic.
 * logic: `rs() + Date.now()` where `rs()` is randomUUID
 */
function generateBinaryStyleId() {
    return crypto.randomUUID() + Date.now().toString();
}

/**
 * Clears all session IDs (e.g. useful for testing or explicit reset)
 */
export function clearSessionStore() {
    runtimeSessionStore.clear();
}
