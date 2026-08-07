# Launch plan — pqp.gg

> Drafted 2026-08-07 against `feat/ios-app` @ `d36f73b`. Companion to
> [`HANDOVER.md`](./HANDOVER.md) and [`PLAN_STATUS.md`](./PLAN_STATUS.md).
> Every claim below cites the file it came from — verify before acting on it.

> **Status 2026-08-07:** the P0 code work is done on `launch/p0-hardening`
> (branch off `main`, so it ships without the iOS work). What remains is
> Railway configuration and two things that need a human in Brazil — both
> called out below. Load numbers are in §T1.

## Reality check

Three asks in the brief cannot all be true today:

- **"Everything scalable"** — the server is single-process *by construction*
  (§S1). Making it horizontally scalable is a subsystem change, not a fix.
- **"Bug free"** — not a reachable state. What is reachable: no known P0s, a
  load number you trust, and a rollback you have rehearsed.
- **"Release mobile today"** — App Store review alone is days to weeks. The
  PWA already ships and is the only mobile that can go live today (§M2).

What *is* achievable today: a **soft launch on one container with a known
ceiling and a waitlist/invite gate**, with pt-BR and iOS following on a
schedule. The gate is what turns "we might get swamped" into a non-event.

Ordering below is by launch risk, not by effort.

---

## P0 — blocks any launch

### S1. The server cannot run more than one replica

`connections` (`server/src/ws/chat.ts:32`), `channelPresence`
(`chat.ts:38`), voice `peers` (`server/src/ws/voice.ts:32`) and the rate-limit
buckets (`server/src/lib/rate-limit.ts:1-6`, which says so in its own header
comment) are all in-process `Map`s.

Scaling Railway to 2 replicas does not fail loudly — it **silently splits the
userbase**. Two users on different replicas share a channel, see each other's
presence as offline, and never receive each other's messages. Voice signaling
never connects them. Rate limits multiply by replica count.

Pick one, today:

- **(a) Stay at one container.** Vertically scale it, cap signups behind an
  invite gate, and *pin the replica count to 1 in Railway so nobody scales it
  by reflex during a traffic spike.* This is the launch-today answer.
- **(b) Add a pub/sub layer** behind `broadcastToChannel` + a shared limiter
  (Redis, or Postgres `LISTEN/NOTIFY` since Postgres is already there). Days
  of work, needs its own soak test.

**Do (a) now and (b) before any marketing push.** Write the chosen ceiling into
`HANDOVER.md` so the next person doesn't scale into an outage.

**(b) is now built, behind a flag that is OFF.** `CLUSTER_BUS=postgres` puts
chat fan-out — broadcasts, presence, typing, unread badges and evictions — on
Postgres `LISTEN/NOTIFY` (`server/src/lib/bus.ts`, `bus-postgres.ts`). Unset,
every path is exactly what it was. Three things to know before turning it on:

- **Voice is not on the bus and cannot be.** A mesh room's peer registry,
  roster and size ceiling are per-process, and relaying signaling alone would
  produce two half-rooms that each believe they are whole — see the block
  comment above `peers` in `server/src/ws/voice.ts`. **Mesh voice pins the
  deployment to one instance.** Multi-instance requires LiveKit
  (`LIVEKIT_*`), where media never touches our relay; what still degrades
  there is the voice *roster*, i.e. occupancy badges show only your own
  instance's participants.
- **Rate limits stay per-instance.** Per-user WS limits are exact for a
  single-socket user and multiply by the number of instances a user holds
  sockets on; HTTP limits multiply by the replica count outright. The header
  of `server/src/lib/rate-limit.ts` states each case.
- **Not yet soaked.** Unit-tested across two simulated instances and against a
  real Postgres, never run on two real replicas under load.

### S2. Every message is fanned out by scanning every connection — ✅ DONE

`broadcastToChannel` (`chat.ts:116-129`) loops over *all* connections on the
process and filters by `conn.channelId`. That is O(total sockets) per message,
not O(channel viewers). At 5k sockets, a 20 msg/s channel does 100k iterations
a second plus a `send` syscall check on each.

`channelPresence` (`chat.ts:38`) is already the exact index needed and is
maintained on join/leave. Broadcast should read from it. Small, contained,
high-headroom fix — do this before load testing so the number you get is real.

### O2. First request of a brand-new account can 500 — ✅ DONE

`upsertUser` (`server/src/services/users.ts:165-209`) does `SELECT ... WHERE
clerk_id` then `INSERT`, with no transaction and no `ON CONFLICT`. On first
load the client authenticates over HTTP *and* opens the WS nearly
simultaneously — two concurrent upserts for the same brand-new `clerk_id`. One
wins; the other hits the `clerk_id` UNIQUE (`schema.sql:5`) and throws.

The user's very first impression is a crash, and a retry does fix it — which is
why this survives testing and bites on launch day when signups are concurrent.

Fix: `INSERT ... ON CONFLICT (clerk_id) DO UPDATE SET ... RETURNING`.

### N2. Discriminator allocation is a race — ✅ DONE

`allocateDiscriminator` (`users.ts:35-47`) picks a random number, `SELECT`s to
check it's free, and returns it — the caller then `INSERT`s. Classic TOCTOU.
Two concurrent signups deriving the same slug can pick the same number.

The partial unique index (`schema.sql:16-18`) protects data integrity, so this
is a 500 and a failed signup, not a duplicate handle. Correct fix is to drop
the pre-check and instead retry the `INSERT` on SQLSTATE `23505`.

### N3. Common Brazilian first names will exhaust the handle space — ✅ DONE

Same function: 9,999 slots per username, probed **randomly**, 40 attempts, then
`throw new Error("Could not allocate username discriminator")`.

Brazilian given names are heavily concentrated — `joao`, `pedro`, `gabriel`,
`maria`, `ana`, `lucas`. Random probing degrades badly as a slug fills: at
~9,900 of 9,999 taken, 40 probes miss ~67% of the time. **Signup then fails
permanently for that name**, and because there is no onboarding step (§O1) the
user is never offered the chance to pick something else. They just get an error.

This is the single most likely way a Brazil launch breaks in public. Fix:
deterministic scan for a free slot when random probing fails, and/or widen the
space, and/or surface a "pick your handle" step.

### Sec1. Verify prod config before opening the doors

Mostly confirmation, not work — but each has a large blast radius:

- `DEV_AUTH_BYPASS` refuses under `NODE_ENV=production`, and `Dockerfile:24`
  sets it. Confirm the deployed container actually reports it — one `/health`
  or log line.
- Confirm `CORS_ALLOWED_ORIGINS` and `CLERK_AUTHORIZED_PARTIES` list the real
  launch origins (`pqp.gg`, not just the `pages.dev` preview).
- Decide attachments: `S3_*` is still unset on Railway and R2 signing has never
  been exercised against real R2 (only MinIO). Either wire and test it, or
  launch with attachments visibly off. Do not launch with it half-on.
- Run `/security-review` over the branch diff. The last full audit was
  2026-07-11; a lot has shipped since (webhooks, DMs, export, embeds, iOS).

### T1. Get a load number — ✅ DONE

`pnpm load:chat` (`scripts/chat-load.mjs`) joins N *distinct* users, posts at a
fixed rate, and reports held sockets, fan-out throughput and end-to-end
send→receive latency. Distinct users matter: every per-user limit is keyed on
the user id, so clients sharing one account measure the limiter, not the server.

Measured on one process, **dev machine over localhost** — Railway will be lower
and adds real network, so treat these as shape, not as a promise:

| Shape | In | Fanned out | Latency | Drops |
|---|---|---|---|---|
| 1000 sockets / 10 channels | 184 msg/s | 18.4k/s | p50 58ms, p99 112ms | 0 |
| 500 sockets / 1 channel | 92 msg/s | 46k/s | p50 84ms, p99 138ms | 0 |

**The binding constraint is the join rate, not the socket count.**
`socketLimiter` holds 600 tokens refilling at 200/s and is keyed on the client
*address*; each joining client spends two frames (`auth`, `join-channel`), so
sustained joins cap at ~100/sec per address key and a burst of ~300 empties the
bucket. Behind a proxy without `TRUST_PROXY`, that key is *every client at
once* — so a launch-day rush hits it. **Set `TRUST_PROXY=true` on Railway.**

That limit used to fail silently: the frame was discarded with no reply, so an
`auth` that lost left the client hanging until it was closed with 4401 —
blaming credentials for backpressure. It now closes 4429, which the client's
reconnect-with-backoff already handles.

Re-run against the real deploy before trusting any absolute number.

---

## P1 — Brazil

### B1. There is no i18n at all

Zero infrastructure: no i18n library in `client/package.json`, no locale
detection, no message catalog, no `pt-BR` string anywhere in the repo. Every
string is hardcoded English JSX across ~40 components.

This is genuinely multi-day work — extraction is the slow part, translation is
not. Scope it honestly. Two paths:

- **Launch English, ship pt-BR in week 2.** Brazilian gamers tolerate English
  UI (Discord itself launched that way there), and this keeps launch day real.
- **Localize the funnel only** — landing page, sign-up, onboarding, empty
  states. Maybe 15% of the strings, most of the perceived localization. This is
  the high-leverage middle path and is achievable in a day or two.

Recommend the second.

### B2. Localize the Clerk modal (cheap, visible)

The sign-in/sign-up modal is the first interactive surface a user touches and
it's English. `@clerk/localizations` exports `ptBR`; pass it as `localization`
on `ClerkProvider`. Roughly a one-line change for an outsized share of the
first impression.

### B3. Railway has no South America region — decided

Confirmed: Railway runs four regions (US West, US East/Virginia, Amsterdam,
Singapore). No São Paulo, on any plan, with no announced roadmap. Nearest is
Virginia at ~110–140ms from São Paulo.

**Do not migrate today** — that RTT is fine for text and moving hosts on launch
day turns a latency problem into an outage.

**Do migrate in week 2, together with S1(b).** Fly.io has a real São Paulo
region (`GRU`) for both compute and managed Postgres, at roughly single-digit
dollars a month, and its long-running-machine model fits a WebSocket server
better than Cloud Run's request-scoped one. Pair the move with the pub/sub work
— they are one migration, not two, and doing them separately doubles the risk.
Keep app and database in the same region either way.

Ruled out: Render, DigitalOcean (no BR region), AWS App Runner (not in
sa-east-1). Cloudflare Pages already serves from São Paulo and seven other
Brazilian PoPs, so static delivery needs nothing.

### B4. TURN relay locality — highest-leverage item left

`docs/deploy-railway.md` provisions ExpressTURN's **free tier**
(`free.expressturn.com`, `relay1.expressturn.com`). ExpressTURN documents "all
locations" only for its **Premium** plan (~$9/mo) and describes the free tier as
having limited location access; whether the free hostnames reach São Paulo is
**not publicly documented**. If they do not, a cross-NAT BR↔BR call relays São
Paulo → US → São Paulo, which is the ~250ms mouth-to-ear that reads as "the
voice chat is broken."

Brazilian mobile carriers use CGNAT heavily, and CGNAT is exactly what forces
TURN rather than a direct peer connection — so this is not an edge case there.

Fix is a config change: upgrade ExpressTURN, or switch to Twilio NTS or Metered,
both of which document a dedicated São Paulo region. **This is a P0 for the
value proposition** even though it is a P1 for shipping: voice is the product.

Still needs a human in Brazil to confirm: two devices on Brazilian consumer
ISPs, at least one on mobile data.

### B5. LGPD, not just GDPR

`privacy-page.tsx`, `terms-page.tsx`, `cookies-page.tsx` exist but are English
and GDPR-shaped. LGPD needs a named controller, a stated legal basis, and a
working user-rights path. Related: there is **no self-serve account deletion or
personal data export** — `export.ts` is owner-only *server* export, which is a
different thing. LGPD art. 18 makes this a legal requirement, not a nice-to-have.

Get a human to review the copy. This is the one item on the list where being
wrong has consequences that outlive the outage.

### N1. Accented names get mangled into underscores — ✅ DONE

`slugifyUsername` (`users.ts:13-20`) lowercases then replaces every
non-`[a-z0-9_]` run with `_`:

| Clerk display name | Handle they get |
|---|---|
| João | `jo_o` |
| Ação | `a_o` |
| Gonçalves | `gon_alves` |
| Müller | `m_ller` |

This is the auto-assigned handle for the exact audience being targeted, and
per §O1 the user is never shown it before it's assigned. Fix is small — NFD
normalize and strip combining marks *before* the character filter, so `João`
transliterates to `joao`.

Note the user-supplied path is fine: `usernameSchema`
(`packages/shared/src/api.ts:37-41`) enforces `^[a-z0-9_]+$`, which is a
reasonable constraint for a URL-safe handle. It's the *derivation* that's broken,
not the rule.

---

## P2 — mobile

### M1. iOS exists but is outside the pipeline

`ios/` (native Swift, five commits on this branch) is not mentioned in
`HANDOVER.md` and has no CI workflow — `.github/workflows` has `electron.yml`
but nothing for iOS. No build, no test, no signing, no TestFlight.

### M2. iOS cannot ship today

App Store review is days to weeks, and a first submission from a new
organization is the slow case. The realistic path:

1. **Today:** PWA is the mobile story. It's done and installable
   (`docs/PWA.md`) — say so on the landing page instead of implying an app.
2. **This week:** TestFlight build, internal testers.
3. **Then:** App Store submission, with the review cycle budgeted for.

Also note App Store guideline 1.2 — a social app accepting user-generated
content needs reporting, blocking, and moderation. Blocking exists
(`blocks.ts`); confirm in-app *reporting* does before submitting, since its
absence is a common rejection.

### M3. Android

No native client. The PWA covers it and Android PWA support is the good case
(installable, service-worker notifications already wired). No work needed for
launch — just don't promise a Play Store listing.

---

## P3 — onboarding (P1 for retention, P0 for nothing)

### O1. There is no onboarding

Sign-up drops the user straight into `/app`. They are auto-assigned a handle
derived from their Clerk display name (§N1, so plausibly `jo_o#0473`), never
shown it, and username editing lives buried in `settings-modal.tsx`.

A first-run flow — confirm handle, set display name, pick avatar, then
create-a-server *or* enter an invite code — fixes §N3's dead end as a side
effect, since a user who hits an exhausted namespace can just pick another name.

Check the new-user empty state too: a user with no servers and no invite is
currently looking at an empty app with no next action.

---

## Suggested order for today

1. **Decide S1(a) vs (b)** — everything else assumes an answer. *(minutes)*
2. **O2 + N2** — `ON CONFLICT` upsert, `23505` retry. Both small, both P0. *(~1h)*
3. **N1 + N3** — accent transliteration and namespace exhaustion. *(~1h)*
4. **S2** — broadcast via `channelPresence`. *(~1h)*
5. **Sec1** — prod config verification + `/security-review`. *(~1h)*
6. **T1** — load test, now that S2 is in. *(~2h)*
7. **B2 + B3** — Clerk ptBR, Railway region. *(~30min, big felt effect)*
8. **B4** — voice test from Brazil. *Needs a human on a Brazilian network.*
9. Gate signups behind invites, launch, watch `railway logs | grep '\[pqp\]'`.

Then, post-launch: B1 (funnel pt-BR), B5 (LGPD + account deletion), O1
(onboarding), M2 (TestFlight), S1(b) (real horizontal scale).

## Explicitly deferred

Naming these so they're decisions rather than oversights: full UI translation,
Cloudflare Realtime SFU (still a stub — LiveKit is the implemented path),
Stripe/billing UI, Electron app icon, Android native, custom emoji, server
icons.
