# Multi-Account Load Balancing

When you add multiple accounts, the proxy intelligently distributes requests across them using configurable selection strategies.

## Account Selection Strategies

Choose a strategy based on your needs:

| Strategy | Best For | Description |
| --- | --- | --- |
| **Hybrid** (Default) | Most users | Smart selection combining health score, token bucket rate limiting, quota awareness, and LRU freshness |
| **Session Hybrid** | Long-running agent conversations | Conversation+model affinity with weighted rendezvous placement, hard quota protection, concurrency pressure, and low-churn failover |
| **Sticky** | Prompt caching | Stays on the same account to maximize cache hits, switches only when rate-limited |
| **Round-Robin** | Even distribution | Cycles through accounts sequentially for balanced load |

**Configure via CLI:**

```bash
antigravity-claude-proxy start --strategy=hybrid    # Default: smart distribution
antigravity-claude-proxy start --strategy=sticky    # Cache-optimized
antigravity-claude-proxy start --strategy=round-robin  # Load-balanced
antigravity-claude-proxy start --strategy=session-hybrid # Conversation affinity
```

**Or via WebUI:** Settings → Server → Account Selection Strategy

## How It Works

- **Health Score Tracking**: Accounts earn points for successful requests and lose points for failures/rate-limits
- **Token Bucket Rate Limiting**: Client-side throttling with regenerating tokens (50 max, 6/minute)
- **Quota Awareness**: Accounts below configurable quota thresholds are deprioritized; exhausted accounts trigger emergency fallback
- **Quota Protection**: Set minimum quota levels globally, per-account, or per-model to switch accounts before quota runs out
- **Emergency Fallback**: When all accounts appear exhausted, bypasses checks with throttle delays (250-500ms)
- **Automatic Cooldown**: Rate-limited accounts recover automatically after reset time expires
- **Invalid Account Detection**: Accounts needing re-authentication are marked and skipped
- **Prompt Caching Support**: Session IDs derived from conversation enable cache hits across turns

### Session Hybrid affinity

`session-hybrid` is client-neutral and works with OpenClaw, Paperclip, OpenCode,
or any Anthropic-compatible client. Affinity is resolved in this order:

1. `x-antigravity-session-id`, `x-session-id`, or `x-conversation-id` header.
2. Stable `metadata.session_id`, `conversation_id`, or `thread_id` fields.
3. A privacy-safe hash of the first conversation turn (optionally scoped by `metadata.user_id`).

External identifiers are hashed before use and never select an account directly.
Clients should also send a stable `x-antigravity-client-id` (for example,
`openclaw`, `paperclip`, or `opencode`) so common conversation IDs are isolated
between callers. The proxy uses User-Agent as a compatibility fallback.
`globalQuotaThreshold` is a hard floor. Critical-quota accounts are only used when
`accountSelection.sessionHybrid.emergencyQuotaBypass` is explicitly enabled.
After failover, the replacement binding remains sticky until it becomes unusable
or `assignmentTtlMs` expires; active conversations are not automatically moved
back to recovered accounts. Validation previews are read-only and do not consume
tokens, create bindings, update LRU state, or increment in-flight counters.

The upstream session cache is keyed by account, conversation, and model. Its idle
TTL is configured with `sessionStoreTtlMs` (default 24 hours) and its LRU capacity
with `maxSessionEntries` (default 10,000). Backend updates accept TTL values from
one minute to one year and entry limits from 100 to 1,000,000.
In-flight leases self-heal after `leaseTtlMs` (default 10 minutes) if a client or
upstream disappears without completing request cleanup.

## Monitoring

Check account status, subscription tiers, and quota anytime:

```bash
# Web UI: http://localhost:8080/ (Accounts tab - shows tier badges and quota progress)
# CLI Table:
curl "http://localhost:8080/account-limits?format=table"
```

### CLI Management Reference

If you prefer using the terminal for management:

```bash
# List all accounts
antigravity-claude-proxy accounts list

# Verify account health
antigravity-claude-proxy accounts verify

# Interactive CLI menu
antigravity-claude-proxy accounts
```
