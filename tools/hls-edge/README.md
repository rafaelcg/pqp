# pqp-hls-edge: playlists at the edge

A Cloudflare Worker that sits between watch-party viewers and the API's HLS
playlist proxy, at a new host (proposed `hls.pqp.gg`). It exists to fix one
thing: `server/src/api/index.ts`'s playlist route gets polled by every viewer
every 2 to 4 seconds for as long as they watch, and at 500 viewers that is 125
to 250 identical requests a second landing on the process that also owns the
Postgres connection pool. See
[`docs/plans/RELOAD_STORM.md`](../../docs/plans/RELOAD_STORM.md) for the
numbers this was built for, and
[`docs/WATCH_PARTY.md`](../../docs/WATCH_PARTY.md) §"Playlists at the edge"
for how it fits the rest of the watch-party seam.

Not part of the pnpm workspace, the same way `tools/admin-dashboard` isn't
(its own `package.json`, its own install, its own CI test step) — see that
tool's README for why.

## Module layout, and the seam for always-on

The owner wants a watch party to keep playing when the API is down, not just
faster while it's up — a different problem from the one this PR solves (this
PR cuts *load* on the API; that one removes the *dependency* on it), but it
lands on the same Worker, so the code is already split along that line:

| Module | Job | Changes when always-on lands? |
|---|---|---|
| `src/hls-viewer-token.js` | Is the caller allowed to see this playlist | No — the token check is unrelated to where the bytes come from |
| `src/playlist-route.ts` | Is this even a playlist request, and for what | No — the shape a viewer's client requests never changes |
| `src/playlist-origin.ts` | Where the playlist's BYTES actually come from | **Yes** — gets a second implementation |
| `src/hls-blocking-reload.js` | LL-HLS blocking playlist reload (`_HLS_msn`/`_HLS_part`, see below) | No — it holds a request open until the origin's answer advances, regardless of where that answer eventually comes from |
| `src/index.ts` | Routing, the cache-or-forward decision, CORS, logging | No, or minimally — it is written against the `PlaylistOrigin` interface, not against "the API" |

`playlist-origin.ts` today has exactly one implementation, `ApiPlaylistOrigin`
(ask the API — this Worker still goes down with it). See that file's doc
comment for the planned second implementation (R2 segment listings + a
Durable Object per session remembering what it has seen, the edge-side
version of `hls-live-window.ts`'s in-process history on the API) and
`docs/plans/ALWAYS_ON.md` task A1.x for the plan itself — not built here.
`wrangler.jsonc` has the R2 bucket and Durable Object bindings that work will
need, commented out until code exists to read them.

## What it does

For `GET /api/voice/hls-playlist/:channelId/:startedAt(/:rung)?`, the SAME
path shape the API's own playlist route uses:

1. **Validates the viewer token itself**, with the same HMAC scheme as
   `server/src/voice/hls-viewer-token.ts` (`src/hls-viewer-token.js`, a
   line-for-line-faithful port — see "Why a port, and why plain JS" below). A
   token that fails gets a 401 (not a valid credential at all: missing,
   unconfigured, malformed, bad signature, expired) or 403 (a well-formed
   token for the wrong channel or the wrong session), with the SAME reason
   word the API logs in `voice.hlsPlaylistRejected`.
2. **For a rendition's media playlist** (`.../:rung`, the URL that actually
   gets polled every 2-4 s): fetches the API once per rung per
   `CACHE_TTL_SECONDS` (2s) and serves every viewer of that rung from the
   Worker's own cache in between, keyed on channel + session + rung — **never
   on the token**. See "Why the cache key drops the token" below for why that
   is safe.
3. **For the session URL** (no `:rung` — the master playlist, or a pre-ladder
   session's only playlist): always forwarded to the API with the caller's
   own token, never cached. See "The two routes are not the same kind of
   thing" below.
4. **CORS**, matching the shape of `server/src/lib/http.ts`'s `corsHeaders`
   (an optional `CORS_ALLOWED_ORIGINS` allowlist; unset echoes every origin
   back, the same fail-open default the API has for a self-host with nothing
   configured).

Segment bytes are untouched by any of this: they were already presigned R2
URLs the browser fetches directly, and stay that way.

## Blocking reload (L2.1)

LL-HLS players (hls.js 1.7, AVPlayer, Media3) reload a rendition's media
playlist by adding `_HLS_msn` (and, once a specific part is what's missing,
`_HLS_part`) to the SAME request shape this Worker already answers — RFC
8216bis §6.2.5.2, "Playlist Delivery Directives". A conventional reload gets
whatever the playlist currently says and comes back later; a blocking reload
asks the server to **hold the request open** until the answer is actually
different, which is what turns "poll every 2-4 s and hope" into "the response
lands the instant the part exists." `src/hls-blocking-reload.js` is the
implementation; `src/index.ts` recognizes a request that carries a directive
and hands it off, otherwise falling straight through to the cache-or-forward
path above **completely unchanged** — a request with neither `_HLS_msn` nor
`_HLS_part` never touches this code at all.

**What a directive means here:**

- `_HLS_msn` alone: hold until the named Media Sequence Number's segment is
  **complete**.
- `_HLS_msn` + `_HLS_part`: hold until that many parts of that segment have
  been published (a part number is 0-indexed, so `_HLS_part=1` needs at least
  2 parts).
- An MSN already published (complete, or — for the segment currently being
  assembled — with enough parts already in) answers **immediately**, no hold
  at all.
- `_HLS_part` without `_HLS_msn`, a non-integer, or a negative value on
  either parameter: **400**, checked before anything else runs.
- An `_HLS_msn` more than two segments past the live edge: **400**, per the
  RFC's own "SHOULD respond with 400" rule — the server can already tell this
  request can never be satisfied by anything short of a much longer wait than
  the timeout below allows, so it says so immediately rather than holding it.

**The timeout.** A hold gives up after **3 x the target part duration** and
returns whatever the current playlist is — the RFC's own fallback, not an
error. The part duration comes from the playlist's own
`EXT-X-PART-INF:PART-TARGET=...` once a fetch has revealed it; before that
(a cold rendition this isolate has not polled yet) it falls back to a
configured default, `DEFAULT_PART_TARGET_SECONDS` (0.5 s, matching
`docs/plans/LL_HLS.md`'s 500 ms part target). `EXT-X-SERVER-CONTROL`
emission — actually advertising `CAN-BLOCK-RELOAD=YES` on the playlist body
this Worker forwards — is task **L2.2**, not this one: this module only ever
reacts to a client that already sends a directive, so nothing about the
playlist a non-LL client sees changes.

**The coalescing design, and its per-colo limit.** Many viewers can be
holding on the same rendition (channel + session + rung) at once, each
having arrived at a different moment and so asking for a different exact
`_HLS_msn`/`_HLS_part` — that is the normal case, not an edge case. All of
them share **one poll loop per rendition per Worker isolate**: the first
waiter to arrive for a cold rendition starts the loop, every later arrival
just joins the same waiter set (resolved immediately, with no fetch, if the
loop's last-known state already satisfies it), and the loop stops polling
the instant no one is left waiting. The loop never polls faster than once
per part duration, and it does not reimplement the origin fetch itself —
each poll tick calls back into `index.ts`'s existing single-flight
`fetchRenditionCoalesced`, the same de-duplication the non-blocking cache
path already uses, so a poll tick and an ordinary cache-miss fetch for the
same rendition happening at the same instant still collapse into one real
request to the API. Nothing here adds a second persistent cache: a held
response is never written to `caches.default` (see the header comment on
`handleBlockingReload` for why — an LL playlist body is stale in well under
a second, which isn't a thing worth caching with any TTL).

The honest limit: `pollStates` in `hls-blocking-reload.js` is in-memory,
scoped to one Worker isolate. Cloudflare runs a busy Worker across more than
one isolate — generally one per colo a request enters through, never shared
across colos — so "one poll loop per rendition" is a per-isolate guarantee
that reads in practice as roughly "per colo", the same shape the
non-blocking cache above already documents for `caches.default` (see "Load
shape" below). An audience spread across N colos still produces on the order
of N concurrent poll loops for the same rendition, not one truly global
loop. A durable, cross-colo version would need the Durable Object seam
`playlist-origin.ts` already reserves for the always-on work (task A1.x) —
deliberately not reached for here, since standing up a Durable Object is
its own deploy-time commitment and this task's job is the blocking-reload
**protocol**, not new durable infrastructure.

**Retained state is bounded, both in time and in size.** The loop's
last-known `lastEdge`/`lastPlaylist` answer a NEW waiter's fast path only
while younger than 2 s — the same order of staleness the non-blocking cache
above already tolerates — so a rendition this isolate has not heard from
recently always falls through to a real fetch instead of trusting long-stale
content for an availability, too-far-ahead, OR revocation-adjacent decision
(a Farol review of this file's first draft, 2026-09-13, flagged all three as
the same underlying gap: retained state with no freshness bound). The map
itself is capped (`MAX_POLL_STATE_ENTRIES`) and opportunistically swept of
idle, stale entries, the same shape `index.ts`'s own `rejectionLog` already
uses for a hostile-traffic ceiling. Two further hardenings from that same
review: a poll tick's fetch is raced against the soonest waiter's own
deadline once there is a fallback playlist to use, so a stalled origin
cannot silently hold every waiter past the 3x-part-target promise this
module makes; and a disconnected viewer's `AbortSignal` (threaded through
from `index.ts`) removes their waiter immediately instead of polling on
their behalf until the timeout. See `src/hls-blocking-reload.js`'s module
doc comment for the full detail on each.

**Deferred to later L2 tasks** (`docs/plans/LL_HLS.md` §7):
`EXT-X-SERVER-CONTROL`/`EXT-X-PART-INF`/`EXT-X-PART`/`EXT-X-PRELOAD-HINT`
emission on the playlist body (L2.2), and proxying PART byte ranges
themselves through this Worker (L2.3). Until L2.2 ships, no production
playlist advertises `CAN-BLOCK-RELOAD=YES`, so no real player sends these
directives yet — this task is the server half landing first, tested directly
rather than through a client that cannot exercise it yet.

## Why the cache key drops the token

A rendition's media playlist body
(`buildSignedPlaylist(channelId, startedAt, rung)` on the API) is a pure
function of **(channel, session, rung, current signing-time bucket)** — never
of who asked. `hls-playlist-proxy.ts`'s own segment-URL signing is already
quantised into a shared time bucket for exactly this reason (CLAUDE.md's HLS
pitfalls: two viewers must see the same segment URI, or a native player's
buffer thinks a segment it already has is a new one). So caching that body
once and handing it to every viewer of the same rung, regardless of which
token they showed up with, returns EXACTLY what each of them would have
gotten from their own uncached request — the token only ever gated whether
they were allowed to ask, never what they got back.

## The two routes are not the same kind of thing

The session URL (no rung) is different in one important way: once a session
has run a ladder, it answers with a MASTER playlist whose variant lines embed
the **requesting viewer's own** `?t=` token
(`buildMasterPlaylistFor` in `hls-playlist-proxy.ts`) — the master is not a
pure function of (channel, session) the way a rendition is. Caching that
response and handing it to other viewers would bake one viewer's capability
token into everyone else's player for the rest of their session (hls.js
fetches the master once, not on a poll, so it would live in the player's
memory for the whole watch) — coupling their playback to that one viewer's
ban/revocation status until they reload. A pre-ladder session's session URL is
instead a plain, token-independent media playlist, same as a rendition — but
this Worker has no database access and cannot tell the two cases apart the
way the API can, so it treats the whole route conservatively: always forward,
never cache. This route is also fetched once per viewer join rather than
polled, so the cost this Worker exists to cut was never on this path anyway.

## What this Worker does NOT make faster, and needs a sign-off

**A ban or a lost VIEW permission does not reliably cut a viewer off while
this Worker's cache is warm, and that is a real, not a cosmetic, weakening of
today's behavior.** `hls-revocation.ts` is an in-memory set that exists ONLY
on the API process; this Worker never consults it and has no way to. Without
caching, that gap is "the next request THIS SPECIFIC VIEWER makes" — a couple
of seconds, per viewer, exactly as `hls-viewer-token.ts`'s own TTL comment on
the API describes. WITH this Worker's shared cache, the gap is instead "how
long the cache entry for that rung stays populated" — and a cache HIT is
served to EVERY viewer holding a still-signature-valid token, revoked or not,
without ever reaching the origin. Because ANY valid viewer's request keeps
the entry warm, a popular rung during an active party can keep a banned or
kicked viewer's playlist (and its segment URLs) flowing for as long as the
party runs, not for one cache window. This is a direct, structural
consequence of collapsing N viewers into one origin fetch: there is no way to
keep that collapse and still re-check each individual viewer's standing on
every request, because the second thing is exactly what the first thing
removes.

Nothing here is a bug to fix with more code in this file — it is a trade-off
inherent to caching authorization-gated content at all, and it needs
Rafael's explicit decision before `LIVE_HLS_PLAYLIST_BASE_URL` is set in
production, not just a merge. Two directions worth naming, both out of scope
for this PR: (1) a lightweight revocation signal pushed from the origin to
the edge (a lease the edge checks against the verified `userId`, refreshed
far more often than the playlist cache) — a natural fit for whatever channel
the "always-on" R2 work ends up building between origin and edge anyway (see
`playlist-origin.ts` and `docs/plans/ALWAYS_ON.md` task A1.x); or (2)
accepting the exposure as bounded by "this party's duration" and relying on
`VOICE_MESH_RESUME_REQUIRES_CAP`-style narrow mitigations elsewhere (kicking
a banned user's WebSocket session immediately still stops them from doing
anything else; only the HLS *viewing* of an already-open stream is affected).

The token check that DOES run on every request here (signature, expiry,
channel, session) is unrelated to revocation and is unaffected by caching at
all — a stolen or expired token is refused exactly as reliably with this
Worker in front as without it.

## Why a port, and why plain JS

`src/hls-viewer-token.js` is deliberately not a shared import from
`server/src/voice/hls-viewer-token.ts` — this Worker deploys separately, in a
runtime with no Node `crypto` module (Workers only get `nodejs_compat`
Node built-ins if the flag is turned on, which this Worker does not need). It
uses Web Crypto (`crypto.subtle`) instead, which both the Worker runtime and
Node 19+ provide — so the SAME module runs unmodified inside the Worker and
under `node --test`, and can be unit tested as a plain function rather than
needing Miniflare. `test/hls-viewer-token.test.mjs` mints tokens with Node's
`node:crypto` (`createHmac`, the API's own primitive) and verifies them with
this module's Web Crypto implementation — two different crypto backends
computing the same HMAC, which is a stronger fidelity check than testing the
port against itself: a computation mismatch fails every "valid token" case,
not just an edge case both implementations happen to agree on. That pairing
already caught one real drift once (see the comment on `macValid` in
`src/hls-viewer-token.js`): an early version base64url-decoded the caller's
signature before comparing it, where the origin instead compares the
signature's base64url TEXT directly — the difference only shows up on a
garbled, non-base64 signature, which is exactly the case a hand-written test
would be least likely to try.

## The secret this Worker holds, and the one it does not

`HLS_VIEWER_TOKEN_SECRET` is **not** the API's `CLERK_SECRET_KEY`. The origin
derives its signing key from it:

```
viewerSecret() = base64url( HMAC-SHA256(CLERK_SECRET_KEY, "pqp-hls-viewer") )
```

(see `viewerSecret()` in `server/src/voice/hls-viewer-token.ts`) and signs
every token with THAT derived value, never with `CLERK_SECRET_KEY` itself.
This Worker only ever needs to verify a signature, so it is given the
DERIVED value directly — a secret scoped to HLS viewer tokens alone — rather
than the raw Clerk secret, which also gates real user authentication and has
no business living on a third system. Compute it once, from wherever
`CLERK_SECRET_KEY` is already set (Fly today; wherever the API lands after
the Vultr move):

```bash
node -e 'console.log(require("crypto").createHmac("sha256", process.env.CLERK_SECRET_KEY).update("pqp-hls-viewer").digest("base64url"))'
```

and set the result, not `CLERK_SECRET_KEY` itself. Rotating `CLERK_SECRET_KEY`
on the API means recomputing and re-setting this value here too — until that
happens, every token this Worker sees fails to verify (safe: it fails closed,
same shape as `viewerSecret()` returning null when unconfigured).

In local dev, when the API is running with `DEV_AUTH_BYPASS=true` and no
`CLERK_SECRET_KEY`, `viewerSecret()` falls back to a fixed raw value,
`"pqp-dev-hls-viewer"`, before the same derivation — so the dev secret for
this Worker is the derivation of THAT string, not the literal string:

```bash
node -e 'console.log(require("crypto").createHmac("sha256", "pqp-dev-hls-viewer").update("pqp-hls-viewer").digest("base64url"))'
```

## Deploying

```bash
cd tools/hls-edge
npm install
npx wrangler login          # once, if not already authenticated
npx wrangler secret put HLS_VIEWER_TOKEN_SECRET   # value from above
npx wrangler deploy
```

Then in the Cloudflare dashboard, add a CNAME (or A/AAAA, per how the rest of
`pqp.gg` is routed) for `hls.pqp.gg` to this Worker, proxied. `ORIGIN_BASE` in
`wrangler.jsonc` already points at `https://api.pqp.gg`; change it there (not
as a secret — it is not sensitive) if the API's public host changes.

**Rollback**: unset `LIVE_HLS_PLAYLIST_BASE_URL` on the API (see
`docs/WATCH_PARTY.md` §"Playlists at the edge") — new sessions immediately go
back to API-relative playlist URLs and stop touching this Worker at all. This
Worker itself needs no rollback: with the flag unset, nothing ever points at
it.

## Load shape

One invocation of this Worker per HTTP request that reaches it — Cloudflare
bills and schedules Workers per request, not per open connection, so there is
no persistent-connection cost the way there would be on the API. Per request,
the work is:

- Route match (one regex) and CORS header build: negligible, no I/O.
- Token verification: one HMAC-SHA256 over a short string (the payload) via
  `crypto.subtle`, sub-millisecond, no network.
- **Cache hit** (the common case at party scale): one `caches.default.match`
  read, no origin fetch. This is what collapses the 125-250 req/s from the
  problem statement down to roughly one origin fetch per rung per
  `CACHE_TTL_SECONDS` **per Cloudflare colo the audience is spread across** —
  the Cache API is colo-local, not a single global cache, so a single-city
  audience collapses close to "one fetch per rung per 2 s, full stop", while
  an audience spread across many colos gets a smaller (but still large)
  multiple of that. It is never worse than one origin fetch per colo per
  window, which is still one to two orders of magnitude below one per viewer.
- **Cache miss**: one `fetch()` to `ORIGIN_BASE`, capped at
  `UPSTREAM_TIMEOUT_MS` (8s), then one `cache.put` (via `ctx.waitUntil`, so it
  does not add to the response's own latency). A burst of near-simultaneous
  misses (many viewers' polls landing at the very start of a fresh 2 s window,
  before the first one has populated the cache) is not de-duplicated — each
  runs its own origin fetch — but is self-limiting: the window is only ever
  open for the time it takes one origin round trip, tens of milliseconds
  typically, well inside the 2-4 s poll interval, so it does not compound
  across cycles.
- Logging: a JSON line on `console.log` per rejection (rate-limited to one per
  channel/rung/reason per 30 s, same shape as the API's own
  `logHlsPlaylistRejection`) and per origin fetch (already naturally rate
  limited to about one per rung per `CACHE_TTL_SECONDS`, since that is exactly
  when a fetch happens). Cache HITS are the frequent case and are counted
  in-memory and flushed as one summary line every 10 s instead of logged
  individually, for the same reason the API rate-limits its own rejection log:
  a per-request log line on the hot path is a write amplifier waiting to
  happen (CLAUDE.md pitfall 16's lesson, one level removed).

Net: an origin that was seeing 125-250 req/s for one channel's rendition now
sees on the order of 1-10 req/s for it (one per colo per 2 s, for however many
colos the audience actually spans), and the requests it does see are already
known-good (past this Worker's own token check).
