# Plus / Pro tiers (future)

Monetization applies to **hosted pqp.gg only**. Self-host remains unlimited open source.

## Planned tiers

| Tier | Audience | Features (draft) |
|---|---|---|
| **Free** | Small groups | Voice, text channels, limited servers |
| **Plus** | Power users | More servers/channels, custom domains |
| **Pro** | Communities | Higher limits, priority support, analytics |

**Superseded, 2026-09-06: SFU voice is not a paid gate and cannot become one.**
`server/src/voice/transport-policy.ts` routes every listed community and every
server of ten or more members onto the media server, for free, for everybody.
The SFU is a cost centre, not a tier lever, and taking it back from the rooms
that already have it would be a takeaway. Re-price this table before anyone
builds against it.

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
