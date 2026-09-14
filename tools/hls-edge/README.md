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

## The party pass: a longer-lived credential, and a sharper version of the same trade-off

`?t=` expires in an hour by default (`LIVE_HLS_VIEWER_TOKEN_TTL_MS` on the
API); a three-hour film then needs the reactive refresh through the client's
stall watchdog to keep going, which is a real (if self-healing) interruption.
`?pp=`, the **party pass**, exists so THIS Worker specifically can keep
serving the rendition route for up to `LIVE_HLS_PARTY_PASS_MAX_TTL_MS` (6 h)
without needing a fresh `?t=` at all — see `mintHlsPartyPass`'s doc comment in
`server/src/voice/hls-viewer-token.ts` for the full design and
`src/hls-party-pass.js` for this Worker's verification of it.

Three things worth being precise about:

1. **It only ever gates the cached rendition route.** The session/master
   route (no `rung` in the path) is fetched once per viewer join, always
   forwarded with the caller's own `?t=`, and never cached — there is nothing
   for a longer-lived credential to buy there, so this Worker does not even
   look at `?pp=` on that route.
2. **It cannot make this Worker ask the origin for anything.** A cache MISS
   still has to forward a request the ORIGIN can verify, and the origin
   cannot verify a party pass at all — a different secret, by design (see the
   doc comment above `partySecret()`). A viewer authorised here only by a
   party pass rides the shared cache for as long as some OTHER viewer's
   still-fresh `?t=` keeps refilling it; on a genuine miss with no usable
   `?t=` in hand, this Worker answers a retryable 503
   (`hlsEdge.partyPassMissWithoutToken` / `hlsEdge.partyPassOriginMissRefused`
   in the logs), not a 401 — the caller is not unauthorized, there is simply
   no fresh copy this specific request can produce. In a live party with more
   than a handful of viewers this is a corner, not a common path.
3. **Revocation is WEAKER here than the trade-off described above, not the
   same one.** The short-lived `?t=` trade-off is bounded by that token's own
   TTL even if the shared cache never runs dry (a revoked viewer's own next
   request, at latest an hour later, fails on expiry if nothing else catches
   it sooner). A party pass has no such backstop: it verifies purely on
   signature, channel, session and its own `e` claim, with **no path at all**
   to `hls-revocation.ts`, which lives only in the API process's memory. A
   viewer banned or losing VIEW mid-party keeps a valid party pass working
   for up to 6 hours after the fact, full stop, unless something closes that
   gap. `isPartyPassRevoked` in `src/index.ts` is that hook: given a KV
   namespace (`HLS_REVOKED_USERS`, commented out in `wrangler.jsonc`,
   deliberately not provisioned yet) written to by `hls-revocation.ts` on
   every eviction, this Worker would refuse a party pass whose `userId`
   appears there. Nothing writes to it today — the function always answers
   "not revoked" when the binding is absent, so this Worker's behavior is
   unchanged until an operator decides the gap is worth building the write
   path for. See the TODO on that function for exactly what remains.

An operator who is not ready to accept trade-off #3 sets
`LIVE_HLS_PARTY_PASS_TTL_MS=0` on the API: no pass is minted, `?pp=` never
appears on a stream URL, and this Worker's gate is exactly what it was before
this feature existed.

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

`HLS_PARTY_PASS_SECRET` is the same idea, a SECOND derived value from the
same root secret, with a different `info` string (`partySecret()` in
`server/src/voice/hls-viewer-token.ts`):

```
partySecret() = base64url( HMAC-SHA256(CLERK_SECRET_KEY, "pqp-hls-party-pass") )
```

```bash
node -e 'console.log(require("crypto").createHmac("sha256", process.env.CLERK_SECRET_KEY).update("pqp-hls-party-pass").digest("base64url"))'
```

It is deliberately NOT the same value as `HLS_VIEWER_TOKEN_SECRET` — see "The
party pass" above for why a second, unrelated key (rather than a claim on the
same token) is what makes "the origin cannot verify a party pass" true by
construction. Leaving this unset is a supported configuration: `?pp=` then
never verifies, and this Worker gates purely on `?t=`, same as before the
party pass existed.

## Deploying

```bash
cd tools/hls-edge
npm install
npx wrangler login          # once, if not already authenticated
npx wrangler secret put HLS_VIEWER_TOKEN_SECRET   # value from above
npx wrangler secret put HLS_PARTY_PASS_SECRET     # value from above; omit to leave the party pass off
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
