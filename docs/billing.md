# Plus / Pro tiers (future)

Monetization applies to **hosted pqp.gg only**. Self-host remains unlimited open source.

## Planned tiers

| Tier | Audience | Features (draft) |
|---|---|---|
| **Free** | Small groups | Mesh voice, text channels, limited servers |
| **Plus** | Power users | More servers/channels, SFU voice, custom domains |
| **Pro** | Communities | Higher limits, priority support, analytics |

## Implementation path

1. **Clerk Organizations** — map servers to orgs for multi-tenant billing
2. **Clerk Billing** — Stripe-backed subscriptions for Plus/Pro
3. **Feature gates** — server-side checks on create limits, SFU access
4. **Self-host** — no gates; same codebase, `DEPLOYMENT=selfhost` env

## Not in scope yet

- Stripe directly (use Clerk Billing)
- Usage metering for voice GB
- Billing UI

See [ARCHITECTURE.md](../ARCHITECTURE.md) for product positioning.
