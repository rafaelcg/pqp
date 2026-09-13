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

## What this Worker does NOT make faster

A ban or a lost VIEW permission is enforced by `hls-revocation.ts`, an
in-memory set that only exists on the API process. This Worker's cache widens
the gap between "revoked" and "the next real check" from "per viewer's own
2-4 s poll" to "per rung's `CACHE_TTL_SECONDS` cache window" — worse by a
small constant factor, never unbounded, and never skipped: every cache MISS
still asks the API, and the API still runs the check on that request. The
token check that DOES run on every request here (signature, expiry, channel,
session) is unrelated to revocation and is unaffected by caching at all.

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
