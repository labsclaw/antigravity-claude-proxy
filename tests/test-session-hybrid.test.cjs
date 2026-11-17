const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const vm = require('node:vm');
const execFileAsync = promisify(execFile);

function account(email, remainingFraction = 0.8) {
    return {
        email,
        enabled: true,
        quota: {
            lastChecked: Date.now(),
            models: {
                'claude-test': { remainingFraction }
            }
        }
    };
}

async function modules() {
    const [{ SessionHybridStrategy }, affinity, session, builder, message, streaming, configModule] = await Promise.all([
        import('../src/account-manager/strategies/session-hybrid-strategy.js'),
        import('../src/cloudcode/affinity-key.js'),
        import('../src/cloudcode/session-manager.js'),
        import('../src/cloudcode/request-builder.js'),
        import('../src/cloudcode/message-handler.js'),
        import('../src/cloudcode/streaming-handler.js'),
        import('../src/config.js')
    ]);
    return { SessionHybridStrategy, affinity, session, builder, message, streaming, runtimeConfig: configModule.config };
}

test('same conversation and model keeps the same account', async () => {
    const { SessionHybridStrategy } = await modules();
    const strategy = new SessionHybridStrategy();
    const accounts = [account('a@example.com'), account('b@example.com'), account('c@example.com')];
    const first = strategy.selectAccount(accounts, 'claude-test', { sessionId: 'session-a' });
    strategy.onRequestComplete(first.account, 'claude-test', { leaseId: first.leaseId });
    const second = strategy.selectAccount(accounts, 'claude-test', { sessionId: 'session-a' });
    assert.equal(second.account.email, first.account.email);
});

test('preview selection does not consume capacity or create an affinity binding', async () => {
    const { SessionHybridStrategy } = await modules();
    const strategy = new SessionHybridStrategy({
        tokenBucket: { maxTokens: 1, initialTokens: 1, refillRate: 0 }
    });
    const accounts = [account('preview@example.com')];
    const preview = strategy.selectAccount(accounts, 'claude-test', {
        sessionId: 'preview-session',
        trackInFlight: false,
        reserveCapacity: false
    });
    assert.equal(preview.account.email, 'preview@example.com');
    assert.equal(strategy.getAssignmentCount(), 0);
    assert.equal(strategy.getInFlightCount('preview@example.com'), 0);

    const real = strategy.selectAccount(accounts, 'claude-test', {
        sessionId: 'preview-session'
    });
    assert.equal(real.account.email, 'preview@example.com');
    assert.equal(strategy.getAssignmentCount(), 1);
    assert.equal(strategy.getInFlightCount('preview@example.com'), 1);
    strategy.onRequestComplete(real.account, 'claude-test', { leaseId: real.leaseId });
});

test('preview does not prune expired bindings or evict at the assignment limit', async () => {
    const { SessionHybridStrategy } = await modules();
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
        const strategy = new SessionHybridStrategy({ tokenBucket: { maxTokens: 100, initialTokens: 100 }, sessionHybrid: { assignmentTtlMs: 10, maxAssignments: 2 } });
        const accounts = [account('a@example.com'), account('b@example.com')];
        const a = strategy.selectAccount(accounts, 'claude-test', { sessionId: 'bound-a', trackInFlight: false });
        now = 1001;
        strategy.selectAccount(accounts, 'claude-test', { sessionId: 'bound-b', trackInFlight: false });
        assert.equal(strategy.getAssignmentCount(), 2);
        a.account.selectionWeight = 0.01;
        accounts.find((item) => item !== a.account).selectionWeight = 100;
        now = 2000;
        const expiredPreview = strategy.selectAccount(accounts, 'claude-test', { sessionId: 'bound-a', reserveCapacity: false, trackInFlight: false });
        assert.equal(expiredPreview.account.email, a.account.email);
        strategy.selectAccount(accounts, 'claude-test', { sessionId: 'preview-new', reserveCapacity: false, trackInFlight: false });
        assert.equal(strategy.getAssignmentCount(), 2);
    } finally {
        Date.now = originalNow;
    }
});

test('hostile numeric configuration cannot hang or collapse rendezvous scoring', async () => {
    const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', `
        import { SessionHybridStrategy } from './src/account-manager/strategies/session-hybrid-strategy.js';
        const account = (email) => ({ email, enabled: true, selectionWeight: Number.NaN });
        const strategy = new SessionHybridStrategy({ healthScore: { initial: Number.NaN, recoveryPerHour: Number.POSITIVE_INFINITY }, tokenBucket: { maxTokens: 0, initialTokens: -5, tokensPerMinute: Number.NaN }, quota: { unknownScore: Number.NaN, staleMs: -1 }, weights: { health: 0, tokens: -1, quota: Number.NaN }, sessionHybrid: { maxAssignments: 0, assignmentTtlMs: -1, concurrencyPenalty: Number.POSITIVE_INFINITY } });
        const accounts = [account('a@example.com'), account('b@example.com')];
        for (let i = 0; i < 20; i++) {
          const selected = strategy.selectAccount(accounts, 'model', { sessionId: 's-' + i, trackInFlight: false });
          if (!selected.account) throw new Error('no account');
        }
        console.log('normalized-ok');
    `], { cwd: process.cwd(), timeout: 3000 });
    assert.match(result.stdout, /normalized-ok/);
});

test('non-finite selection weights are treated conservatively', async () => {
    const { SessionHybridStrategy } = await modules();
    const strategy = new SessionHybridStrategy({ tokenBucket: { maxTokens: 1000, initialTokens: 1000 } });
    const accounts = [account('a@example.com'), account('b@example.com')];
    accounts[0].selectionWeight = Number.POSITIVE_INFINITY;
    accounts[1].selectionWeight = Number.NaN;
    const selected = new Set();
    for (let i = 0; i < 200; i++) selected.add(strategy.selectAccount(accounts, 'claude-test', { sessionId: `weight-${i}`, reserveCapacity: false, trackInFlight: false }).account.email);
    assert.equal(selected.size, 2);
});

test('stale last-known critical quota remains blocked while truly unknown quota is eligible', async () => {
    const { SessionHybridStrategy } = await modules();
    const strategy = new SessionHybridStrategy({ quota: { staleMs: 1 } });
    const stale = account('stale@example.com', 0.04);
    stale.quota.lastChecked = Date.now() - 60000;
    stale.quotaThreshold = 0.09;
    const unknown = account('unknown@example.com');
    delete unknown.quota;
    unknown.quotaThreshold = 0.09;
    const options = { sessionId: 'quota-stale', reserveCapacity: false, trackInFlight: false };
    assert.equal(strategy.selectAccount([stale, unknown], 'claude-test', options).account.email, unknown.email);
    assert.equal(strategy.selectAccount([stale], 'claude-test', { ...options, sessionId: 'stale-only' }).account, null);
});

test('cold weighted rendezvous only remaps keys to an added account or away from a removed account', async () => {
    const { SessionHybridStrategy } = await modules();
    const strategy = new SessionHybridStrategy({ tokenBucket: { maxTokens: 10000, initialTokens: 10000 } });
    const original = [account('a@example.com'), account('b@example.com'), account('c@example.com')];
    const expanded = [...original, account('d@example.com')];
    const removed = [original[0], original[2]];
    for (let i = 0; i < 5000; i++) {
        const options = { sessionId: `cold-${i}`, reserveCapacity: false, trackInFlight: false };
        const before = strategy.selectAccount(original, 'claude-test', options).account.email;
        const afterAdd = strategy.selectAccount(expanded, 'claude-test', options).account.email;
        if (afterAdd !== before) assert.equal(afterAdd, 'd@example.com');
        const afterRemove = strategy.selectAccount(removed, 'claude-test', options).account.email;
        if (before !== 'b@example.com') assert.equal(afterRemove, before);
    }
});

test('independent sessions distribute across the account pool', async () => {
    const { SessionHybridStrategy } = await modules();
    const strategy = new SessionHybridStrategy();
    const accounts = [account('a@example.com'), account('b@example.com'), account('c@example.com')];
    const selected = new Set();
    for (let i = 0; i < 100; i++) {
        const result = strategy.selectAccount(accounts, 'claude-test', {
            sessionId: `session-${i}`,
            trackInFlight: false
        });
        selected.add(result.account.email);
    }
    assert.equal(selected.size, 3);
});

test('adding an account does not remap existing live assignments', async () => {
    const { SessionHybridStrategy } = await modules();
    const strategy = new SessionHybridStrategy({
        tokenBucket: { maxTokens: 1000, initialTokens: 1000 }
    });
    const original = [account('a@example.com'), account('b@example.com'), account('c@example.com')];
    const before = new Map();
    for (let i = 0; i < 100; i++) {
        const key = `session-${i}`;
        before.set(key, strategy.selectAccount(original, 'claude-test', {
            sessionId: key,
            trackInFlight: false
        }).account.email);
    }
    const expanded = [...original, account('d@example.com')];
    let remapped = 0;
    for (const [key, email] of before) {
        const next = strategy.selectAccount(expanded, 'claude-test', {
            sessionId: key,
            trackInFlight: false
        }).account.email;
        if (next !== email) remapped++;
    }
    assert.equal(remapped, 0);
});

test('rate limit causes failover and hysteresis prevents flapping', async () => {
    const { SessionHybridStrategy } = await modules();
    const strategy = new SessionHybridStrategy();
    const accounts = [account('a@example.com'), account('b@example.com')];
    const first = strategy.selectAccount(accounts, 'claude-test', {
        sessionId: 'sticky-session',
        trackInFlight: false
    });
    first.account.modelRateLimits = {
        'claude-test': { isRateLimited: true, resetTime: Date.now() + 60000 }
    };
    const failedOver = strategy.selectAccount(accounts, 'claude-test', {
        sessionId: 'sticky-session',
        trackInFlight: false
    });
    assert.notEqual(failedOver.account.email, first.account.email);
    first.account.modelRateLimits = {};
    const held = strategy.selectAccount(accounts, 'claude-test', {
        sessionId: 'sticky-session',
        trackInFlight: false
    });
    assert.equal(held.account.email, failedOver.account.email);
});

test('hard quota floor rejects all critical accounts by default', async () => {
    const { SessionHybridStrategy } = await modules();
    const strategy = new SessionHybridStrategy();
    const accounts = [account('a@example.com', 0.04), account('b@example.com', 0.03)];
    for (const item of accounts) item.quotaThreshold = 0.09;
    const result = strategy.selectAccount(accounts, 'claude-test', { sessionId: 'quota-session' });
    assert.equal(result.account, null);
});

test('zero global quota threshold disables the hard floor', async () => {
    const { SessionHybridStrategy, runtimeConfig } = await modules();
    const previous = runtimeConfig.globalQuotaThreshold;
    runtimeConfig.globalQuotaThreshold = 0;
    try {
        const strategy = new SessionHybridStrategy();
        const result = strategy.selectAccount([account('zero@example.com', 0)], 'claude-test', {
            sessionId: 'zero-floor',
            trackInFlight: false
        });
        assert.equal(result.account.email, 'zero@example.com');
    } finally {
        runtimeConfig.globalQuotaThreshold = previous;
    }
});

test('quota bypass must be explicitly enabled', async () => {
    const { SessionHybridStrategy } = await modules();
    const strategy = new SessionHybridStrategy({
        sessionHybrid: { emergencyQuotaBypass: true }
    });
    const accounts = [account('a@example.com', 0.04), account('b@example.com', 0.03)];
    for (const item of accounts) item.quotaThreshold = 0.09;
    const result = strategy.selectAccount(accounts, 'claude-test', {
        sessionId: 'quota-session',
        trackInFlight: false
    });
    assert.ok(result.account);
});

test('invalid and cooling-down accounts are never selected', async () => {
    const { SessionHybridStrategy } = await modules();
    const strategy = new SessionHybridStrategy();
    const invalid = account('invalid@example.com');
    invalid.isInvalid = true;
    const cooling = account('cooling@example.com');
    cooling.coolingDownUntil = Date.now() + 60000;
    const healthy = account('healthy@example.com');
    const result = strategy.selectAccount([invalid, cooling, healthy], 'claude-test', {
        sessionId: 'usable-session',
        trackInFlight: false
    });
    assert.equal(result.account.email, healthy.email);
});

test('in-flight accounting is released exactly once', async () => {
    const { SessionHybridStrategy } = await modules();
    const strategy = new SessionHybridStrategy();
    const accounts = [account('a@example.com'), account('b@example.com')];
    const result = strategy.selectAccount(accounts, 'claude-test', { sessionId: 'concurrent' });
    assert.equal(strategy.getInFlightCount(result.account.email), 1);
    strategy.onRequestComplete(result.account, 'claude-test', { leaseId: result.leaseId });
    strategy.onRequestComplete(result.account, 'claude-test', { leaseId: result.leaseId });
    assert.equal(strategy.getInFlightCount(result.account.email), 0);
});

test('unknown completions cannot decrement a live lease and stale leases self-heal', async () => {
    const { SessionHybridStrategy } = await modules();
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
        const strategy = new SessionHybridStrategy({
            tokenBucket: { maxTokens: 100, initialTokens: 100 },
            sessionHybrid: { leaseTtlMs: 10 }
        });
        const accounts = [account('lease@example.com')];
        const first = strategy.selectAccount(accounts, 'claude-test', { sessionId: 'lease-one' });
        assert.equal(strategy.getInFlightCount('lease@example.com'), 1);
        strategy.onRequestComplete(first.account, 'claude-test', {});
        strategy.onRequestComplete(first.account, 'claude-test', { leaseId: 'unknown' });
        assert.equal(strategy.getInFlightCount('lease@example.com'), 1);
        now += 11;
        const second = strategy.selectAccount(accounts, 'claude-test', { sessionId: 'lease-two' });
        assert.equal(strategy.getInFlightCount('lease@example.com'), 1);
        strategy.onRequestComplete(second.account, 'claude-test', { leaseId: second.leaseId });
        assert.equal(strategy.getInFlightCount('lease@example.com'), 0);
    } finally {
        Date.now = originalNow;
    }
});

test('synchronous persistence failure rolls back capacity and assignment state', async () => {
    const { SessionHybridStrategy } = await modules();
    const strategy = new SessionHybridStrategy({ tokenBucket: { maxTokens: 5, initialTokens: 5 } });
    const accounts = [account('rollback@example.com')];
    assert.throws(() => strategy.selectAccount(accounts, 'claude-test', {
        sessionId: 'rollback',
        onSave: () => { throw new Error('save failed'); }
    }), /save failed/);
    assert.equal(strategy.getAssignmentCount(), 0);
    assert.equal(strategy.getTokenBucketTracker().getTokens('rollback@example.com'), 5);
    assert.equal(strategy.getInFlightCount('rollback@example.com'), 0);
});

test('concurrent independent sessions account for pressure and release all leases', async () => {
    const { SessionHybridStrategy } = await modules();
    const strategy = new SessionHybridStrategy({
        tokenBucket: { maxTokens: 1000, initialTokens: 1000 },
        sessionHybrid: { concurrencyPenalty: 1 }
    });
    const accounts = [account('a@example.com'), account('b@example.com'), account('c@example.com')];
    const leases = [];
    for (let i = 0; i < 60; i++) {
        leases.push(strategy.selectAccount(accounts, 'claude-test', { sessionId: `parallel-${i}` }));
    }
    const used = new Set(leases.map((lease) => lease.account.email));
    assert.equal(used.size, 3);
    for (const lease of leases) {
        strategy.onRequestComplete(lease.account, 'claude-test', { leaseId: lease.leaseId });
    }
    for (const item of accounts) assert.equal(strategy.getInFlightCount(item.email), 0);
});

test('affinity fallback is stable across later turns and user_id alone does not merge threads', async () => {
    const { affinity } = await modules();
    const first = { metadata: { user_id: 'user-1' }, messages: [{ role: 'user', content: 'alpha' }] };
    const later = {
        metadata: { user_id: 'user-1' },
        messages: [{ role: 'user', content: 'alpha' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'beta' }]
    };
    const other = { metadata: { user_id: 'user-1' }, messages: [{ role: 'user', content: 'different thread' }] };
    assert.equal(affinity.deriveAffinityKey(first), affinity.deriveAffinityKey(later));
    assert.notEqual(affinity.deriveAffinityKey(first), affinity.deriveAffinityKey(other));
    assert.equal(
        affinity.deriveAffinityKey(first, 'external-secret'),
        affinity.deriveAffinityKey(other, 'external-secret')
    );
    assert.doesNotMatch(affinity.deriveAffinityKey(first, 'external-secret'), /external-secret/);
});

test('affinity fallback uses typed canonical serialization without delimiter collisions', async () => {
    const { affinity } = await modules();
    const onePart = { messages: [{ role: 'user', content: [{ type: 'text', text: 'a|b' }] }] };
    const twoParts = { messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, 'b'] }] };
    assert.notEqual(affinity.deriveAffinityKey(onePart), affinity.deriveAffinityKey(twoParts));
});

test('client scope isolates identical explicit IDs and fallback prompts', async () => {
    const { affinity } = await modules();
    const request = { messages: [{ role: 'user', content: 'same opening' }] };
    assert.notEqual(
        affinity.deriveAffinityKey(request, 'thread-1', 'openclaw'),
        affinity.deriveAffinityKey(request, 'thread-1', 'paperclip')
    );
    assert.notEqual(
        affinity.deriveAffinityKey(request, null, 'openclaw'),
        affinity.deriveAffinityKey(request, null, 'opencode')
    );
    assert.equal(
        affinity.getAffinityClientScope({ 'x-antigravity-client-id': 'paperclip', 'user-agent': 'shared' }),
        'paperclip'
    );
});

test('preset serializer round-trips Session Hybrid settings without crashing', () => {
    const source = fs.readFileSync('public/js/components/server-config.js', 'utf8');
    const context = { window: { Components: {} } };
    vm.runInNewContext(source, context);
    const component = context.window.Components.serverConfig();
    const config = {
        accountSelection: {
            strategy: 'session-hybrid',
            sessionHybrid: {
                emergencyQuotaBypass: false,
                concurrencyPenalty: 0.5,
                assignmentTtlMs: 120000,
                leaseTtlMs: 60000,
                maxAssignments: 250,
                sessionStoreTtlMs: 180000,
                maxSessionEntries: 300
            }
        }
    };
    const rebuilt = component.buildConfigFromDraft(component.flattenConfigToDraft(config));
    assert.equal(rebuilt.accountSelection.strategy, 'session-hybrid');
    assert.deepEqual(JSON.parse(JSON.stringify(rebuilt.accountSelection.sessionHybrid)), config.accountSelection.sessionHybrid);
    assert.doesNotThrow(() => component.buildConfigFromDraft(component.flattenConfigToDraft({ accountSelection: { strategy: 'hybrid' } })));
});

test('Cloud Code session IDs are stable per conversation+account and handlers expose both modes', async () => {
    const { session, builder, message, streaming } = await modules();
    session.clearSessionStore();
    const request = { model: 'claude-test', messages: [{ role: 'user', content: 'hello' }] };
    const key = 'hashed-affinity';
    const id1 = session.deriveSessionId(request, 'a@example.com', key);
    const id2 = session.deriveSessionId(request, 'a@example.com', key);
    const id3 = session.deriveSessionId(request, 'b@example.com', key);
    assert.equal(id1, id2);
    assert.notEqual(id1, id3);
    const payload = builder.buildCloudCodeRequest(request, 'project', 'a@example.com', key);
    assert.equal(payload.request.sessionId, id1);
    assert.equal(typeof message.sendMessage, 'function');
    assert.equal(typeof streaming.sendMessageStream, 'function');
});

test('runtime session store separates models, expires idle entries, and caps LRU size', async () => {
    const { session, runtimeConfig } = await modules();
    const originalNow = Date.now;
    const sh = runtimeConfig.accountSelection.sessionHybrid;
    const previous = { sessionStoreTtlMs: sh.sessionStoreTtlMs, maxSessionEntries: sh.maxSessionEntries };
    let now = 1000;
    Date.now = () => now;
    sh.sessionStoreTtlMs = 10;
    sh.maxSessionEntries = 2;
    session.clearSessionStore();
    try {
        const base = { model: 'model-a', messages: [{ role: 'user', content: 'one' }] };
        const idA = session.deriveSessionId(base, 'account@example.com', 'affinity-a');
        assert.notEqual(idA, session.deriveSessionId({ ...base, model: 'model-b' }, 'account@example.com', 'affinity-a'));
        session.deriveSessionId(base, 'account@example.com', 'affinity-b');
        const idAfterCap = session.deriveSessionId(base, 'account@example.com', 'affinity-a');
        assert.notEqual(idAfterCap, idA);
        now = 2000;
        assert.notEqual(session.deriveSessionId(base, 'account@example.com', 'affinity-a'), idAfterCap);
    } finally {
        Date.now = originalNow;
        Object.assign(sh, previous);
        session.clearSessionStore();
    }
});

function fakeManager() {
    const selectedOptions = [];
    const completed = [];
    const successes = [];
    const activeLeases = new Set();
    const releaseCounts = new Map();
    const selectedAccount = account('integration@example.com');
    return {
        selectedOptions,
        completed,
        successes,
        activeLeases,
        releaseCounts,
        getAccountCount: () => 1,
        clearExpiredLimits: () => 0,
        getAvailableAccounts: () => [selectedAccount],
        isAllAccountsInvalid: () => false,
        isAllRateLimited: () => false,
        selectAccount: (model, options) => {
            selectedOptions.push(options);
            const leaseId = `lease-${selectedOptions.length}`;
            activeLeases.add(leaseId);
            return { account: selectedAccount, waitMs: 0, leaseId };
        },
        getTokenForAccount: async () => 'token',
        getProjectForAccount: async () => 'project',
        notifySuccess: (selected, model) => successes.push({ selected, model }),
        notifyRateLimit: () => {},
        notifyFailure: () => {},
        notifyRequestComplete: (selected, model, options) => {
            completed.push({ selected, model, options });
            releaseCounts.set(options.leaseId, (releaseCounts.get(options.leaseId) || 0) + 1);
            activeLeases.delete(options.leaseId);
        },
        getConsecutiveFailures: () => 0,
        incrementConsecutiveFailures: () => 1,
        markRateLimited: () => {},
        clearTokenCache: () => {},
        clearProjectCache: () => {},
        markInvalid: () => {}
    };
}

function assertAllLeasesReleased(manager) {
    assert.equal(manager.activeLeases.size, 0);
    assert.equal(manager.completed.length, manager.selectedOptions.length);
    for (const count of manager.releaseCounts.values()) assert.equal(count, 1);
}

test('non-streaming handler passes affinity before selection and releases lease', async () => {
    const { message } = await modules();
    const manager = fakeManager();
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    try {
        const response = await message.sendMessage({
            model: 'gemini-2.5-flash',
            messages: [{ role: 'user', content: 'non-stream integration' }],
            affinityKey: 'hashed-session'
        }, manager, false);
        assert.equal(response.content[0].text, 'ok');
        assert.equal(manager.selectedOptions[0].sessionId, 'hashed-session');
        assert.equal(manager.completed.length, 1);
        assert.equal(manager.completed[0].options.leaseId, 'lease-1');
        assert.equal(manager.successes.length, 1);
        assertAllLeasesReleased(manager);
    } finally {
        global.fetch = originalFetch;
    }
});

test('streaming handler passes affinity before selection and releases lease', async () => {
    const { streaming } = await modules();
    const manager = fakeManager();
    const originalFetch = global.fetch;
    const sse = `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'stream-ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
    })}\n\n`;
    global.fetch = async () => new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
    });
    try {
        const events = [];
        for await (const event of streaming.sendMessageStream({
            model: 'gemini-2.5-flash',
            messages: [{ role: 'user', content: 'stream integration' }],
            affinityKey: 'hashed-stream-session'
        }, manager, false)) events.push(event);
        assert.ok(events.length > 0);
        assert.equal(manager.selectedOptions[0].sessionId, 'hashed-stream-session');
        assert.equal(manager.completed.length, 1);
        assert.equal(manager.completed[0].options.leaseId, 'lease-1');
        assert.equal(manager.successes.length, 1);
        assertAllLeasesReleased(manager);
    } finally {
        global.fetch = originalFetch;
    }
});

test('non-streaming lifecycle releases leases on fetch throw and response read failure', async () => {
    const { message } = await modules();
    const originalFetch = global.fetch;
    try {
        for (const failingFetch of [async () => { throw new Error('synthetic fetch throw'); }, async () => ({ ok: false, status: 400, text: async () => { throw new Error('synthetic read failure'); } })]) {
            const manager = fakeManager();
            global.fetch = failingFetch;
            await assert.rejects(() => message.sendMessage({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'failure' }], affinityKey: 'failure-key' }, manager, false));
            assertAllLeasesReleased(manager);
        }
    } finally {
        global.fetch = originalFetch;
    }
});

test('429 quick retry keeps one lease and releases it exactly once', async () => {
    const { message } = await modules();
    const manager = fakeManager();
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
        calls++;
        if (calls === 1) {
            return new Response('RESOURCE_EXHAUSTED quotaResetDelay: 1ms', {
                status: 429,
                headers: { 'content-type': 'application/json' }
            });
        }
        return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'retried-ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
        const response = await message.sendMessage({
            model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'retry' }], affinityKey: 'retry-key'
        }, manager, false);
        assert.equal(response.content[0].text, 'retried-ok');
        assert.equal(calls, 2);
        assert.equal(manager.selectedOptions.length, 1);
        assertAllLeasesReleased(manager);
    } finally {
        global.fetch = originalFetch;
    }
});

test('streaming lifecycle releases leases on reader error and early cancellation', async () => {
    const { streaming } = await modules();
    const originalFetch = global.fetch;
    try {
        const readManager = fakeManager();
        global.fetch = async () => ({ ok: true, body: { getReader: () => ({ read: async () => { throw new Error('synthetic reader failure'); } }) } });
        await assert.rejects(async () => {
            for await (const _event of streaming.sendMessageStream({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'read failure' }], affinityKey: 'read-key' }, readManager, false)) { /* consume */ }
        });
        assertAllLeasesReleased(readManager);
        const cancelManager = fakeManager();
        const sse = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'first' }] } }] })}\n\n`;
        global.fetch = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        const iterator = streaming.sendMessageStream({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'cancel' }], affinityKey: 'cancel-key' }, cancelManager, false);
        await iterator.next();
        await iterator.return();
        assertAllLeasesReleased(cancelManager);
    } finally {
        global.fetch = originalFetch;
    }
});

test('rate-limit maintenance timer does not keep handler imports alive', async () => {
    const result = await execFileAsync(process.execPath, [
        '-e',
        "Promise.all([import('./src/cloudcode/message-handler.js'), import('./src/cloudcode/streaming-handler.js')]).then(() => console.log('imports-exited'))"
    ], { cwd: process.cwd(), timeout: 3000 });
    assert.match(result.stdout, /imports-exited/);
});


test('normal builder entry keeps fallback IDs restart-stable and client/model scoped', async () => {
    const { session, builder, affinity } = await modules();
    const request = { model: 'claude-test', messages: [{ role: 'user', content: 'restart proof' }] };
    const keyA = affinity.deriveAffinityKey(request, null, 'client-a');
    const keyB = affinity.deriveAffinityKey(request, null, 'client-b');
    const id = builder.buildCloudCodeRequest(request, 'project', 'a@example.com', keyA).request.sessionId;
    session.clearSessionStore();
    assert.equal(builder.buildCloudCodeRequest(request, 'project', 'a@example.com', keyA).request.sessionId, id);
    assert.notEqual(builder.buildCloudCodeRequest(request, 'project', 'a@example.com', keyB).request.sessionId, id);
    assert.notEqual(builder.buildCloudCodeRequest({ ...request, model: 'other' }, 'project', 'a@example.com', keyA).request.sessionId, id);
});
