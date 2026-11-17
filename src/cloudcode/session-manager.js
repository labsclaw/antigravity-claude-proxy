/**
 * Session Management for Cloud Code
 *
 * Session IDs give the Cloud Code backend a cache-affinity namespace.
 * A per-conversation ID (stable hash of the first user message) keeps every
 * conversation in its own namespace so interleaved conversations on the same
 * account stop evicting each other's implicit-cache KV blocks. Requests
 * without any user text fall back to a per-account process-lifetime ID.
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
 * Extract the first meaningful user text from an Anthropic request.
 * Returns null when no user message carries text.
 */
function extractFirstUserText(anthropicRequest) {
    const messages = anthropicRequest?.messages;
    if (!Array.isArray(messages)) return null;
    for (const msg of messages) {
        if (!msg || msg.role !== 'user') continue;
        const content = msg.content;
        let text = null;
        if (typeof content === 'string') {
            text = content;
        } else if (Array.isArray(content)) {
            const parts = [];
            for (const block of content) {
                if (block && block.type === 'text' && typeof block.text === 'string') {
                    parts.push(block.text);
                }
            }
            if (parts.length > 0) text = parts.join('\n');
        }
        if (text && text.trim().length > 0) {
            // Hash the full text, never a prefix: clients such as Claude Code
            // open the first user message with a long shared preamble
            // (<system-reminder>, CLAUDE.md), so a truncated prefix maps
            // every conversation in a project to the same session ID.
            return text;
        }
    }
    return null;
}

/**
 * Derive a deterministic per-conversation session ID shaped like the binary's
 * `uuid + Date.now()` format. The same conversation (same first user text,
 * same account) always maps to the same ID across turns and proxy restarts.
 */
function deriveConversationSessionId(anthropicRequest, accountEmail, seed = null) {
    const firstUserText = seed || extractFirstUserText(anthropicRequest);
    if (!firstUserText) return null;
    const digest = crypto
        .createHash('sha256')
        .update(`${accountEmail || 'anonymous'}\u0000${firstUserText}`)
        .digest('hex');
    const uuid =
        `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-` +
        `${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    const tail = BigInt(`0x${digest.slice(32, 45)}`).toString();
    return `${uuid}${tail}`;
}

/**
 * Get or create a session ID for a request.
 *
 * Priority:
 *   1. Per-conversation deterministic ID from the first user message —
 *      restores cache continuity per conversation and isolates concurrent
 *      conversations from each other's cache pressure.
 *   2. Per-account process-lifetime ID when the request carries no user
 *      text at all (previous behavior).
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} accountEmail - The account email to scope fallback IDs
 * @returns {string} A stable session ID string matching binary format
 */
export function deriveSessionId(anthropicRequest, accountEmail, affinityKey = null) {
    // Handlers pass an already-derived, client-scoped key. Do not hash it
    // again as a raw explicit header, which would disable restart continuity.
    if (typeof affinityKey === 'string' && affinityKey.startsWith('fallback:')) {
        return deriveConversationSessionId(anthropicRequest, accountEmail,
            JSON.stringify([affinityKey, anthropicRequest?.model || 'default']));
    }
    const key = deriveAffinityKey(anthropicRequest, affinityKey);
    if (key.startsWith('fallback:')) {
        const conversationId = deriveConversationSessionId(anthropicRequest, accountEmail);
        if (conversationId) return conversationId;
    }

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
