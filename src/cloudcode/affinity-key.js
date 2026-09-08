import crypto from 'crypto';

const EXPLICIT_METADATA_KEYS = [
    'session_id',
    'sessionId',
    'conversation_id',
    'conversationId',
    'thread_id',
    'threadId'
];

function canonicalValue(value, seen = new WeakSet()) {
    if (value === null) return ['null'];
    if (value === undefined) return ['undefined'];
    if (typeof value === 'string') return ['string', value];
    if (typeof value === 'boolean') return ['boolean', value];
    if (typeof value === 'number') return ['number', Number.isFinite(value) ? value : String(value)];
    if (typeof value !== 'object') return [typeof value, String(value)];
    if (seen.has(value)) return ['circular'];
    seen.add(value);
    if (Array.isArray(value)) {
        const result = ['array', value.map((item) => canonicalValue(item, seen))];
        seen.delete(value);
        return result;
    }
    const entries = Object.keys(value).sort().map((key) => [key, canonicalValue(value[key], seen)]);
    seen.delete(value);
    return ['object', entries];
}

function hash(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Derive a privacy-safe, client-neutral conversation affinity key.
 * Explicit proxy headers win, followed by stable request metadata. Clients that
 * send neither still get deterministic affinity from the conversation prefix.
 */
export function deriveAffinityKey(request = {}, explicitKey = null, clientScope = null) {
    const normalizedScope = typeof clientScope === 'string' && clientScope.trim()
        ? clientScope.trim()
        : 'unscoped';
    const scopeHash = hash(normalizedScope);
    const normalizedExplicit = typeof explicitKey === 'string' ? explicitKey.trim() : '';
    if (normalizedExplicit) return `explicit:${hash(`${scopeHash}\u0000${normalizedExplicit}`)}`;

    const metadata = request.metadata && typeof request.metadata === 'object'
        ? request.metadata
        : {};
    for (const key of EXPLICIT_METADATA_KEYS) {
        const value = metadata[key];
        if (typeof value === 'string' && value.trim()) {
            return `metadata:${key}:${hash(`${scopeHash}\u0000${value.trim()}`)}`;
        }
    }

    const messages = Array.isArray(request.messages) ? request.messages : [];
    const firstUser = messages.find((message) => message?.role === 'user');
    const firstMessage = firstUser || messages[0];
    const userId = typeof metadata.user_id === 'string'
        ? metadata.user_id.trim()
        : (typeof metadata.userId === 'string' ? metadata.userId.trim() : '');
    const scopedSeed = JSON.stringify(canonicalValue({
        system: request.system,
        firstMessage: firstMessage ? { role: firstMessage.role, content: firstMessage.content } : null,
        userId: userId || null
    }));

    // Empty probes remain deterministic without collapsing every real model
    // conversation into the same bucket.
    return `fallback:${hash(`${scopeHash}\u0000${scopedSeed}`)}`;
}

export function getExplicitAffinityHeader(headers = {}) {
    const value = headers['x-antigravity-session-id']
        ?? headers['x-session-id']
        ?? headers['x-conversation-id'];
    return Array.isArray(value) ? value[0] : value;
}

/**
 * Namespace otherwise common conversation IDs by client. Callers should send
 * x-antigravity-client-id. User-Agent is a compatibility fallback for clients
 * that cannot yet set custom headers.
 */
export function getAffinityClientScope(headers = {}) {
    const value = headers['x-antigravity-client-id']
        ?? headers['x-client-id']
        ?? headers['user-agent']
        ?? 'anonymous-client';
    return Array.isArray(value) ? value[0] : String(value);
}
