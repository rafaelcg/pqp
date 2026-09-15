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
| `src/ll-state.js` | The `state.json` contract: validation, the rung constants, `playlistOriginKindForRung` | No — a JSON shape, not a fetch |
| `src/ll-playlist.js` | Renders LL-HLS playlist TEXT from a validated `state.json` (media + multivariant) | No — pure text rendering, no I/O |
| `src/ll-init-codecs.js` | Reads `CODECS` (`avc1.PPCCLL`) off an init segment's `avcC` box | No — pure bytes-in, string-out |
| `src/ll-session.js` | The remux `sessionId` for a channel's LL session — ported, pure | No |
| `src/ll-playlist-origin.ts` | `PlaylistOrigin` for an LL session — talks to the remux box directly | No — this is the second-origin seam already, one level below `playlist-origin.ts` |
| `src/ll-media.ts` | The LL MEDIA route (`L2.3`): part/segment/init bytes off the remux box, immutably cached per colo | No — a second origin would land in `ll-playlist-origin.ts`, not here |
| `src/viewer-access.ts` | The one credential check (token, party pass, revocation) every route calls | No |
| `src/edge-cache.ts` | The Cache API wrapped so losing it never costs a request, and the one definition of a cache key | No |
| `src/coalesced-fetch.js` | One in-flight fetch per key, shared — with every join bounded and detachable, so a joiner never depends on a request context it does not own | No — it is about promises, not about where the bytes come from |
| `src/index.ts` | Routing, the cache-or-forward decision, CORS, logging | No, or minimally — it is written against the `PlaylistOrigin` interface, not against "the API" |

`playlist-origin.ts` today has exactly one implementation, `ApiPlaylistOrigin`
(ask the API — this Worker still goes down with it). See that file's doc
comment for the planned second implementation (R2 segment listings + a
Durable Object per session remembering what it has seen, the edge-side
version of `hls-live-window.ts`'s in-process history on the API) and
`docs/plans/ALWAYS_ON.md` task A1.x for the plan itself — not built here.
`wrangler.jsonc` has the R2 bucket and Durable Object bindings that work will
need, commented out until code exists to read them.

**Testing a `.ts` origin directly.** `ApiPlaylistOrigin`/`index.ts` have no
direct unit test in this package (`tsc --noEmit` plus the pure `.js` modules
they call into is the coverage), because `tsconfig.json`'s
`moduleResolution: "Bundler"` lets these files `import "./log.js"` for a
file that is actually `log.ts` on disk — a convention only a bundler or
`tsc` itself resolves, not Node's native `--experimental-strip-types`
loader. `test/ll-playlist-origin.test.mjs` needed real coverage of
`LlPlaylistOrigin` (Farol's review of this PR's first draft found three of
its four findings inside that one class), so `npm test`'s `pretest` step now
runs `tsc -p tsconfig.test-build.json` first, emitting a `dist/` (gitignored,
matching this repo's `**/dist/` pattern) the test imports from instead of
the `.ts` source — the compiled output's import specifiers resolve exactly
the way they were written, since every sibling module lands in the same
directory. `LlPlaylistOrigin`'s constructor is a plain body rather than
TypeScript parameter-property shorthand for the same reason: type-stripping
erases type annotations but cannot inject the `this.field = field`
assignments a parameter property requires.

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
4. **For an LL rendition's MEDIA bytes**
   (`.../:rung/<name>`, added by `L2.3` — see "LL media bytes" below):
   fetches `{LL_ORIGIN_BASE}/s/{sessionId}/{name}` once per colo and serves
   every other viewer of that part from the Cache API, `immutable` for a
   year.
5. **CORS**, matching the shape of `server/src/lib/http.ts`'s `corsHeaders`
   (an optional `CORS_ALLOWED_ORIGINS` allowlist; unset echoes every origin
   back, the same fail-open default the API has for a self-host with nothing
   configured).

A CONVENTIONAL rung's segment bytes are untouched by any of this: they were
already presigned R2 URLs the browser fetches directly, and stay that way.
An LL session's are the exception, and the reason step 4 exists — the remux
box is a private origin behind a shared key, with nothing to presign, so for
LL this Worker is the CDN in front of it.

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

**Nothing is ever parked without a live loop or a live timer of its own
(2026-09-15).** A production session of three and a half minutes had thirteen
requests killed by the Workers runtime with *"your Worker's code had hung and
would never generate a response"* — each after a wall time of one to thirteen
milliseconds, which is the tell: the runtime says that when a request's
promise is unsettled and the request's OWN context has no pending I/O at all.
The cause is a Workers rule this module was written as if it did not exist: a
`fetch()` and a `setTimeout()` belong to the request context that created
them, and when that request's handler returns, its pending I/O is cancelled
and its timers stop firing. So the poll loop — whose timers and origin fetch
belong to whichever request happened to start it — died the moment that
request was answered or its viewer navigated away, its `finally` never ran,
`state.polling` stayed `true` forever, and every later request for that
rendition joined a loop that no longer existed. Four changes, layered so that
no one of them has to be right on its own:

1. **`ctx.waitUntil` on the producer.** `index.ts` hands both the poll loop
   and the shared origin fetch to `ctx.waitUntil`, so the context that owns
   the work outlives the response that started it. This is the fix; the three
   below are what happens when it is not enough (a viewer who navigates away
   takes their context with them regardless).
2. **`loopResumeBy`, not a boolean.** The loop republishes, before every
   `await`, the instant it is due back by. A request that finds a claimed but
   overdue loop starts a replacement, bumping `loopGeneration` so the zombie —
   if it ever does resume — exits without settling the new loop's waiters or
   clearing its `polling` flag. Counted as
   `hlsEdge.blockingReloadLoopRevived`.
3. **A per-waiter timer**, armed in the waiter's own request context. Even
   with both mechanisms above wrong, the request holds a live timer (so the
   runtime never declares it hung) and answers itself with the retained
   playlist within 250 ms of its own deadline. Counted as
   `hlsEdge.blockingReloadWaiterSelfTimeout`, which belongs at zero.
4. **A last-resort `Promise.race`** in `handleBlockingReload`, at the hold's
   budget plus a second, answering with the current playlist. Counted as
   `hlsEdge.blockingReloadHardTimeout`, also at zero: it exists so the next
   race nobody has thought of degrades into a slightly stale playlist instead
   of a 500.

The same afternoon produced five `hlsEdge.blockingReloadOriginError` 502s
while every origin request in the window was a 200 in about a millisecond —
the other half of the same rule, on the shared-fetch side: a joiner was
awaiting a fetch whose owner's context died, and inherited its abort.
`src/coalesced-fetch.js` is the shared answer for every in-flight map in this
Worker (`index.ts`'s rendition fetches and `LlPlaylistOrigin`'s `state.json`
probes alike): a joiner arms its OWN bound, and on expiry — or on a rejection
it did not cause — **detaches and fetches for itself** rather than the shared
fetch being aborted out from under whoever is still attached. Detaching
joiners collapse onto one retry, not one each — the map is re-read at the top
of every attempt and a caller only produces when it sees an empty slot — so a
genuinely sick origin still sees at most one extra request per key. And
`isProducer` (which is what elects the single cache writer in `index.ts`) is
decided when a fetch *settles*, not when it starts, so a slow fetch that
finishes after its replacement cannot overwrite the newer playlist its own
retry already stored. Counted as
`hlsEdge.originJoinDetached` / `hlsEdge.llOriginJoinDetached`, both of which
belong at zero and, when they are not, say that a context died rather than
that the origin refused anything.

**Three ceilings, not one, and a second review round (2026-09-14) that
closed the gaps between them.** `MAX_POLL_STATE_ENTRIES` (500) bounds how
many DISTINCT renditions this isolate retains; it says nothing about how
many waiters pile onto ONE of them, or how many have a poll loop actually
RUNNING at once. `MAX_WAITERS_PER_RENDITION` (2,000) caps the former — one
valid viewer credential could otherwise open unbounded concurrent holds on
the SAME rendition, which the 500-entry cap does nothing to stop.
`MAX_ACTIVE_POLL_LOOPS` (64) caps the latter — every active loop is its own
independent origin poller, so origin-request volume scales with how many
renditions are simultaneously HELD OPEN, not with how many are merely
retained; at party scale, traffic spanning hundreds of renditions would
otherwise mean hundreds of independent sub-second pollers. Past either
ceiling, a request is served the plain non-blocking way instead — the newest
renditions lose their hold first, existing ones keep polling uninterrupted.
The same review also closed a related gap in the deadline race above: it
previously only raced a poll tick once a `lastPlaylist` existed to fall back
to, so a COLD rendition's very first tick — the first waiter this isolate
has ever seen for it — was awaited directly with no deadline at all. A
stalled or non-settling origin could hold that first waiter (and everyone
who joined it) for the origin's own much longer timeout, or forever, and an
abort landing while that unbounded fetch was in flight left the loop's
`polling` flag stuck true — unswept, unevictable, joined by every later
request for the same key — until the origin eventually answered or never
did. Every tick is now raced against its deadline, including the first;
with nothing to fall back to yet, a first-tick deadline win is a distinct
`cold-timeout` outcome (a 504) rather than a fabricated empty playlist. See
`src/hls-blocking-reload.js`'s module doc comment, "TWO MORE CEILINGS" and
"A SLOW ORIGIN DOES NOT OWE A WAITER ITS OWN DEADLINE, NOT EVEN ON THE FIRST
TICK", for the full detail.

**Deferred to `L2.3`**: proxying PART/segment byte ranges themselves through
this Worker (`/{channelId}/{startedAt}/{rung}/{name}`, the URI shape "LL
playlist (L2.2)" below emits). Until then, a client that actually tries to
fetch a part or segment this Worker's own LL playlist points at gets a 404
from THIS Worker (no byte route exists yet) — the same "wired, not yet
reachable" shape the rest of `docs/plans/LL_HLS.md` uses throughout. `L2.2`
(below) is the server half of blocking reload landing for LL sessions
specifically: `EXT-X-SERVER-CONTROL`/`EXT-X-PART-INF`/`EXT-X-PART`/
`EXT-X-PRELOAD-HINT` are now real, so a real LL-HLS player will start
sending `_HLS_msn`/`_HLS_part` directives against an LL rung the moment one
exists in production.

## LL playlist (L2.2)

`docs/plans/LL_HLS.md` task `L2.2`. For a session in `ll` mode, this Worker
renders the LL playlist ITSELF — video rendition (`ll`), the separate audio
rendition (`ll-audio`), and the multivariant (master) playlist that lists
both — straight from state it polls off the remux origin
(`ll-playlist-origin.ts`), never through the API. Nothing upstream of this
Worker writes an LL-shaped playlist yet: `tools/pqp-remux/README.md`'s "Not
yet" section says outright that `GET /playlist.m3u8` (the box's own local
test surface) is conventional-only and that LL tags are "entirely the edge
Worker's job in `L2.1` and `L2.2`".

**Why this Worker talks to the remux box directly, unlike the conventional
path's `ApiPlaylistOrigin`.** The API is the ONLY renderer of a conventional
playlist, so the conventional path forwards a viewer's request to it. For LL
there is no renderer anywhere else to forward to — this Worker has to be
the renderer, and a renderer needs raw material (segment/part existence,
durations, which part starts on an IDR), not somebody else's finished
playlist text. Going through the API for that material would add a hop with
no upside: the API has no better claim to the remux box's state than this
Worker does. `hls-remux.ts`'s own doc comment on `llPlaylistUrl` explains why
the box's raw host must stay OUT OF A VIEWER'S hands — this Worker is not a
viewer, the same reason it already isn't when it fetches conventional
playlists from `ApiPlaylistOrigin`.

**How a request is routed** (`index.ts`):

- The session/master route (no `:rung`) takes the LL path **if and only if
  the request says `?mode=ll`** (`requestsLlMode`, `playlist-route.ts` — a
  port of `LIVE_HLS_MODE_PARAM`/`LIVE_HLS_MODE_LL` in
  `packages/shared/src/live-hls.ts`, which the API stamps onto an LL
  session's `hlsUrl` in `llPlaylistUrl`). With the marker: derive the remux
  `sessionId`, ask for `state.json` (see the contract below), render an
  LL-only multivariant playlist, never touch the API. Without it: the
  byte-for-byte-unchanged API forward that has always served this route, and
  the LL origin is not consulted at all.

  **This used to be a probe, and the probe was wrong four times in
  production.** Until 2026-09-15 this branch ran the LL path for EVERY
  master request once `LL_ORIGIN_BASE` was set, and read "no `state.json`"
  as "this party is conventional". Those are different things: a session
  300 ms old has no state yet AND IS low-latency. Low latency was enabled
  four times that day and no viewer was ever handed the low-latency stream;
  in the last attempt the audience's only master request arrived 300 ms into
  the session, got the conventional ladder's master — for a party whose
  conventional ladder the API had deliberately not started — fetched
  `/720p30`, got nothing, and read "A transmissão caiu". Nothing logged a
  failure, because from here there was none. A marker the API puts in the
  URL is a statement; a probe is a race.

  **So an LL master that cannot be built is a `503` with `Retry-After: 1`,
  never the other ladder** (`llNotReady` in `index.ts`), with the reason on
  `X-HLS-Edge-LL-Not-Ready` and in `hlsEdge.llMasterNotReady`
  (rate-limited per channel per reason): `no-state` (warming up),
  `probe-timeout`, `origin-error`, `build-failed`, or
  `origin-not-configured` (this Worker deployed without `LL_ORIGIN_BASE`
  while the API already selects LL — a deploy-order mistake, and loud on
  purpose). `LlPlaylistOrigin` memoes a not-ready answer for one second, so
  a warming party costs the remux about one `state.json` fetch a second no
  matter how many people joined.

  `playlistOriginKindForRung` (`ll-state.js`) is the pure, unit-tested rule
  for the RENDITION half: every rung name except `ll`/`ll-audio` stays on
  the API's origin, always.
- A rendition route for `:rung` = `ll` or `ll-audio` renders that ONE
  track's LL media playlist from the same `state.json`. This is the text a
  real player then polls or blocking-reloads exactly the way
  `hls-blocking-reload.js` already handles a conventional rendition —
  `parseLiveEdge` reads `PART-TARGET=`, counts `#EXTINF:` lines for complete
  segments and trailing `#EXT-X-PART:` lines for the one being assembled,
  generically, off ANY playlist text. **No change was needed in that file
  for `L2.2`**: pointing an LL rendition's fetch at this Worker's own
  renderer instead of the API is the entire wiring.

**Tags emitted** (RFC 8216bis), on the rendition playlist: `EXT-X-VERSION:9`;
this Worker's own `EXT-X-PQP-SESSION:<sessionId>` (an informational tag, new
in this task, harmless to any parser that has never heard of it);
`EXT-X-TARGETDURATION` (`ceil(state.targetDurationSecs)`); `EXT-X-PART-INF:
PART-TARGET=<part target, seconds>`; `EXT-X-SERVER-CONTROL:
CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=<3× part target>`; `EXT-X-MEDIA-SEQUENCE`
(the oldest listed segment's MSN); `EXT-X-MAP:URI=...` for the init segment;
per segment, `EXT-X-PROGRAM-DATE-TIME` then (for the newest 3 complete
segments, and always for the one still being assembled) `EXT-X-PART` lines
(`DURATION`, `URI`, `INDEPENDENT=YES` exactly when `state.json` says that
part starts on an IDR) then, once the segment is sealed, `EXTINF` + its URI;
and one `EXT-X-PRELOAD-HINT:TYPE=PART,URI=...` for the next unwritten part,
when the origin names one. Every URI is relative to
`/api/voice/hls-playlist/:channelId/:startedAt/:rung/<name>` — never the
remux box's own host (see "Why this Worker talks to the remux box directly"
above), and answered by this Worker's own media route ("LL media bytes
(L2.3)" below) — and, in the RENDERED body, carries `LL_TOKEN_PLACEHOLDER`
(`ll-playlist.js`) rather than a real `?t=` token. **This is deliberate, and
the opposite of the conventional master's rule.** A first draft of this task
embedded the real viewer's token directly, matching PR #572's party-lifetime
rule for the conventional master — but a rendition response, unlike the
master, flows through `index.ts`'s shared 2s cache and the blocking-reload
poll-loop coalescer, both keyed on (channel, session, rung) alone, with the
token deliberately dropped because a CONVENTIONAL body never varies by
viewer. An LL body embedding a real token broke that invariant: a Farol
review of this PR caught that the first viewer's bearer token could leak
into a warm cache/poll-loop entry and be served, and be replayable, by every
other viewer of that rung. **Fixed**: the rendered/cached/coalesced body is
token-free (a pure function of `state.json` alone), and `index.ts`'s
`stampLlToken` substitutes the ACTUAL requesting viewer's token into the
response on its way out, once per request, never into what gets written
back into the cache or held by the poll loop. The multivariant (master)
route is unaffected by any of this — see below, it was never cached in the
first place.

**The multivariant playlist** lists the video variant
(`EXT-X-STREAM-INF`, `CODECS` including the video's `avc1.PPCCLL` string)
plus, when the session has one, the audio rendition as a separate
`EXT-X-MEDIA:TYPE=AUDIO` group referenced by `AUDIO=`. `CODECS` comes from
the init segments, per this task's own instruction: the video half is read
straight off `init.mp4`'s `avcC` box (`ll-init-codecs.js`, a small hand-rolled
ISO-BMFF box walk — no MP4 parsing dependency, same reasoning
`tools/pqp-remux/README.md`'s R2 writer gives for hand-rolling SigV4), and
the audio half is the constant `mp4a.40.2` (`tools/pqp-remux/README.md`'s
audio pipeline is AAC-LC only, so there is nothing to read from
`audio-init.mp4` for it). `BANDWIDTH` has no real measurement source yet
(`docs/plans/LL_HLS.md` §8's cost table is an estimate, not a per-session
number) — `DEFAULT_LL_VIDEO_BANDWIDTH_BPS` in `ll-playlist.js` is a
documented placeholder until `L3.2`'s staging benchmark has a real one.
Only the VIDEO codec/geometry is cached per `sessionId` for the life of the
Worker isolate (`LlPlaylistOrigin`'s own small bounded map) — `avcC` cannot
change mid-session, so only the FIRST master request for a session ever
fetches `init.mp4`. **The AUDIO codec is deliberately never cached, and is
re-derived from the current `state.json` on every master request instead.**
A first draft cached both together: a session observed video-only on its
FIRST master request cached `audioCodec: null` forever, and once a speaker
later joined, every subsequent master request kept reading that stale
`null` and never grew an audio group for the rest of the isolate's life — a
Farol review caught this. Concurrent master (and rendition) requests for a
session with no cache entry yet share ONE `state.json` fetch and ONE
`init.mp4` fetch via `fetchFromOrigin`'s in-flight de-duplication (the same
shape `index.ts`'s own `fetchRenditionCoalesced` already uses one layer up)
— a join burst of viewers produces one round trip to the box, not one per
viewer; also caught by the same review, since the master route has no
`index.ts`-level coalescing of its own (it is never cached, by design — see
above). That de-duplication window is also what now bounds a stalled remux
response: `fetchFromOrigin` buffers the WHOLE body inside the same
`AbortController` window the headers wait uses, so a box that answers
headers and then stalls mid-`state.json`/`init.mp4` fails the request at the
configured timeout instead of hanging it indefinitely (an earlier version
cleared the abort timer right after the headers arrived).

### The `state.json` contract (for `L1.6`/`L2.3`)

`GET {LL_ORIGIN_BASE}/s/:sessionId/state.json`, `sessionId` =
`ll-session.js`'s `deriveLlSessionId(channelId, startedAtMs)` — a **pure**
function of two values every request to this Worker already carries, ported
line-for-line from `deriveLlSessionId` in `server/src/voice/hls-remux.ts`
(same "port, not shared import" reasoning as `hls-viewer-token.js`, except
this port needs no secret: a session id is not a capability). This Worker
computes the id itself; the remux never needs to be asked for it, only to
serve `state.json` under the id it was already started with.

**`pqp-remuxd` implements this** (since 2026-09-15):
`tools/pqp-remux/internal/llstate` renders the document from the session's
live ring, `internal/serve`'s `GET /state.json` serves it, and
`internal/control`'s `GET /s/:id/*` mounts it per session behind the same
`X-Pqp-Origin-Key` gate as every other media route, `Cache-Control:
no-store`. Before it existed, a live party on 2026-09-15 at 08:01 UTC had
the API select LL mode, `pqp-remuxd` start the session and answer 200 on
`playlist.m3u8`, `init.mp4` and `audio-playlist.m3u8` — and every viewer
stall, because this Worker asks for `state.json` FIRST and got a 404
(`hlsEdge.llStateFetchFailed` per probe, no playlist ever built).
`test/ll-state-remux-golden.test.mjs` is the cross-check: it reads the
golden document the Go renderer emits
(`tools/pqp-remux/internal/llstate/testdata/state-golden.json`, regenerated
with `go test ./internal/llstate -update-golden`) and asserts `parseLlState`
accepts it and `ll-playlist.js` renders playable LL playlists from it —
every other test here feeds the parser a fixture this half wrote, which
proves nothing about the producer.

`ll-state.js`'s module doc comment carries the full JSON shape with a worked
example; the summary:

```jsonc
{
  "sessionId": "...", "channelId": "...",
  "partTargetMs": 500, "segmentTargetMs": 4000,
  "targetDurationSecs": 4.5,       // ceil'd for EXT-X-TARGETDURATION
  "mediaSequence": 41,             // oldest listed segment's MSN
  "video": {
    "initUri": "init.mp4",
    "segments": [
      { "msn": 41, "complete": true, "durationSecs": 4.016,
        "programDateTime": "2026-09-14T18:03:21.114Z", "uri": "seg-41.m4s",
        "parts": [{ "index": 0, "durationSecs": 0.501, "independent": true, "uri": "part-41.0.m4s" }, ...] },
      // ... at most the LAST entry may have "complete": false (no "uri" yet)
    ],
    "preloadHint": { "msn": 44, "part": 1, "uri": "part-44.1.m4s" } // or null
  },
  "audio": { /* same shape, "audio-init.mp4" / "audio-seg-<n>.m4s" / "audio-part-<seq>.m4s" */ } // or null/absent until a stage source has spoken
}
```

All origin-relative filenames (`seg-<n>.m4s`, `part-<seq>.m4s`, `init.mp4`,
and their `audio-` counterparts) — fetched by THIS Worker at
`{LL_ORIGIN_BASE}/s/:sessionId/<name>`, never handed to a viewer directly
(see "Why this Worker talks to the remux box directly" above). They are the
names `internal/serve` genuinely answers: a part is named by its GLOBAL CMAF
sequence number (`part-9.m4s`), NOT by segment-and-index the way the example
in an earlier draft of `ll-state.js` drew it — a part's `index` field still
carries its position within its own segment, because that is what the
preload hint's arithmetic is expressed in. `ll-state.js`'s `parseLlState` is
the validator: a malformed document is treated exactly like "origin
unreachable" by every caller, never a crash.

**The blocking-reload hold is this Worker's, not the origin's.**
`_HLS_msn`/`_HLS_part` never reach `pqp-remuxd`: `LlPlaylistOrigin` builds
the origin URL from the session id alone and attaches no query string, and
`hls-blocking-reload.js`'s poll loop re-runs `fetchPlaylist` — re-fetching
`state.json` and re-rendering — until the requested msn/part appears or the
hold times out. So `state.json` owes the hold exactly one thing, freshness:
it is rendered from the live ring per request and served `no-store`. The
cross-check test also pins the round trip, asserting `parseLiveEdge` reads
the same live edge back out of the rendered playlist that the golden
document published.

### `LL_ORIGIN_KEY`: this Worker's credential against the remux origin

Every fetch `LlPlaylistOrigin` makes against `LL_ORIGIN_BASE` — `state.json`,
parts, init segments, all of it — carries `X-Pqp-Origin-Key: <LL_ORIGIN_KEY>`
when that secret is configured. This is `pqp-remuxd`'s own
`MEDIA_ORIGIN_KEY`/`OriginKeyHeader` contract (`internal/control/server.go`,
`tools/pqp-remux`, PR #584's Farol-review fix): a static shared value the
origin constant-time-compares before the request ever reaches a session
lookup, the CDN-to-origin auth-header shape rather than a per-request
signature — a viewer's player cannot produce it and never needs to, the same
way it never sees `LL_ORIGIN_BASE`'s host. Set with `wrangler secret put
LL_ORIGIN_KEY`, never in `wrangler.jsonc`'s `vars` (see that file's own
comment) — it is a credential, unlike `LL_ORIGIN_BASE`, which is only a
host. Unset (the default): no header is sent at all, matching `pqp-remuxd`
leaving `MEDIA_ORIGIN_KEY` empty for a loopback-only `CONTROL_LISTEN` — both
sides default to the same "no key configured" posture, and neither one
implies the other is wrong until a real deployment sets both. Never
forwarded to a viewer: `fetchPlaylist`/`fetchMultivariantPlaylist` always
construct a FRESH `Response` with only a `Content-Type` header, never the
origin fetch's own request or response headers — pinned by
`test/ll-playlist-origin.test.mjs`.

## LL media bytes (L2.3)

`docs/plans/LL_HLS.md` task `L2.3`, `src/ll-media.ts`. **Done** — an LL
session's parts, segments and init segments now come through this Worker,
which is the half `L2.2` was missing: the playlist it rendered was correct
and unplayable, because every URI in it 404'd.

**The exact viewer-facing shape**, and it is the same one `ll-playlist.js`
has emitted since `L2.2` (this task added the route that answers it, not a
new URL):

```
GET https://hls.pqp.gg/api/voice/hls-playlist/{channelId}/{startedAt}/{rung}/{name}?t={viewerToken}
```

- `{rung}` is `ll` (video) or `ll-audio` (the audio rendition).
- `{name}` is exactly what `state.json` named: `init.mp4`, `seg-41.m4s`,
  `part-164.m4s`, and the audio twins `audio-init.mp4`,
  `audio-seg-42.m4s`, `audio-part-5.m4s`. Bounded by the same pattern
  `ll-state.js`'s `isSafeUriSegment` applies to the document itself, in the
  route regex AND again in `LlPlaylistOrigin.fetchMedia` — the door is no
  wider than the thing on the other side of it.
- `?t=` is the viewer's own credential, put there by `index.ts`'s `stampLlToken`
  when the rendition playlist left the Worker (the rendition BODY is
  rendered with `LL_TOKEN_PLACEHOLDER` and cached token-free — see the L2.2
  section above). So the credential arrives on a media request exactly the
  way it arrives on the playlist request that named it. A `?pp=` party pass
  authorizes media too, for the same reason it authorizes the rendition: a
  pass-holding viewer must not get a playable playlist whose every URI 403s.
  A pass-authorized viewer's URIs carry `?pp=` instead, because
  `stampLlToken` writes the credential that actually authorized THIS
  response (`applyLlRenditionCredential`) rather than "the token" — which,
  for a pass-holder with no `?t=` at all, used to be the literal string
  `null`. Invisible while those URIs 404'd anyway; this task is what made
  them real.

**Each request maps to one origin path**:
`{LL_ORIGIN_BASE}/s/{deriveLlSessionId(channelId, startedAt)}/{name}`, with
`X-Pqp-Origin-Key`. The session id is recomputed, never looked up, exactly
as the `state.json` probe does it.

**What the route guarantees**, and where each one lives:

1. **The credential is checked first, always** — `viewer-access.ts`'s
   `authorizeViewer`, the same call the playlist routes make, revocation
   gate included. A refused request reaches neither the Cache API nor the
   box. `checkTokenRevocation` is `true` here (unlike the rendition route,
   which runs it a few lines later, after the blocking-reload directive is
   validated): nothing downstream of this route ever reaches the API, so
   this Worker's own gate is the only one, the same reasoning the LL master
   already applied.
2. **The cache key is the path, never the token** (`edge-cache.ts`'s
   `cacheKeyRequest`, shared with the rendition route) — two viewers in one
   colo produce ONE origin fetch, which is this task's stated acceptance
   test and what `test/ll-media.test.mjs` asserts first. Concurrent misses
   on the same part are coalesced onto one in-flight promise
   (`inFlightMediaFetches`, the same pattern `fetchRenditionCoalesced`
   uses), and only the producer writes the cache entry.
   `Cache-Control: public, max-age=31536000, immutable` because a part, a
   segment and an init segment are written once and never rewritten: their
   names carry a sequence number, so a changed byte is always a new name.
3. **A 404 stays a 404 and is never cached.** `EXT-X-PRELOAD-HINT` names a
   part the box has not finished writing, so a player asking a beat early is
   NORMAL. Caching that for a year would make the part permanently missing
   for every viewer in the colo; it goes out `no-store` instead. Deliberately
   NOT negatively cached even briefly: the gap between "not yet" and "there"
   is one part target, and any hold on re-asking is latency added to the one
   feature whose entire point is not having it. The concurrent case is
   already collapsed by the in-flight map.
4. **The name must be one the remux actually writes.** `isSafeUriSegment`
   answers "can this be a path segment", which is the right question for a
   name `state.json` supplied and the wrong one for a name a VIEWER
   supplied: a valid token plus an endless supply of path-safe names
   (`probe-1`, `probe-2`, …) would be one uncached origin fetch each,
   against the single box serving the party. So the route accepts only
   `init.mp4` / `seg-<n>.m4s` / `part-<n>.m4s` and their `audio-` twins,
   with the prefix required to AGREE with the rung — refused with no origin
   fetch at all, counted by `hlsEdge.llPartNameRefused`. If a producer ever
   changes its naming, `MEDIA_NAME_PATTERN` in `ll-media.ts` is the one
   place to widen.

**The in-flight entry lives until the cache is populated, not until the
origin answers**, and a coalesced waiter is served the cached copy rather
than its own `Response` over the shared buffer. Both came out of a Farol
review of this PR's first commit, and both are about the same burst: a
window in which the cache is still empty and the in-flight entry is already
gone starts a second real fetch exactly when the crowd arrives, and a
buffer fanned out to hundreds of waiters is hundreds of copies of a
several-hundred-KB segment on one isolate. The write happens inside the
shared chain; waiters await it and read the entry back (`X-HLS-Edge-Cache:
COALESCED`), falling back to the shared buffer only if that read comes back
empty.

**Counters**: `hlsEdge.llPartOriginFetch` (one line per real fetch — the
cache and the in-flight map already bound it to roughly one per part per
colo, and it is the line that proves the acceptance test),
`hlsEdge.llPartCacheHit` and `hlsEdge.llPartMissing` (the first occurrence
logged immediately, the rest batched per 10 s window — a party's worth of
cache hits must not become a party's worth of log lines, pitfall 16),
`hlsEdge.llPartOriginRejected` and `hlsEdge.llPartOriginError` for the two
failure shapes.

**One bug found writing this**, worth naming because it had been shipped and
silent: `playlist-route.ts`'s `PLAYLIST_PATH` was a character-for-character
copy of the API's own regex, whose rungs are all alphanumeric
(`720p30`, `1080p60`). `ll-audio` has a hyphen. So since `L2.2` the LL AUDIO
rendition matched no route at all and 404'd from the edge before a line of
LL code ran — the video rung worked, which is exactly the shape that makes
this kind of thing hard to see. Pinned now by
`test/playlist-route.test.mjs`.

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

**A ban or a lost VIEW permission does not cut a viewer off INSTANTLY while
this Worker's cache is warm — that is a real, not a cosmetic, weakening of
the origin's own instant-eviction behavior, and it is the trade-off inherent
to caching authorization-gated content at all.** Without caching, the origin's
own gap is "the next request THIS SPECIFIC VIEWER makes" — a couple of
seconds, per viewer, exactly as `hls-viewer-token.ts`'s own TTL comment on
the API describes. WITH this Worker's shared cache, a cache HIT used to be
served to EVERY viewer holding a still-signature-valid token, revoked or
not, without ever reaching the origin or anything that knew about the
revocation — a popular rung during an active party could keep a banned or
kicked viewer's playlist (and its segment URLs) flowing for as long as other
viewers kept the cache warm, not for one cache window.

**Signed off 2026-09-14; the bound is 30 s.** `PartyPassRevocationGate`
(`src/party-pass-revocation.js`) is now checked BEFORE every cache lookup on
the rendition route, for both a `?t=` token and a `?pp=` party pass — see
"Enabling in production" below for what an operator does to turn this from
"correct code with nothing behind it" into an actual bound. With
`HLS_REVOKED_USERS` provisioned, a cache HIT can no longer outlive a
revocation by more than the gate's cache TTL (`PARTY_PASS_REVOCATION_CACHE_TTL_MS`,
30 s) — tighter than a `?t=` token's own TTL trade-off already was, and
immeasurably tighter than a party pass's 6 h ceiling. Without it, the
pre-sign-off behavior above still applies for a `?t=` token (already
accepted when `LIVE_HLS_PLAYLIST_BASE_URL` first shipped in #559), and a
party pass is refused outright in production rather than riding its full
ceiling with nothing checking it — see "The party pass" below, point 3.

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
   still-fresh `?t=` keeps refilling it; on a genuine miss with no
   ORIGIN-VERIFIABLE `?t=` in hand — no token at all, OR one present but
   already expired or otherwise invalid, gated on `usedPartyPass` rather
   than mere presence, so this Worker never forwards a caller's own bad
   token to the origin on its behalf (that would poison the SHARED
   coalesced fetch for every other caller waiting on the same rung, not
   just this one) — this Worker answers a retryable 503
   (`hlsEdge.partyPassMissWithoutToken` in the logs), not a 401 — the caller
   is not unauthorized, there is simply no fresh copy this specific request
   can produce. In a live party with more than a handful of viewers this is
   a corner, not a common path.
3. **Revocation, closed the same way the shared cache's gap was closed
   above, with one extra rule for production.** `PartyPassRevocationGate`
   (`src/party-pass-revocation.js`) checks `HLS_REVOKED_USERS` before
   honoring a party pass — the SAME gate and the SAME 30 s bound as the
   rendition-route check above. TWO prefixes, not one: `<userId>:<channelId>:`
   (a kick, a ban, a role losing VIEW for one viewer) and
   `channel:<channelId>:` (a channel deleted or gone private for the whole
   audience, which has no fixed viewer list to key per-viewer entries by).
   Each EVICTION writes its OWN key under the relevant prefix —
   `<prefix><revokedAtMs>`, append-only, never overwritten — and the gate
   `list()`s every key under both prefixes and takes the newest, compared
   against the credential's own `issuedAt` claim — the same "minted before
   or after the most recent eviction" rule `hls-revocation.ts`'s in-memory
   check already applies, so a viewer banned and later un-banned mints a
   fresh credential that reads as not-revoked again immediately, rather
   than staying locked out for the old ban record's remaining TTL.
   Append-only on purpose, not one mutable key kept "monotonic" by reading
   before writing: a read-then-conditionally-write design was tried first
   and Farol (2026-09-14) caught the real race in it — two evictions racing
   each other can each read the same "nothing here yet" snapshot before
   either PUT lands, and if the OLDER write's PUT happens to reach
   Cloudflare after the NEWER one already did, the older, smaller
   timestamp silently overwrites it. Giving every eviction its own key
   removes the race outright: two concurrent writers for the same
   (userId, channelId) write two DIFFERENT keys, so there is nothing to
   clobber regardless of arrival order, and each key self-expires on its
   own after the party pass's own 6 h ceiling. Written to by
   `server/src/voice/hls-edge-revocation.ts` the moment `hls-revocation.ts`
   records an eviction (a kick, a ban, a role losing VIEW, a channel going
   private or being deleted), retried through a small bounded in-process
   queue on failure (capped at 1,000 total pending deliveries across every
   key, `voice.hlsEdgeRevocationQueueFull` if that bound is ever hit). See
   "Enabling in production" below for the exact provisioning steps. The
   extra rule:
   because a party pass's ceiling (6 h) is so much wider than a `?t=`
   token's, **honoring one with NO KV behind it at all in production is a
   materially different exposure than the `?t=` trade-off ever was** — so
   `partyPassRequiresKvInProduction` refuses a party pass outright
   (`party-pass-kv-unconfigured`, a 403) whenever `ENVIRONMENT=production`
   and `HLS_REVOKED_USERS` is unbound, rather than falling open the way an
   unconfigured KV does everywhere else. Outside production (local dev, a
   self-host that has not set `ENVIRONMENT`), the pre-sign-off fail-open
   default still applies, so nothing here requires a KV namespace just to
   run the Worker at all.

An operator who is not ready to provision the KV namespace at all sets
`LIVE_HLS_PARTY_PASS_TTL_MS=0` on the API: no pass is minted, `?pp=` never
appears on a stream URL, and this Worker's gate is exactly what it was before
this feature existed — the production refusal above never triggers because
there is never a party pass to refuse.

## Enabling in production

Three pieces, all operator-side — this repo ships the code, not the
Cloudflare account state:

1. **Create the KV namespace** (once, from `tools/hls-edge/`):

   ```sh
   npx wrangler kv namespace create HLS_REVOKED_USERS
   ```

   This prints an `id`. Uncomment the `kv_namespaces` block in
   `wrangler.jsonc` and paste it in:

   ```jsonc
   "kv_namespaces": [
     { "binding": "HLS_REVOKED_USERS", "id": "<the id from the command above>" }
   ],
   ```

   Redeploy the Worker (`npx wrangler deploy`) so the binding takes effect.
   `ENVIRONMENT` is already `"production"` in `wrangler.jsonc`'s `vars` — no
   change needed there.

2. **Give the API a way to write to it.** The API talks to Cloudflare's KV
   REST API directly (`server/src/voice/hls-edge-revocation.ts`), not
   through this Worker, so it needs three env vars set wherever the API
   runs (Fly today, see `docs/deploy-vultr.md` for where next):

   | Var | Value |
   |---|---|
   | `HLS_EDGE_KV_ACCOUNT_ID` | The Cloudflare account id (same account this Worker deploys to) |
   | `HLS_EDGE_KV_NAMESPACE_ID` | The `id` from step 1 |
   | `HLS_EDGE_KV_API_TOKEN` | A Cloudflare API token scoped to **Workers KV Storage: Edit** for that namespace only — not the same token as `CLOUDFLARE_API_TOKEN` used to deploy Pages/Workers from CI, and not given any other permission |

   All three unset (the default on every deployment today) is a supported,
   tested configuration: `writeHlsEdgeRevocation` no-ops silently, and the
   Worker's own unconfigured-KV defaults govern instead (fail open outside
   production, refuse party passes in production — see above).

3. **Verify it end to end** before trusting it live: kick or ban a test
   account from a channel with an active watch party, and confirm
   `voice.hlsEdgeRevocationWriteFailed` does NOT appear in the API's logs
   for that eviction (it logs only on a failed write, never on success — a
   quiet log is the expected outcome). On the Worker side,
   `hlsEdge.partyPassRevocationCheckError` should stay at zero; a nonzero
   rate there means the KV binding is provisioned but not reachable, which
   fails CLOSED (refuses the request) rather than silently doing nothing.

**Staging first.** Repeat step 1 against a namespace named distinctly (e.g.
`HLS_REVOKED_USERS_STAGING`) bound to `pqp-hls-edge`'s staging deploy if one
exists, or reuse the same Worker with a second `wrangler kv namespace create`
result if staging and production share the Worker — either way, confirm the
verification step above on staging before repeating steps 1-2 against
production. There is no code difference between the two; it is purely which
namespace id and which API token end up in which environment's config.

**Rollback**: remove the `kv_namespaces` block from `wrangler.jsonc` and
redeploy, or unset the three `HLS_EDGE_KV_*` vars on the API — either half
reverts independently to the previous, already-shipped behavior (fail open
outside production; refuse party passes in production if the Worker's KV
binding is gone but `ENVIRONMENT` is still `"production"`, which is the
conservative direction to fail in).

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
npx wrangler secret put LL_ORIGIN_KEY             # pqp-remuxd's MEDIA_ORIGIN_KEY; optional until LL_ORIGIN_BASE is set
npx wrangler deploy
```

Then in the Cloudflare dashboard, add a CNAME (or A/AAAA, per how the rest of
`pqp.gg` is routed) for `hls.pqp.gg` to this Worker, proxied. `ORIGIN_BASE` in
`wrangler.jsonc` already points at `https://api.pqp.gg`; change it there (not
as a secret — it is not sensitive) if the API's public host changes.
`LL_ORIGIN_BASE` (also in `wrangler.jsonc`, also not a secret) ships empty —
leave it that way until a real `pqp-remux` box exists and implements
`state.json` ("The `state.json` contract" above); setting it early just means
every viewer's master-playlist fetch pays one extra round trip probing a box
that answers nothing yet, before falling back to the conventional path.
`LL_ORIGIN_KEY` is the credential half — set it whenever `pqp-remuxd`'s
`MEDIA_ORIGIN_KEY` is non-empty (required once its `CONTROL_LISTEN` binds
beyond loopback), matching values on both sides ("`LL_ORIGIN_KEY`: this
Worker's credential against the remux origin" above).

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
