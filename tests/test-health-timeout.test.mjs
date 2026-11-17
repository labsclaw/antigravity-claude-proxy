import assert from 'node:assert/strict';
import test from 'node:test';
import { getTokenForAccount } from '../src/account-manager/credentials.js';
import { getModelQuotas } from '../src/cloudcode/model-api.js';
import { config } from '../src/config.js';
import { throttledFetch } from '../src/utils/helpers.js';

function installPendingFetch() {
    const originalFetch = globalThis.fetch;
    const signals = [];

    globalThis.fetch = (_url, options = {}) => {
        const { signal } = options;
        signals.push(signal);

        return new Promise((_, reject) => {
            const safetyTimer = setTimeout(() => {
                reject(new Error('fetch was not cancelled'));
            }, 100);
            const rejectOnAbort = () => {
                clearTimeout(safetyTimer);
                reject(signal?.reason ?? new Error('request aborted'));
            };

            if (signal?.aborted) {
                rejectOnAbort();
            } else {
                signal?.addEventListener('abort', rejectOnAbort, { once: true });
            }
        });
    };

    return {
        originalFetch,
        signals
    };
}

function disableThrottling() {
    const originalEnabled = config.requestThrottlingEnabled;
    config.requestThrottlingEnabled = false;
    return () => {
        config.requestThrottlingEnabled = originalEnabled;
    };
}

test('health timeout aborts OAuth refresh without invalidating the account', { concurrency: false }, async () => {
    const { originalFetch, signals } = installPendingFetch();
    const restoreThrottling = disableThrottling();
    let invalidReason;

    try {
        const signal = AbortSignal.timeout(20);
        await assert.rejects(
            getTokenForAccount(
                {
                    email: 'health-timeout@example.test',
                    source: 'oauth',
                    refreshToken: 'test-refresh-token'
                },
                new Map(),
                (_email, reason) => {
                    invalidReason = reason;
                },
                undefined,
                { signal }
            ),
            error => {
                assert.match(error.message, /AUTH_NETWORK_ERROR/);
                return true;
            }
        );

        assert.equal(invalidReason, undefined);
        assert.equal(signals[0], signal);
    } finally {
        restoreThrottling();
        globalThis.fetch = originalFetch;
    }
});

test('health timeout cancels quota fetches instead of hanging', { concurrency: false }, async () => {
    const { originalFetch, signals } = installPendingFetch();
    const restoreThrottling = disableThrottling();

    try {
        const signal = AbortSignal.timeout(20);
        await assert.rejects(
            getModelQuotas('test-access-token', null, { signal }),
            /Failed to fetch available models/
        );

        assert.ok(signals.length >= 1);
        assert.equal(signals[0], signal);
    } finally {
        restoreThrottling();
        globalThis.fetch = originalFetch;
    }
});

test('health timeout interrupts the throttling delay', { concurrency: false }, async () => {
    const originalFetch = globalThis.fetch;
    const originalEnabled = config.requestThrottlingEnabled;
    const originalDelayMs = config.requestDelayMs;
    let fetchCalled = false;

    globalThis.fetch = () => {
        fetchCalled = true;
        return Promise.resolve({ ok: true });
    };
    config.requestThrottlingEnabled = true;
    config.requestDelayMs = 1000;

    const started = Date.now();
    try {
        await assert.rejects(
            throttledFetch('https://example.invalid', { signal: AbortSignal.timeout(20) }),
            error => error.name === 'TimeoutError'
        );

        assert.ok(Date.now() - started < 500, 'throttling delay should be interruptible');
        assert.equal(fetchCalled, false);
    } finally {
        config.requestThrottlingEnabled = originalEnabled;
        config.requestDelayMs = originalDelayMs;
        globalThis.fetch = originalFetch;
    }
});
