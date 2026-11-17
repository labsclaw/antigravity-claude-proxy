/**
 * Session Hybrid Strategy
 *
 * Keeps a conversation+model on one account while it is usable. Initial
 * placement and failover use weighted rendezvous hashing, so account pool
 * changes remap only the sessions that need to move.
 */

import crypto from 'crypto';
import { BaseStrategy } from './base-strategy.js';
import { HealthTracker, TokenBucketTracker, QuotaTracker } from './trackers/index.js';
import { config as runtimeConfig } from '../../config.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_WEIGHTS = { health: 3, tokens: 3, quota: 5 };
const DEFAULT_CONFIG = {
    emergencyQuotaBypass: false,
    concurrencyPenalty: 0.35,
    assignmentTtlMs: 24 * 60 * 60 * 1000,
    leaseTtlMs: 10 * 60 * 1000,
    maxAssignments: 10000
};

function finiteNumber(value, fallback, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return fallback;
    return value;
}

function positiveInteger(value, fallback, max) {
    return Math.trunc(finiteNumber(value, fallback, 1, max));
}

function accountKey(account, index) {
    return String(account?.email || account?.id || `account-${index}`);
}

function hashUnit(value) {
    const digest = crypto.createHash('sha256').update(value).digest();
    const integer = digest.readBigUInt64BE(0);
    return (Number(integer >> 11n) + 1) / 9007199254740993;
}

export class SessionHybridStrategy extends BaseStrategy {
    #healthTracker;
    #tokenBucketTracker;
    #quotaTracker;
    #weights;
    #settings;
    #assignments = new Map();
    #inFlight = new Map();
    #leases = new Map();
    #leaseCounter = 0;

    constructor(config = {}) {
        super(config);
        const health = config.healthScore || {};
        const tokenBucket = config.tokenBucket || {};
        const quota = config.quota || {};
        const rawWeights = config.weights || {};
        const rawSettings = config.sessionHybrid || {};
        this.#healthTracker = new HealthTracker({
            initial: finiteNumber(health.initial, 70, 0, 100), successReward: finiteNumber(health.successReward, 1, 0, 100),
            rateLimitPenalty: finiteNumber(health.rateLimitPenalty, -10, -100, 0), failurePenalty: finiteNumber(health.failurePenalty, -20, -100, 0),
            recoveryPerHour: finiteNumber(health.recoveryPerHour, 10, 0, 1000), minUsable: finiteNumber(health.minUsable, 50, 0, 100),
            maxScore: finiteNumber(health.maxScore, 100, 1, 100)
        });
        const maxTokens = positiveInteger(tokenBucket.maxTokens, 50, 1000000);
        this.#tokenBucketTracker = new TokenBucketTracker({
            maxTokens, initialTokens: finiteNumber(tokenBucket.initialTokens, Math.min(50, maxTokens), 0, maxTokens),
            tokensPerMinute: finiteNumber(tokenBucket.tokensPerMinute, 6, 0.001, 1000000)
        });
        const criticalThreshold = finiteNumber(quota.criticalThreshold, 0.05, 0, 1);
        this.#quotaTracker = new QuotaTracker({
            criticalThreshold, lowThreshold: finiteNumber(quota.lowThreshold, 0.10, criticalThreshold, 1),
            staleMs: finiteNumber(quota.staleMs, 300000, 1, 365 * 24 * 60 * 60 * 1000), unknownScore: finiteNumber(quota.unknownScore, 50, 0, 100)
        });
        this.#weights = {
            health: finiteNumber(rawWeights.health, DEFAULT_WEIGHTS.health, 0, 1000000),
            tokens: finiteNumber(rawWeights.tokens, DEFAULT_WEIGHTS.tokens, 0, 1000000),
            quota: finiteNumber(rawWeights.quota, DEFAULT_WEIGHTS.quota, 0, 1000000)
        };
        if (this.#weights.health + this.#weights.tokens + this.#weights.quota <= 0) this.#weights = { ...DEFAULT_WEIGHTS };
        this.#settings = {
            emergencyQuotaBypass: rawSettings.emergencyQuotaBypass === true,
            concurrencyPenalty: finiteNumber(rawSettings.concurrencyPenalty, DEFAULT_CONFIG.concurrencyPenalty, 0, 100),
            assignmentTtlMs: finiteNumber(rawSettings.assignmentTtlMs, DEFAULT_CONFIG.assignmentTtlMs, 1, 365 * 24 * 60 * 60 * 1000),
            leaseTtlMs: finiteNumber(rawSettings.leaseTtlMs, DEFAULT_CONFIG.leaseTtlMs, 1, 24 * 60 * 60 * 1000),
            maxAssignments: positiveInteger(rawSettings.maxAssignments, DEFAULT_CONFIG.maxAssignments, 1000000)
        };
    }

    selectAccount(accounts, modelId, options = {}) {
        if (!accounts.length) return { account: null, index: 0, waitMs: 0 };

        const reserveCapacity = options.reserveCapacity !== false;
        if (reserveCapacity) {
            this.#pruneExpiredAssignments();
            this.#pruneExpiredLeases();
        }
        const affinityKey = options.sessionId || options.affinityKey || 'anonymous';
        const assignmentKey = `${affinityKey}\u0000${modelId || 'default'}`;
        let candidates = this.#getCandidates(accounts, modelId, false);
        let emergencyQuotaBypass = false;

        if (!candidates.length && this.#settings.emergencyQuotaBypass === true) {
            candidates = this.#getCandidates(accounts, modelId, true);
            emergencyQuotaBypass = candidates.length > 0;
            if (emergencyQuotaBypass) {
                logger.warn('[SessionHybridStrategy] Explicit emergency quota bypass is active');
            }
        }

        if (!candidates.length) {
            return { account: null, index: 0, waitMs: this.#minimumTokenWait(accounts) };
        }

        const assigned = this.#assignments.get(assignmentKey);
        const previousAssignment = assigned ? { ...assigned } : null;
        let evictedAssignments = [];
        let selected = assigned
            ? candidates.find((candidate) => accountKey(candidate.account, candidate.index) === assigned.accountKey)
            : null;

        if (!selected) {
            selected = this.#rank(candidates, assignmentKey, modelId)[0];
            if (reserveCapacity) {
                evictedAssignments = this.#evictForInsert();
                this.#assignments.set(assignmentKey, {
                    accountKey: accountKey(selected.account, selected.index),
                    updatedAt: Date.now()
                });
                if (assigned) logger.info('[SessionHybridStrategy] Affinity failover applied; replacement stays sticky until failure or expiry');
            }
        } else if (reserveCapacity) {
            assigned.updatedAt = Date.now();
            this.#assignments.delete(assignmentKey);
            this.#assignments.set(assignmentKey, assigned);
        }

        const previousLastUsed = selected.account.lastUsed;
        let tokenConsumed = false;
        if (reserveCapacity) {
            try {
                tokenConsumed = this.#tokenBucketTracker.consume(selected.account.email);
                selected.account.lastUsed = Date.now();
                if (options.onSave) {
                    const saveResult = options.onSave();
                    saveResult?.catch?.((error) => logger.error('[SessionHybridStrategy] Failed to persist selection state', error));
                }
            } catch (error) {
                if (tokenConsumed) this.#tokenBucketTracker.refund(selected.account.email);
                selected.account.lastUsed = previousLastUsed;
                this.#assignments.delete(assignmentKey);
                if (previousAssignment) this.#assignments.set(assignmentKey, previousAssignment);
                for (const [key, value] of evictedAssignments) this.#assignments.set(key, value);
                throw error;
            }
        }

        let leaseId;
        if (reserveCapacity && options.trackInFlight !== false) {
            const key = accountKey(selected.account, selected.index);
            this.#inFlight.set(key, (this.#inFlight.get(key) || 0) + 1);
            leaseId = `session-hybrid-${++this.#leaseCounter}`;
            this.#leases.set(leaseId, { key, createdAt: Date.now() });
        }

        logger.debug(`[SessionHybridStrategy] Account selected (${selected.index + 1}/${accounts.length}${emergencyQuotaBypass ? ', quota bypass' : ''})`);
        return { account: selected.account, index: selected.index, waitMs: 0, leaseId };
    }

    onSuccess(account) {
        if (account?.email) this.#healthTracker.recordSuccess(account.email);
    }

    onRateLimit(account) {
        if (account?.email) this.#healthTracker.recordRateLimit(account.email);
    }

    onFailure(account) {
        if (!account?.email) return;
        this.#healthTracker.recordFailure(account.email);
        this.#tokenBucketTracker.refund(account.email);
    }

    onRequestComplete(account, modelId, options = {}) {
        const leaseId = options.leaseId;
        if (!leaseId) return;
        const lease = this.#leases.get(leaseId);
        if (!lease) return;
        this.#leases.delete(leaseId);
        const key = lease.key;
        const next = Math.max(0, (this.#inFlight.get(key) || 0) - 1);
        if (next === 0) this.#inFlight.delete(key);
        else this.#inFlight.set(key, next);
    }

    getInFlightCount(email) {
        return this.#inFlight.get(email) || 0;
    }

    getAssignmentCount() {
        return this.#assignments.size;
    }

    getHealthTracker() {
        return this.#healthTracker;
    }

    getTokenBucketTracker() {
        return this.#tokenBucketTracker;
    }

    getQuotaTracker() {
        return this.#quotaTracker;
    }

    #getCandidates(accounts, modelId, bypassQuota) {
        return accounts.map((account, index) => ({ account, index })).filter(({ account }) => {
            if (!this.isAccountUsable(account, modelId)) return false;
            if (!this.#healthTracker.isUsable(account.email)) return false;
            if (!this.#tokenBucketTracker.hasTokens(account.email)) return false;
            if (!bypassQuota && this.#isBelowHardQuotaFloor(account, modelId)) return false;
            return true;
        });
    }

    #isBelowHardQuotaFloor(account, modelId) {
        const configuredThreshold = account.modelQuotaThresholds?.[modelId]
            ?? account.quotaThreshold
            ?? runtimeConfig.globalQuotaThreshold
            ?? this.#quotaTracker.getCriticalThreshold();
        const threshold = typeof configuredThreshold === 'number'
            && Number.isFinite(configuredThreshold)
            && configuredThreshold >= 0
            && configuredThreshold <= 1
            ? configuredThreshold
            : this.#quotaTracker.getCriticalThreshold();
        if (threshold === 0) return false;
        // Stale quota must not permanently exclude accounts (matches QuotaTracker.isQuotaCritical)
        if (!this.#quotaTracker.isQuotaFresh(account)) return false;
        const lastKnownFraction = this.#quotaTracker.getQuotaFraction(account, modelId);
        return lastKnownFraction !== null && lastKnownFraction <= threshold;
    }

    #rank(candidates, assignmentKey, modelId) {
        return candidates.map((candidate) => {
            const identity = accountKey(candidate.account, candidate.index);
            const qualityWeight = this.#qualityWeight(candidate.account, modelId, identity);
            const u = hashUnit(`${assignmentKey}\u0000${identity}`);
            return { ...candidate, rendezvousScore: -Math.log(u) / qualityWeight };
        }).sort((a, b) => a.rendezvousScore - b.rendezvousScore);
    }

    #qualityWeight(account, modelId, identity) {
        const health = this.#healthTracker.getScore(account.email) / 100;
        const tokens = this.#tokenBucketTracker.getTokens(account.email)
            / this.#tokenBucketTracker.getMaxTokens();
        const quota = this.#quotaTracker.getScore(account, modelId) / 100;
        const weightSum = this.#weights.health + this.#weights.tokens + this.#weights.quota || 1;
        const quality = (
            health * this.#weights.health
            + tokens * this.#weights.tokens
            + quota * this.#weights.quota
        ) / weightSum;
        const pressure = 1 + (this.#inFlight.get(identity) || 0) * this.#settings.concurrencyPenalty;
        const staticWeight = finiteNumber(account.selectionWeight, 1, 0.01, 1000);
        const weightedQuality = quality * staticWeight / pressure;
        return Number.isFinite(weightedQuality) ? Math.max(0.001, weightedQuality) : 0.001;
    }

    #minimumTokenWait(accounts) {
        const emails = accounts
            .filter((account) => this.isAccountUsable(account, null))
            .map((account) => account.email)
            .filter(Boolean);
        return this.#tokenBucketTracker.getMinTimeUntilToken(emails);
    }

    #pruneExpiredAssignments() {
        const now = Date.now();
        while (this.#assignments.size > 0) {
            const [key, assignment] = this.#assignments.entries().next().value;
            if (now - assignment.updatedAt <= this.#settings.assignmentTtlMs) break;
            this.#assignments.delete(key);
        }
    }

    #pruneExpiredLeases() {
        const now = Date.now();
        while (this.#leases.size > 0) {
            const [leaseId, lease] = this.#leases.entries().next().value;
            if (now - lease.createdAt <= this.#settings.leaseTtlMs) break;
            this.#leases.delete(leaseId);
            const next = Math.max(0, (this.#inFlight.get(lease.key) || 0) - 1);
            if (next === 0) this.#inFlight.delete(lease.key);
            else this.#inFlight.set(lease.key, next);
        }
    }

    #evictForInsert() {
        const evicted = [];
        while (this.#assignments.size >= this.#settings.maxAssignments) {
            const key = this.#assignments.keys().next().value;
            evicted.push([key, this.#assignments.get(key)]);
            this.#assignments.delete(key);
        }
        return evicted;
    }
}

export default SessionHybridStrategy;
