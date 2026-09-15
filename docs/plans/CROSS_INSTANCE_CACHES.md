# Cross-instance caches: every in-memory cache of mutable state, audited against PR #593's bug shape

Written 2026-09-14, the day of the M6 rehearsal 2 age-gate incident (`fix/ws-auth-4401-under-ramp`,
PR #593). Prerequisite for `docs/plans/ALWAYS_ON.md` A0.x — two real API processes serving
production traffic with no session affinity, which is exactly the condition every finding below
needs to go from "theoretical" to "measured in a rehearsal, at a roughly 1-in-N rate".

## The bug shape this audits for

`getAgeGateStatus` (`server/src/services/age-gate.ts`) cached its answer, including `"pending"`,
for 30s in the per-process read-cache (`server/src/lib/read-cache.ts`). `"pending"` is the one
status that is not permanent — the gate is one-shot, so `"passed"`/`"blocked"` can never change
back, but `"pending"` flips the moment an account declares its age — and `invalidateAgeGateStatus`
only ever cleared the *instance* that handled that write. Behind a load balancer with no session
affinity: instance A cached `"pending"`, the declaration landed on (and only invalidated) instance
B, and the WS auth frame that followed read the stale `"pending"` back on A and closed a real,
just-declared account's socket as `4401 Unauthorized`. Fixed by `coalesce()`'s new `shouldCache`
predicate — `getAgeGateStatus` passes `(status) => status !== "pending"`, so the one non-permanent
state is simply never written to the shared store.

**The general shape:** an in-memory cache (`Map`, `read-cache.ts` entry, or anything else module-level)
holding an answer derived from a database row, where a write that can change that answer might land
on a *different* process than the one serving the next read. TTL bounds the damage; a bus-published
invalidation closes it; neither bounds it and no TTL exists at all is the worst combination — that
is what made this audit's one finding worse than the bug it was named for.

**What "cross-instance" means here, concretely:** `CLUSTER_BUS=postgres` shares chat/presence/cache-
invalidation fan-out over Postgres LISTEN/NOTIFY (`server/src/lib/bus.ts`, `bus-postgres.ts`); it is
off by default and one machine runs production today. `isBusEnabled()` returns false with no transport
installed, so every "safe" or "must-fix" verdict below about a *missing* invalidation only matters once
`CLUSTER_BUS` is turned on for two-machine service — which is what `ALWAYS_ON.md`'s A0.x work is
about to do. This audit is timed to land before that flip, not after it finds the next 4401 at 1-in-3.

## Method

Every module-level `Map`/`Set`/`coalesce()` entry under `server/src` that could plausibly hold a
database-derived answer was enumerated (`grep -rn "coalesce(\|new Map(\|new Set("`), then read in
full alongside its write paths. For each, the columns below answer: what it caches, whether a write
on **another** instance can change the cached answer, whether that write path already publishes an
invalidation over the cluster bus, the TTL (`—` means unbounded — answers until explicitly dropped),
the user-visible consequence of serving a stale answer for the TTL (or forever, if unbounded), and
the verdict.

**Verdicts:**
- **safe** — either the security-relevant answer is never cached at all (checked fresh on every
  call), or the write path already publishes a bus invalidation that reaches every instance.
- **bounded-acceptable** — locally cached, no bus invalidation, but the TTL is short and the
  consequence of staleness is cosmetic (a display value, not an authorization decision) or the
  repo has already reasoned about the trade-off explicitly in the code. Listed so the next person
  auditing this does not have to re-derive the same argument from scratch.
- **must-fix** — a security- or state-relevant answer, cacheable indefinitely or for a TTL long
  enough to matter, with no cross-instance invalidation. One found; fixed in this PR.

## Inventory

| # | Cache | What it caches | Mutable via another instance? | Bus invalidation (before this PR) | TTL | Consequence of staleness | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | `age-gate.ts` `getAgeGateStatus` | 18+ gate status per account | yes (declaration) | n/a — `"pending"` is never cached at all (`shouldCache`) | 30s for `passed`/`blocked` (permanent, safe to cache any length) | none — the one mutable value is never cached | **safe** (fixed by #593, the reference bug) |
| 2 | `services/users.ts` `canAccessChannel` (`channel-access:*`) | per-(channel, user) authorization answer | yes (membership, privacy, kick/ban) | **yes** — `CHANNEL_ACCESS_BUS_TOPIC`, from both `invalidateChannelAccessForChannel`/`...ForServer` directly and via `invalidateServerAudience`'s chokepoint | 30s | none while the bus is up; without it, up to 30s of a stale allow/deny | **safe** |
| 3 | `services/users.ts` `getMemberRole` (`member-role:*`) | a member's role in a server | yes (promotion/demotion/kick/ban) | **yes** — rides `invalidateServerAudienceLocally`'s chokepoint, itself published on `AUDIENCE_TOPIC` (`servers.ts`) | 30s | none while the bus is up | **safe** |
| 4 | `services/users.ts` `memberListCacheKey` | a server's rendered member list | yes | **yes** — same chokepoint as #3 | — (`invalidateExact` only) | display-only; membership itself is never derived from this list for an authorization decision | **safe** |
| 5 | `services/servers.ts` `audienceCache` (`getChannelAudience`) | who may see a channel — drives message/notification fan-out | yes | **yes** — `AUDIENCE_TOPIC`, own chokepoint (`invalidateChannelAudience`/`invalidateServerAudience`) | 3s ± 1s jitter | at most 3s of stale fan-out (e.g. a removed member still gets an activity badge) — the file's own comment states this bound and the reasoning | **safe** |
| 6 | `services/servers.ts` `channelListCacheKey` (`listChannels`'s raw fetch) | a server's channel rows (names, positions) — NOT per-viewer | yes | no (local-only `invalidateServerChannelList`) | 2s | cosmetic only: `listChannels` always re-runs `visibleChannelIds` fresh (never cached) to filter the raw list per viewer, so a channel that just went private is still excluded correctly even if the raw list is briefly stale | **bounded-acceptable** — the authorization filter is never cached; only presentation columns are |
| 7 | `ws/voice.ts` `rosterAccessCache` (#534) | per-(channel, user) roster-send authorization | yes | **yes** — `onAudienceInvalidated`/`onPermissionsUpdate` listeners fire from the same bus-published chokepoints as #2/#3/#5 | 30s ± 5s jitter (backstop under the listeners) | none while the bus is up | **safe** |
| 8 | `voice/hls-revocation.ts` `byChannel` | who lost HLS viewer access since their token was minted | yes | **yes** — written by `evictChannelViewersLocally`/`evictUserFromChannelsLocally`, both reachable from a remote instance via `chat.ts`'s `EVICT_TOPIC` | bounded by `HLS_VIEWER_TOKEN_TTL_MS` (60m) — entries older than that cannot matter | ~2s (one playlist poll interval) worst case, per the module's own doc | **safe** |
| 9 | `services/watch-party-seat-cache.ts` (`cachedWatchPartySeatSnapshot`) | per-channel watch-party facts gating who may take a voice seat / hold stage privileges (`join-voice-room`'s seat gate, `ws/voice.ts`) | yes (Voz toggle, co-host add/remove, stage invite, party end — every mutation `broadcastWatchParty` sees) | **no**, before this PR | **none** (unbounded — answers until the *same process* invalidates it) | a viewer whose `join-voice-room` lands on a sibling instance could take or keep a voice seat, or retain co-host/stage privileges, after they were revoked on a different instance — **for as long as the party runs**, not bounded by any TTL | **must-fix — fixed in this PR** |
| 10 | `services/watch-parties.ts` `getActiveWatchPartyRow` (`watch-party:active:*`) | a channel's active-party row (status, draft-ness) for the HTTP read and reconnect catch-up | yes | no (local-only `invalidateActiveWatchParty`) | 2s | a reconnecting client's sidebar/HTTP read could show a party as draft/ended/live up to 2s late; the actual seat gate (item 9) and `broadcastWatchParty`'s own audience walk both read the row live, not through this cache | **bounded-acceptable** — 2s TTL matches the repo's established bound for audience-adjacent presentation caches (cf. item 5); does not gate the security-relevant seat decision |
| 11 | `auth/clerk.ts` `profileCache` | Clerk display name + avatar | yes (a Clerk-side profile edit) | no | 5 min | cosmetic — stale display name/avatar for up to 5 minutes, explicitly reasoned in-repo as the "round-1 Farol fix" precedent this file's own comments reference | **bounded-acceptable** (pre-existing, explicit repo reasoning) |
| 12 | `auth/clerk.ts` `userCache` | the DB `users` row for a Clerk id | yes (a profile write on another instance) | no | 60s | `dm_privacy` is explicitly read fresh from the row on every call (`services/dms.ts`, never through this cache — see its own doc comment); `isInstanceModerator` is a pure function of `clerk_id` + an env var, never DB-derived, so it is not affected by this cache at all; the remaining fields (`display_name`, `avatar_url`, `handle`, …) are presentation | **bounded-acceptable** |
| 13 | `services/automod.ts` `cache` (rule list per server) | a server's AutoMod rules | yes (an owner edit) | no | 30s | a send that should have been blocked (or refused) lands wrong for up to 30s after an edit — explicitly reasoned in-repo: "the cached thing is configuration, not a counter... the accepted cost" | **bounded-acceptable** (pre-existing, explicit repo reasoning) |
| 14 | `automod.ts` `lastAlertAt` | per-(server, author) alert-post cooldown | n/a (not an authorization answer; a rate-limit dedup) | no | 10s | at most one duplicate #mod-log post across two machines; explicitly reasoned in-repo as a nuisance, not a hole | **bounded-acceptable** |
| 15 | `messages.ts` latest-page cache (`coalesce`) | the newest page of a channel's messages (not per-viewer) | yes (a new message) | no | short (`MESSAGES_LATEST_TTL_MS`) | a new message can be briefly absent from the cached "latest page" on an instance that did not handle the send; `hydrate`'s per-viewer shaping (blocked authors, reactions, polls) always runs fresh regardless of cache hit; nothing here gates who may read the channel | **safe** (no authorization content) |
| 16 | `voice/hls-telemetry-session-guard.ts` negative cache | "this session-id lookup recently timed out" | n/a (a reliability guard against a struggling DB lookup, not an authorization or access answer) | no | configurable (`negativeCacheMs`) | a telemetry batch degrades to a composite fallback id for the window; carries no access-control content | **safe** |
| 17 | `voice/hls-playlist-proxy.ts` (`windowHistory`, `segmentUrlMemo`, `playlistCache`, `rungCache`, `keepWarmLoops`) | media/presentation shape of an HLS session (which rungs exist, playlist bodies) | yes, but not an authorization answer — access is enforced separately by the `?t=` capability token and `hls-revocation.ts` (item 8) on every request | no | short, session-scoped (`HLS_PLAYLIST_CACHE_TTL_MS`) | momentarily stale quality-ladder/playlist body on the instance that did not handle the ffmpeg write; does not affect who may view | **safe/bounded-acceptable** (not access control) |
| 18 | `voice/hls-history.ts` (`replayBodyCache`, `replayRungCache`) | a **finished** broadcast's replay segments | no — "a finished broadcast's segments do not change" (the module's own doc) | n/a | 30s | none — content is immutable once the session has ended | **safe** |
| 19 | `services/sanctions.ts` (timeouts) | active member timeout | yes | n/a — **no cache at all**, every check is a live query with `expires_at > NOW()` (Postgres's clock, not the process's) | n/a | none | **safe** (not cached) |
| 20 | `services/moderation.ts` (`isBanned`, kick/ban) | ban status | yes | n/a — no cache; and the write path already calls `invalidateServerAudience` (bus-wired, item 5) | n/a | none | **safe** (not cached) |
| 21 | `services/invites.ts` | invite validity/expiry | yes | n/a — no cache, live query | n/a | none | **safe** (not cached) |
| 22 | `services/blocks.ts` / `friends.ts` | block list, friend status | yes | n/a — no cache; the cross-instance push that does exist (`FRIEND_TOPIC`) is bus-wired | n/a | none | **safe** (not cached) |
| 23 | `services/dms.ts` hide/restore | conversation visibility | yes | **yes** — calls `invalidateChannelAccessForChannel` directly (item 2's bus topic), which is *why* item 2 has its own bus topic rather than riding `servers.ts`'s audience chokepoint (a conversation has no server) | n/a (not cached itself; drives item 2) | none | **safe** |
| 24 | `services/servers.ts` `getServer` | a server row (including privacy-adjacent columns) | yes | n/a — no cache, live query every call | n/a | none | **safe** (not cached) |
| 25 | `INSTANCE_MODERATOR_CLERK_IDS` / `isInstanceModerator` (`services/reports.ts`) | whether an account is an instance moderator, surfaced on `/api/me` | no — pure function of `process.env.INSTANCE_MODERATOR_CLERK_IDS` (identical on every instance, same deploy) and `user.clerk_id` (immutable) | n/a | n/a | none — not DB-derived, not cached, cannot go stale relative to another instance | **safe** (not a cache) |
| 26 | `server/src/lib/rate-limit.ts` `sharedBuckets` | address-keyed token-bucket state | n/a — intentionally per-process; a backstop, not an authorization cache | n/a | n/a | a rate limit is slightly more generous split across N processes than on one; not a correctness or access question | **safe** (out of scope — not DB-derived state) |
| 27 | Live process state: `ws/voice.ts` peers/mutes/hands, `ws/chat.ts` connections/presence, `ws/watch-party.ts`, `ws/music.ts`, `ws/live-reactions.ts` | in-flight connection/room state, not a read-cache of a database row | inherently instance-local by construction (a socket lives on the process that accepted it) | n/a — this is what `CLUSTER_BUS`/`VOICE_REGISTRY` (M1-M5, `MULTI_INSTANCE_VOICE.md`) exist to reconcile, a materially different mechanism from a read-cache with a TTL | n/a | covered by the multi-instance voice plan's own milestones, not this audit | **out of scope** — different bug class (live state reconciliation, not stale-cache-of-a-DB-row); see `MULTI_INSTANCE_VOICE.md` |

## The one must-fix

### `services/watch-party-seat-cache.ts` — no TTL, no cross-instance invalidation, gates a voice seat

`join-voice-room` (`ws/voice.ts`, "THE SEAT GATE") refuses anybody without stream permission from
taking a seat in a watch party's voice room unless `mayTakeWatchPartySeat` says otherwise, and that
check reads `loadWatchPartySeat` → `cachedWatchPartySeatSnapshot`, a module-level `Map` with **no
TTL at all** — it answers from memory until something explicitly drops it. On one process that is
exactly "until the next mutation", because `broadcastWatchParty` (`ws/watch-party-events.ts`) is,
by its own comment, "THE ONE PLACE THAT SEES EVERY STATE CHANGE" and calls
`invalidateWatchPartySeat`/`rememberWatchPartySeatSnapshot` on every one: Voz on/off, a co-host
added or removed, a stage invite, the party ending.

Both of those functions were **local-only**. Behind a load balancer with no session affinity, a
mutation handled on instance A only ever dropped A's copy. Instance B — having already answered a
`join-voice-room` for the same channel once, which is enough to populate its cache forever — kept
serving whatever it last loaded: Voz still on after the host turned it off, a co-host still on the
list after being removed, a stage invite still live after being revoked. Unlike every other entry in
this table, there was no TTL to bound the exposure — it lasted as long as the party did, or until an
unrelated mutation happened to also land on B.

This is PR #593's exact shape (a per-process cache of one-shot mutable state, invalidated only on
the process that handled the write) and strictly worse than it (no TTL versus a 30s one).

**Fix**: `invalidateWatchPartySeat` and `rememberWatchPartySeatSnapshot` now publish over
`lib/bus.ts` on a new topic, `cache.watch-party-seat.invalidate`, carrying only the channel id (never
the snapshot value — a sibling instance always re-derives its own answer rather than trusting a
value shipped across a rolling deploy where the snapshot shape could differ). The subscriber calls
the same local-only invalidation every instance already had. With no bus installed (`CLUSTER_BUS`
unset, today's production default) this is exactly the old behaviour — a single boolean read, then
nothing. Same pattern as `CHANNEL_ACCESS_BUS_TOPIC` in `services/users.ts` (item 2 above).

Two-instance test: `server/src/services/watch-party-seat-cache-cluster.test.ts`, same
two-module-graph-over-one-memory-hub technique as `permission-caches-cluster.test.ts`, except this
module has no database of its own so the test needs no Postgres. Pins: a sibling instance's stale
snapshot is dropped on invalidation; a planted terminal snapshot (party ended) reaches the sibling
as an invalidation rather than a stale replica of the old "voice on" state; and — the always-required
negative case — with no bus transport installed, a sibling instance's cache is untouched, matching
every other cross-instance test in this codebase.

## A related, un-fixed finding: `watch-party-update` has no cross-instance WS fan-out at all

`broadcastWatchParty` sends the `watch-party-update` frame only to sockets it can iterate locally
(`forEachAuthenticatedSocket`). Unlike chat messages (`BROADCAST_TOPIC`), presence (`PRESENCE_TOPIC`)
and permission changes (`PERMISSIONS_TOPIC`), there is no bus topic that re-runs `broadcastWatchParty`
(or an equivalent push) on a sibling instance. A viewer connected to instance B does not learn about
a mutation instance A handled — Voz toggling, a stage invite, the party ending — until their own
socket reconnects or `catchUpWatchParties` runs on a fresh authentication. This is a **different bug
class** from everything in the table above (a missing push, not a stale pull-based cache), and with
this PR's fix the security-relevant half (who may take a seat) is closed regardless: the seat cache
now invalidates cross-instance even though the UI push that would have told the viewer why does not
yet. Left as a follow-up rather than folded into this PR — it needs its own bus topic and its own
test, matching the existing `BROADCAST_TOPIC`/`PERMISSIONS_TOPIC` pattern, and is a UI-staleness bug
rather than the cache-security bug class this audit was scoped to.

## Reading this before A0.x

`ALWAYS_ON.md`'s A0.1 staging rehearsal is what will actually run two live processes with no session
affinity — it is what found PR #593's bug in the first place. Every "safe" verdict above depends on
`CLUSTER_BUS` actually being on when two processes serve traffic (a bus-wired invalidation does
nothing with no transport installed), so a rehearsal is not optional confirmation, it is the thing
that makes these verdicts true rather than aspirational. If a future cache is added to this codebase,
the question to ask before shipping it is the one this document answers for each row: can a write on
one instance change this answer, and if so, does the write path reach every instance — over the bus,
or by never caching the mutable state at all.
