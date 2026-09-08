# Multi-instance voice: running 2+ pqp-api machines with no user-visible split

Status: M1 to M5 landed in code, plus the three two-machine prerequisites the 2026-09-07 window asked for (note below, "2026-09-08"). `CLUSTER_BUS=postgres` and `VOICE_REGISTRY=postgres` are on in production since 2026-09-07, next to LiveKit. Two machines ran for 2 h 39 min on 2026-09-07 and production is back to one by choice; what is left before M6 is the staging rehearsal in `docs/STAGING.md` ("Rehearsing two machines", a checklist an agent can run), then the flip. Written 2026-09-06, the night after the MoonKase watch party incident. Owner: solo maintainer. Budget envelope: ~$165/month total infra.

**Where each milestone stands (2026-09-06):**

- **M0**: the code half is in (`voice.hello` on the bus with the config hash, the boot-time self-echo check from section 9, logging only). The operational half, `CLUSTER_BUS=postgres` on production and a week's soak, has not been done. Production is still one machine with the bus off.
- **M1**: landed, PR `feat/voice-registry-m1`. Schema (all five tables), `server/src/voice/registry.ts`, write-through from `ws/voice.ts` behind `VOICE_REGISTRY=postgres` (default `off`), the atomic transport pin, `resumeToken` on `POST /api/voice/token`, moderation and snapshot reads falling back to the rows, instance heartbeat. Pinned by `server/src/ws/voice-registry.test.ts`, `server/src/api/voice-token.test.ts`, `server/src/ws/voice-hello.test.ts`. Not yet turned on in production; it is inert until it is.
- **M2**: landed, PR `feat/voice-registry-m2` (stacked on M1). The three room topics (`voice.room`, `voice.identity`, `voice.watch`) as described in 4.2, 5.3 and 5.7, gated by `VOICE_REGISTRY=postgres` **and** `CLUSTER_BUS=postgres` together; `broadcastRoster` and `sendAllVoiceRosters` read `voice_peers` with the flag on (one indexed query per roster, still serialised per channel); `welcome.peers` includes the other instance's live peers; the watch party lives in `voice_rooms.watch_party` / `watch_party_rev` with the contract's ordering as the `WHERE` clause. Pinned by `server/src/ws/voice-cluster.test.ts` (two module graphs sharing `pqp_test` and a memory hub). Two details that differ from the sketch: the bus hint is published from inside the roster queue *after* the row write has settled (so the other instance's re-read cannot run ahead of the write), and a `voice.watch` frame is adopted only by an instance with somebody in that room (the cache is torn down with the local room, so an entry for a room nobody here is in would never be removed). Still inert in production.
- **M3**: landed, PR `feat/voice-registry-m3` (stacked on M2). The adopt plan (5.2): a resume whose row another instance holds runs one conditional `UPDATE` (`adoptVoicePeer`) after the transport pin is settled, then takes the reattach path with the row's state (share, camera, mute carried over), and publishes `voice.room { kind: "adopted" }` so the old owner drops its local entry silently; a dead or an alive owner is treated the same, only logged differently (`voice.resumeAdopted`). The reconcile (`reconcileVoiceRegistry`, run by every instance after each heartbeat via `runVoiceReconcile` in `ws/voice.ts`): rows of a dead or leaseless instance are stamped `orphaned_at = heartbeat_at` (or now, when there is no lease row), deleted once that is `VOICE_RESUME_TTL_MS` old in one statement that also retires the id and unpins an emptied room, `peer-left` fanned out locally plus a `left` hint on the bus; room rows with no peers older than 30 s and dead lease rows are swept; the retired-id sweep moved here. `voice_retired_peers` is the only retired store with the flag on (`retiredPeerIds` is never written). `leaveVoiceByResumeToken` is async and answers for a foreign row (the beacon lands on whichever machine): row deleted, id retired, `adopted` then `left` on the bus so the owner forgets the seat before its room is told. `getRoomTransport` consults a per-process read-through cache of `voice_rooms.transport` (filled by every row read, dropped on every `voice.room` frame for the channel), so the synchronous hot paths answer for a room pinned elsewhere. Two details that differ from the sketch: the reconcile skips this instance's own rows entirely (alive by definition; its own orphan timers are the authority), and an orphan whose lease has been dead longer than the resume window is orphaned and removed in the same pass. No client change. Pinned by the "resume across instances" group of `voice-cluster.test.ts` and the flag-off additions to `voice-resume.test.ts`. Still inert in production.
- **M4**: landed, PR `feat/voice-registry-m4` (stacked on M3). Rings (5.5): the ring stays owned by the instance holding the caller's socket (timers, `pending`, `rung`, `anyoneAnswered` all local); the fan-out crosses on `voice.call` as addressed frames (`deliver` for `call-incoming` / `call-ring-cancelled` by user id, `room` for `call-declined` to the call's peers), and `decline` / `answered` from a foreign instance are routed back and handled only by the owner, so `pushIncomingCall` and the missed-call message run once. `handleCallRing` does not ring somebody already in the call on the other machine (rows), and the empty-room grace reads the rows before ending a ring, because the caller may have come back on the other machine. Accepted degradation, documented in the code: an owner that dies mid-ring ends the ring with no `call-ring-cancelled` and no missed-call record (the push already went out; the client's own timeout ends the ring on screen). Moderation (5.8): every eviction publishes `voice.moderation` first (`notify`, `user` with an optional notice, `channel`, `except`), the instance holding the socket says the notice and forgets the peer silently, then the publisher releases each foreign row with `releaseForeignPeer` (row, retired id, `adopted` then `left` on the bus, so the departure is announced once) and runs the SFU half once with the rows' peer ids merged into the identity hint. Re-sweeps (5.4): `scheduleResweep` upserts `voice_resweeps` (the sweep is data, `scope` carries the kind, the room or user, the allowed ids and `knownIdentities`), `tickSfuResweeps` deletes expired rows and claims live unclaimed ones with the `UPDATE ... RETURNING` from 5.4 (`claimed_until = NOW() + 4 s`), sweeping only what it won; `runVoiceReconcile` ticks after every heartbeat on every instance, and a process that wrote a row also keeps one 5 s ticker alive while any row is live, so the acting instance keeps the 5 s cadence and a survivor takes over within a beat. The per-key `setInterval` remains the flag-off path. Pinned by the "moderation" group of `voice-cluster.test.ts`, the "rings across two instances" group of `voice-calls.test.ts` and `voice/admin-resweeps.test.ts` (two graphs tick, one `listParticipants` per key per claim window; a fresh graph picks up the row; identities ride in `scope`). Still inert in production.
- **M5**: landed, PR `feat/voice-registry-m5` (stacked on M4). `fly.toml` says two machines (`min_machines_running = 2`, rolling one at a time, `/health` every 10 s, the single-machine banner replaced by the cluster invariants); the drain in `index.ts` and `lib/drain.ts` (SIGTERM flips `/health` to 503 at once, withdraws the voice lease ahead of the socket closes, settles 2 s, then 1001 in batches of 50 every 100 to 150 ms with a 10 s cap on the socket half and a 25 s cap on the whole, inside `kill_timeout = 30`; `/up` deliberately stays green); CI asserts the started machine count against `min_machines_running` (or the repo variable `PQP_API_MACHINES`, set to 1 until the flip), the region, and that every started machine runs one image (the dual-version probe); the mesh guard in `join-voice-room` (with the registry on and at least one other live lease, a room that would open on mesh opens on LiveKit, and a join into a room another instance holds on mesh, or any mesh join without an SFU, is refused with `voice-join-refused` + `reason: "mesh-multi-instance"`; a room this instance holds is never guarded; `voice.meshClusterUnsafe` warns once per episode after each heartbeat when two are live with `LIVEKIT_*` unset). Pinned by `server/src/lib/drain.test.ts` and the "mesh across instances" group of `voice-cluster.test.ts` (which replaced the "mesh guard (M5)" group on 2026-09-08, when the refusal went away; `guardMeshAcrossInstances` itself was deleted later that night, see the second 2026-09-08 note). Two details that differ from section 6: the settle before the first close is 2 s and the batches are 50 per 100 to 150 ms (a full 600-socket machine drains in under two seconds; the ramp the plan wanted is there, the eight to ten seconds were not needed), and the count assertion reads `fly.toml` rather than hard-coding 2. Not rehearsed on staging yet (checklist in `docs/STAGING.md`); the self-echo failing `/health` is still a follow-up. Flag off everywhere, and production is still one machine.
- **M6**: not started. Rehearse on staging first (`docs/STAGING.md`, "Rehearsing two machines", with `LIVEKIT_*` set), then merge `min_machines_running = 2` in `fly.toml` and `fly scale count 2 --region gru --app pqp-api` (`docs/deploy-fly.md` 6a-bis has the exact order, including the `PQP_API_MACHINES` variable that keeps CI true in between).

**2026-09-07, the two-machine window (13:20Z to 15:59Z):** production ran two machines in `gru` with the bus, the registry and LiveKit live on both. No split: bus self-echo passed on both, six LiveKit rooms spanned both machines for up to 80 minutes, one cross-machine resume adopted live, zero app-level errors, zero user reports. Two-machine-specific: exactly four `voice.meshRefusedMultiInstance` refusals (each a hung-up call, one two-person call ended) and two unexplained proxy-side 1001 close bursts. Back to one machine by choice, `fly.toml` `min_machines_running = 1`, `--ha=false` on every deploy as before. What had to land before two again is in `docs/deploy-fly.md` 6a-bis: the guard adopting the pin instead of refusing, a cross-instance frames counter, `roomServerMutes` on the bus, a staging rehearsal with `LIVEKIT_*` set, then `min = 2` merged plus `fly scale count 2`.

**2026-09-08, the three code prerequisites (PR `fix/two-machine-prereqs`):** the code paths below are dormant on one machine (the bus delivers nothing to itself and the guard counts zero other leases), so the deploy that carries them changes nothing until the flip.

1. **Mesh crosses instances; the guard adopts the pin.** `join-voice-room` reads `voice_rooms.transport` before the guard when another lease is live: a room pinned elsewhere is adopted whatever it says (`voice.meshPinAdopted` when it is mesh), and only a room nobody has pinned is guarded (SFU when configured, mesh otherwise; `guardMeshAcrossInstances` has no `refuse` verdict any more and `voice.meshRefusedMultiInstance` is gone). What made that safe is the fourth bus topic the file banner said was missing: `voice.signal` carries an offer, answer or ICE candidate whose target this instance does not hold, stamped with the sender's room, and the instance holding the target applies the same-room rule against its own map before delivering. The joiner's peer list and the `peer-*` frames already came from the rows and `voice.room` (M2), so the mesh forms across machines; the ceiling now counts the rows too (with the read-then-write window between two simultaneous joins on two machines that section 2.1 always named, accepted: a nine-person mesh for one call is a quality cost, not a split). A resume whose token remembers the stored transport is kept even when the guard wanted the SFU for it (before, `voice.transportAdopted` turned it cold). At this point a fresh room while two were live still opened on LiveKit when `LIVEKIT_*` was set; that went the same night (next note).
2. **Moderator mutes are cluster state.** `voice_server_mutes (channel_id, user_id)`, cascading with the room row (the sanction's lifetime was always the room's). `setVoiceUserServerMuted` writes the row, publishes `voice.serverMute`, then runs the local half; the receiving instance forces `muted` on the seats it holds, rewrites their rows and fans out; a join reads the row on its way in (so a seat minted on the other machine, or after a restart, comes back muted and `set-voice-state` refuses the unmute there); every roster row carries `server_muted`. The in-process map became a per-room cache that only a process holding a seat in the room keeps.
3. **Two counters in `GET /api/admin/metrics`, `voice.cluster.framesRelayed` and `voice.cluster.framesReceived`:** voice frames this instance published for sockets held elsewhere, and voice frames from the bus it applied to a socket it holds (a room frame for a room it has peers in, a signal for a peer it holds, a ring delivered, a notice said, a mute applied). Both zero on one machine; both climbing within a minute of two machines sharing a room. Per instance, since boot, like the roster counters next to them.

Pinned by the "mesh across instances" and "moderator mutes across instances" groups of `voice-cluster.test.ts`; each mechanism was broken on purpose (relay not published, pin adoption turned cold, mute row and frame each suppressed, each counter frozen) and its test failed, then restored.

**2026-09-08, later, the guard goes (PR `fix/two-machines-keep-transport-policy`):** the first staging rehearsal passed every step above, but only with `LIVEKIT_*` unset, because `guardMeshAcrossInstances` still sent every unpinned room that would open on mesh to the SFU whenever an SFU was configured and another lease was live. Production has the SFU configured, so the flip would have moved every new room, however small, onto the one two-core media box; that night's peak was 41 rooms and 34 screen shares, almost all mesh, more than the box carries. The guard was a stand-in for the days when mesh could not cross instances, and it can now, so it is deleted: with the registry on and another instance live, an unpinned room gets exactly what `resolveVoiceTransport` says (DMs mesh, servers under ten mesh, communities and larger servers LiveKit, the per-channel override first) and pins it atomically in `voice_rooms`, on one machine or two alike. The pin adoption from the previous note is untouched, and `voice.meshPinAdopted` now comes from the atomic pin's outcome (`claimVoiceRoomTransport`, `won: false` on a mesh row) instead of a second read; `voice.meshGuardForcedSfu` and the extra lease count per mesh join are gone. The ceiling still counts the rows on both machines. What is left of "mesh across instances cannot work", read against `voice.signal` and the ceiling: (1) a signaling frame is dropped, on either side, for a peer id nobody holds, which covers the window between the `adopted` frame and the new owner seating a resumed peer; the resumed client re-offers after its `welcome`, so what is lost belongs to the old session; (2) the bus is best-effort, so a candidate can be lost while the LISTEN connection is reconnecting, which the client's ICE restart and Retry already cover for a lost candidate on one machine; (3) the read-then-write window on the ceiling between two simultaneous joins on two machines, a nine-person mesh for one call. None of those is a split, and none needed the blanket override. Pinned by three tests in the "mesh across instances" group: two live and an SFU, a small server room is mesh on both machines and the offer crosses; a community and a ten-member server still open on LiveKit and a small room next to them stays mesh; a mesh pin on A is adopted by a cold join on B whose own policy now says LiveKit. Broken on purpose (the force-SFU branch put back: the first and third fail, plus the small-room line of the second; the policy's community and large branches disabled: the second fails), then restored. The staging rehearsal must run with `LIVEKIT_*` set (`docs/STAGING.md`).

## 0. Summary and recommendation

**Recommendation: keep Postgres as the only shared substrate. Do not add Redis.**
Extend the existing `CLUSTER_BUS=postgres` LISTEN/NOTIFY bus (already built, tested
across two simulated instances, flagged off) with a small *authoritative* voice
registry in two Postgres tables (`voice_rooms`, `voice_peers`) plus a claims table
for singleton work. **Multi-instance mode requires LiveKit**; mesh stays the
single-machine, self-host path and is refused when the cluster has more than one
live instance.

Rough effort: **12-16 working days** of focused solo work spread over ~4 calendar
weeks (the soak periods are the calendar, not the typing), in seven independently
shippable milestones (Section 8). Recurring cost delta: +1 Fly machine on top of
today's performance-2x (~$65/mo if matched, ~$22/mo if the pair is downsized to
shared-cpu-2x after a week of CPU data). LiveKit Cloud Ship ($50/mo) is already
paid for as of 2026-09-05.

What users get: a deploy becomes "your socket blinks and comes back on the other
machine with the same peer id"; a machine failure becomes the same thing. Media
never blinks because it is on LiveKit and the resume token already survives a
process restart.

## 1. Where we are

- `fly.toml`, `deploy-api-fly.yml` and `docs/deploy-fly.md` all enforce **exactly one
  machine** (`--ha=false`, CI asserts count == 1). Every merge that touches
  `server/` or `packages/` replaces that machine and closes every `/ws` with 1001.
- Chat is *already* multi-instance capable behind `CLUSTER_BUS=postgres`
  (`server/src/lib/bus.ts`, `bus-postgres.ts`, subscribers in `ws/chat.ts`,
  `ws/status.ts`, `services/servers.ts`). Never soaked on two real replicas.
- Voice is deliberately **not** on the bus (banner above `peers` in
  `server/src/ws/voice.ts`). With LiveKit the media path already spans instances;
  what breaks is signalling-adjacent state: roster, transport pin, resume, rings,
  moderation targeting, SFU re-sweeps, watch party.
- **LiveKit Cloud has been live in production since 2026-09-05 21:22Z** (Ship plan).
  Every room that started after that moment is on the SFU; a 100-person watch party
  ran on it the same night. Mesh is still what a room gets when `LIVEKIT_*` is unset.

## 2. Inventory of in-process state on the WS paths

Classification: **C** = per-connection (fine as-is), **R** = per-room / cross-user
(must be shared or owner-routed), **P** = per-process cache (fine, or needs
invalidation), **S** = singleton work (must run on exactly one instance).

### 2.1 `server/src/ws/voice.ts`

| State | Class | Today | Multi-instance need |
|---|---|---|---|
| `peers: Map<peerId, VoicePeer>` (holds the `socket`) | C for the socket, **R** for everything else (userId, channel, displayName, avatar, mute/deafen, sharingScreen, camera/screen stream ids, `orphanedAt`, `canResume`) | whole room = local map | Authoritative copy in `voice_peers`; local map keeps only peers whose socket is here |
| `socketToPeerId` | C | | unchanged |
| `retiredPeerIds` (blocks reconstruct of a hung-up id for token TTL) | **R** | local timer map | Column on `voice_peers` (`retired_at`) or tombstone row; check before reconstruct |
| `roomTransports: Map<channelId, VoiceRoomTransport>` | **R** | first joiner pins, cleared on empty | `voice_rooms.transport`, set with `INSERT ... ON CONFLICT DO NOTHING` (atomic), deleted when the last peer row goes |
| `rosterQueue` (per-channel roster send serialisation) | P | | unchanged, per instance |
| `roomLimiter`, `stateLimiter`, `ringLimiter` | P | | stays per-instance (see `lib/rate-limit.ts` header); acceptable |
| `peakRoomSizeToday`, `peakDay`, `peakTrackedSince` | P | operator metric | per-instance peak; `getVoiceActivitySnapshot` rooms/participants should read `voice_peers` so the admin dashboard is cluster-wide |
| `conversationRings: Map<conversationId, ConversationRing>` incl. `timer`, `emptyRoomTimer` | **R** (owner-routed) | ring owner = instance the caller's socket is on; `sendToUserSockets` is local only | Keep timers on the owner instance; fan `call-incoming` / `call-ring-cancelled` / `call-declined` over the bus; route `call-decline` from a foreign instance back to the owner over the bus |
| orphan timers (`peer.orphanTimer`) | **R** | local 90 s timer | Timer stays local while this instance is alive; the *instance lease* (Section 5.2) covers the dead-instance case |

### 2.2 `server/src/ws/watch-party.ts`

| State | Class | Need |
|---|---|---|
| `parties: Map<channelId, WatchPartyState>` (rev-based) | **R** | `voice_rooms.watch_party JSONB` + `watch_party_rev`, updated with `WHERE watch_party_rev < $rev` (its own protocol is already rev-monotonic, so the DB write is the coalescing point); fan `watch-party` frames over the bus |
| `writeLimiter` | P | per-instance |

### 2.3 `server/src/voice/admin.ts`

| State | Class | Need |
|---|---|---|
| `resweeps: Map<key, setInterval>` | **S** | Move to `voice_resweeps` table; every instance ticks, only the row claimant sweeps (Section 5.4). Bonus: survives a deploy, which today drops the remaining sweeps |
| `cached` RoomServiceClient | P | fine |
| `inFlight` | P (tests only) | fine |

### 2.4 `server/src/ws/chat.ts`, `status.ts`, `sockets.ts`, `ws/index.ts`

Already handled by the bus or per-connection:

| State | Class | Status |
|---|---|---|
| `connections`, `channelPresence`, `sockets` (sockets.ts), `alive` WeakMap | C | fine |
| `remotePresence`, `remote` (status) | P mirror of other instances | already TTL-refreshed (20 s / 60 s) |
| `slowModeLimiters`, message/reaction/typing limiters, `socketLimiter`, `connectionLimiter` | P | per-instance, documented multiplication |
| `audienceCache` (servers.ts) | P with invalidation | already invalidated over `AUDIENCE_TOPIC` |
| `forEachAuthenticatedSocket` fan-outs used by voice (`broadcastRoster`, `sendToUserSockets`, missed-call `channel-activity`) | local only | Must be paired with a bus publish so the other instance fans out to *its* sockets |

### 2.5 Other per-process things that touch voice

- `POST /api/voice/token` (`api/index.ts`) calls `getVoicePeer(peerId)` against the
  local map. HTTP is load-balanced **per request**, so with two machines roughly
  half of token mints would 403 today. Fix in Section 5.1.
- Voice moderation routes (`getVoiceChannelForUser`, `disconnectVoiceUser`,
  `notifyVoiceModeration`, `setSfuUserMuted` via `getVoicePeerIdentities`) read the
  local map for targeting and notices.
- `POST /api/voice/leave` beacon and `leaveVoiceByResumeToken` need the peer row,
  not the local map.
- `refreshVoiceIdentity` (profile edit) only updates local peers.
- `pushIncomingCall` comment says "voice is per-instance so this cannot double-send";
  once rings fan out over the bus, only the ring **owner** may push.

## 3. The existing CLUSTER_BUS

**What it is.** `server/src/lib/bus.ts` is a topic pub/sub seam with an
`INSTANCE_ID` origin guard, `publishToCluster` (fire-and-forget, never throws,
returns before delivery), `subscribeToCluster` (registered at import time), and a
memory transport for tests. `bus-postgres.ts` is the only production transport:
one dedicated `pg.Client` outside the pool doing `LISTEN pqp_cluster` and
`pg_notify`, FIFO per connection, spills frames > 7000 bytes into
`cluster_bus_payloads`, reconnects with backoff, drops (does not buffer) while
down. Requires a session-mode connection (transaction poolers break LISTEN).

**What it fans out today.** Topics: `BROADCAST` (chat messages), `PRESENCE`
(channel viewers, TTL-refreshed contributions), `TYPING`, `ACTIVITY` (unread
badges, no web push on the remote side), `EVICT` (channel/user viewer eviction),
`PROFILE`, `FRIEND`, `PERMISSIONS`, `COMMUNITY_HOME`, `status.presence` (user
status snapshots + updates + hello), `AUDIENCE` (cache invalidation). Boot wiring
is `startClusterBus()` in `server/src/index.ts`; shutdown closes the bus after the
sockets so presence withdrawals still travel.

**Can it carry roster/join/leave?** Yes, with two caveats that shape the design:

1. It is **fan-out, not state**. Chat solved "who is in channel X" with
   per-instance *contributions* plus TTL refresh, and that pattern would work for
   the voice roster too. But voice also has things that need an **atomic decision**
   (transport pin, mesh ceiling) and things that need **lookup from an HTTP
   request on any instance** (token mint, moderation target). Gossip cannot do
   either. Hence the registry tables in Section 4; the bus remains the fast path
   that tells the other instance "re-read and re-fan-out room X now".
2. **Delivery is best effort**. The banner's point 4 (a lost `peer-left` leaves a
   permanent ghost) is real. It is answered by making the bus frame a *hint* and
   the table the *truth*: the roster is rebuilt from `voice_peers` on every
   `voice.room` frame and on a slow periodic reconcile, so a dropped frame costs
   latency, not correctness.

Headroom: measured chat is ~180 msg/s; the bus transport is good for a few
thousand frames/s. Voice adds a handful of frames per join/leave/state toggle.
Not a concern at this scale.

## 4. Where shared room state lives: Postgres vs Redis

| | Postgres (MPG, already paid for) | Redis (Upstash / Fly Redis) |
|---|---|---|
| New dependency, secret, failure mode, page | none | one of each |
| Cost | $0 marginal | Upstash pay-as-you-go ~$10+/mo at this volume; Fly Redis (Upstash-backed) similar |
| Pub/sub | have it, tested, session-pooler caveat known | native, faster, no 8 KB cap |
| Atomic conditional write (transport pin, claim) | `INSERT ... ON CONFLICT DO NOTHING`, `UPDATE ... WHERE ... RETURNING` | `SET NX`, Lua |
| TTL / lease | explicit `expires_at` + sweep | native `EXPIRE` |
| Durability of the registry across a full restart | yes (rows survive, which is exactly what cross-deploy resume wants) | volatile unless persisted |
| Volume | rooms x participants, tens of rows; join/leave a few/s | trivially fine |
| Solo-maintainer cognitive load | one system, one connection string, one backup | two systems |

**Decision: Postgres.** The registry is tiny and low-churn, the atomic primitives
are ordinary SQL, the bus already exists on it, and durability is a *feature* here
(a full-cluster restart should still find the rooms). `BusTransport` stays the
seam if Redis is ever wanted for throughput; nothing in this plan writes
Redis-specific code. Pool budget: two machines at `PG_POOL_MAX=20` each plus two
LISTEN sessions is 42 backends, inside the ~50 that a 2 GB cluster carries
comfortably (see `docs/DB_RUNBOOK.md`). Do not run two machines at 40 each.

### 4.1 Schema (additions to `server/src/schema.sql`, all `IF NOT EXISTS`, inert when unused)

```sql
-- One row per occupied voice room. Row exists iff the room has a peer row.
CREATE TABLE IF NOT EXISTS voice_rooms (
  channel_id        UUID PRIMARY KEY,
  transport         TEXT NOT NULL CHECK (transport IN ('mesh','livekit')),
  watch_party       JSONB,
  watch_party_rev   BIGINT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per voice peer anywhere in the cluster (the map, made shared).
CREATE TABLE IF NOT EXISTS voice_peers (
  peer_id               UUID PRIMARY KEY,
  channel_id            UUID NOT NULL REFERENCES voice_rooms(channel_id) ON DELETE CASCADE,
  user_id               UUID NOT NULL,
  instance_id           UUID NOT NULL,            -- who holds the socket
  display_name          TEXT NOT NULL,
  avatar_url            TEXT,
  muted                 BOOLEAN NOT NULL DEFAULT FALSE,
  deafened              BOOLEAN NOT NULL DEFAULT FALSE,
  sharing_screen        BOOLEAN NOT NULL DEFAULT FALSE,
  camera_stream_id      TEXT,
  screen_audio_stream_id TEXT,
  can_resume            BOOLEAN NOT NULL DEFAULT FALSE,
  orphaned_at           TIMESTAMPTZ,              -- socket gone, seat held
  joined_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_voice_peers_channel ON voice_peers (channel_id);
CREATE INDEX IF NOT EXISTS idx_voice_peers_user ON voice_peers (user_id);
CREATE INDEX IF NOT EXISTS idx_voice_peers_instance ON voice_peers (instance_id);

-- Hung-up ids that must not be reconstructed for the token's life.
CREATE TABLE IF NOT EXISTS voice_retired_peers (
  peer_id     UUID PRIMARY KEY,
  retired_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Instance liveness. A row older than the TTL is a dead instance.
CREATE TABLE IF NOT EXISTS voice_instances (
  instance_id   UUID PRIMARY KEY,
  config_hash   TEXT NOT NULL,                     -- LiveKit URL + key id hash, for drift detection
  heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Singleton work: SFU re-sweeps that must run on exactly one instance.
CREATE TABLE IF NOT EXISTS voice_resweeps (
  key           TEXT PRIMARY KEY,                  -- 'room:<id>' | 'private:<id>' | 'user:<id>'
  scope         JSONB NOT NULL,                    -- rooms / allowed ids / knownIdentities
  evicted_at    TIMESTAMPTZ NOT NULL,
  until         TIMESTAMPTZ NOT NULL,
  claimed_until TIMESTAMPTZ NOT NULL DEFAULT 'epoch'
);
```

Rings are **not** tabled (Section 5.5 explains the owner-instance choice).

### 4.2 New bus topics

| Topic | Payload | Handler on the other instance |
|---|---|---|
| `voice.room` | `{ channelId, kind: "joined"\|"left"\|"updated"\|"roster" , peer? }` | forward `peer-joined/left/updated` to *local* peers of that room; rebuild roster from `voice_peers` and fan to local audience sockets |
| `voice.call` | addressed frames: `call-incoming`, `call-ring-cancelled`, `call-declined` with `userIds` / `channelId`; plus inbound `call-decline { conversationId, userId }` for the ring owner | deliver to local sockets; owner handles the decline |
| `voice.moderation` | `{ userId, channelId, notice }` | `notifyVoiceModeration` locally, then remove local peers |
| `voice.identity` | profile refresh `{ userId, display_name, avatar_url }` | `refreshVoiceIdentity` locally |
| `voice.watch` | `{ channelId, state }` | `broadcastToRoom` locally |
| `voice.hello` | `{ configHash }` | log `voice.configDrift` loudly if it differs from ours |

## 5. The hard cases

### 5.1 "One room, one transport" across instances

- Pin = `INSERT INTO voice_rooms (channel_id, transport) VALUES ($1, $2) ON CONFLICT
  DO NOTHING RETURNING transport`, then `SELECT transport` if no row returned.
  Whoever inserts first decides; the loser adopts. Reconstruct-after-deploy does
  the same insert with the token's remembered transport, so the first
  reconstructor pins the old transport and everyone else lands on it, exactly as
  today's `roomTransports.set` on reconstruct.
- Unpin = the last `DELETE FROM voice_peers` also deletes the room row when
  `NOT EXISTS (SELECT 1 FROM voice_peers WHERE channel_id = $1)` (one statement).
- Config drift (the documented residual risk): both machines read the same Fly
  secrets, so drift only happens mid-rollout. The `voice.hello` hash makes it
  visible; the atomic pin makes it harmless (the room follows the first joiner).
- `getRoomTransport` becomes async-aware: keep a per-process read-through cache of
  `voice_rooms` invalidated by `voice.room` frames, so the hot paths
  (`set-sharing-screen` caps, relay guard) stay synchronous.
- **Token endpoint**: extend `voiceSessionRequestSchema` with optional
  `resumeToken`. The HMAC already proves `{ userId, peerId, voiceChannelId }`, so
  a valid one is sufficient proof with **no registry read**; `displayName` is
  resolved via `resolveMemberName`. Fallback order: local map, then
  `voice_peers` row, then 403. Old clients without the field still work.

### 5.2 Resume after a deploy landing on a different machine

Today: reattach (peer in local map) or reconstruct (map empty, HMAC valid). Add a
third plan, **adopt**: the row exists in `voice_peers` with a foreign
`instance_id`. Rules:

- If the foreign instance is **dead** (no `voice_instances` heartbeat within
  `INSTANCE_TTL_MS`, propose 45 s with a 15 s heartbeat) or the row is
  `orphaned_at IS NOT NULL`: `UPDATE voice_peers SET instance_id = me, orphaned_at
  = NULL WHERE peer_id = $1 AND user_id = $2 AND channel_id = $3 RETURNING *`,
  then behave like reattach (no `peer-left` was ever broadcast). Publish
  `voice.room updated`.
- If the foreign instance is **alive** and the row is live: the old socket is
  probably half-open (Wi-Fi blip landing on the other machine). Adopt anyway with
  the same conditional update, and publish `voice.room { kind: "adopted", peerId }`
  so the old owner drops its local entry without broadcasting `peer-left`. This is
  the cross-instance version of today's `reattachVoicePeer` overwriting
  `peer.socket`.
- Orphans of a dead instance: a periodic reconcile (every instance, cheap query)
  marks rows of expired instances `orphaned_at = heartbeat_at` and, after
  `VOICE_RESUME_TTL_MS` past that, deletes them and publishes `left`. So a client
  that comes back within 90 s of its machine dying keeps its seat; one that does
  not is cleaned up by whoever is alive. Both instances may race the delete; the
  delete is idempotent and `voice.room` frames are hints.
- `retiredPeerIds` moves to `voice_retired_peers` (checked in `planVoiceResume`,
  swept by the same reconcile). `leaveVoiceByResumeToken` and the `/api/voice/leave`
  beacon operate on the row, then publish `left`.

Client changes: none required. `use-voice.ts` already sends `resumePeerId` +
`resumeToken` on every join and treats `welcome.resumed` as "keep media". The
only client change is the optional `resumeToken` in the token request (5.1).

### 5.3 Roster and room fan-out

Two audiences, as today: the **room** (`peer-joined/left/updated`, `watch-party`,
`call-declined`) and the **channel audience** (`voice-roster`). Every place that
calls `broadcastToRoom` / `broadcastRoster` on a *state change* does: write the
row, fan out locally, `publishToCluster("voice.room", ...)`. The subscriber does
the local half only (never republishes; same rule as `sendPresence`).
`broadcastRoster` reads participants from `voice_peers` instead of the local map
(one indexed query per roster, already serialised per channel by `rosterQueue`).
`sendAllVoiceRosters` on auth reads `voice_peers` grouped by channel.

### 5.4 LiveKit eviction re-sweeps on exactly one instance

`scheduleResweep(key, sweep)` becomes: upsert `voice_resweeps (key, scope,
evicted_at, until)`, run the first pass immediately on the acting instance (it
has `knownIdentities`), and rely on a single cluster-wide ticker: every instance
runs every 5 s `UPDATE voice_resweeps SET claimed_until = NOW() + interval '4
seconds' WHERE claimed_until < NOW() AND until > NOW() RETURNING *`, and sweeps
only the rows it won. Expired rows are deleted by the same tick. Result: at most
one sweeper per key per interval, no leader election, survives deploys (today a
deploy inside the 15-minute window silently drops the remaining sweeps, which
this plan fixes as a side effect). `knownIdentities` rides in `scope` so a
participant on a pre-metadata token is still resolvable from any instance.

### 5.5 Conversation rings

Keep the ring **owned by the instance holding the caller's socket** (timers,
`pending`, `rung`, `anyoneAnswered`), because moving the 45 s / 5 s timers into
SQL buys nothing at this scale. Make the *fan-out* cluster-wide over
`voice.call`. `noteConversationCallJoin` on a foreign instance publishes
`{ kind: "answered", conversationId, userId }` for the owner; `handleCallDecline`
publishes `{ kind: "decline" }` if there is no local ring. Only the owner calls
`pushIncomingCall` and posts the missed-call message. Accepted degradation: if
the owner dies mid-ring, the ring ends without a missed-call record (the callee's
phone push already went out). Documented, not fixed.

### 5.6 Mesh: pin or require LiveKit?

**Historical (2026-09-06): require LiveKit for multi-instance.** Superseded on 2026-09-08: the 2026-09-07 window showed the refusal hanging up real calls, and the relay it argued against (`voice.signal`, one bus hop per signaling frame, same-room rule enforced by the receiver) is now in place, so a mesh room spans instances and the guard only routes a fresh room to the SFU when one is configured. The reasoning is kept because point 1 is still why a fresh room prefers the SFU. Reasons, in order of weight:

1. Every one of the four banner problems has a shared-registry answer now, but
   the relay path (`relayToTarget` over the bus, hop per ICE candidate) adds
   latency and a lost-frame mode to the most timing-sensitive part of the
   product, for a transport whose ceiling is 8 people and which the project is
   leaving.
2. Session affinity is not available: Fly's proxy balances per connection and
   the two people who need each other connect independently.
3. Production is on LiveKit already; mesh remains the documented self-host
   default, single machine, exactly as today.

Enforcement as it stands (2026-09-08, second note in the header): the lease
count no longer picks a transport. A room nobody has pinned gets the policy's
answer (`transport-policy.ts`), pinned atomically; a room pinned elsewhere is
adopted; nothing is refused for being mesh. The boot warning
(`voice.meshClusterUnsafe`) went with the refusal, and the force-SFU verdict
went the same night, because production has an SFU configured and a busy
night's small rooms do not fit on it.

The open product question of 2026-09-06 (small rooms back on mesh to save
participant-minutes) was answered by the policy itself (DMs and servers under
ten are mesh), and the pin-to-one-instance-or-refuse alternative it named is
what the 2026-09-07 window showed to be a hangup; the relay is the answer.

### 5.7 Watch party

Room-scoped state, room spans instances. `applyWatchPartyWrite` keeps its
coalescing logic; the adopted write becomes `UPDATE voice_rooms SET watch_party =
$2, watch_party_rev = $3 WHERE channel_id = $1 AND watch_party_rev < $3` (a
"stale" result is a row not updated). Fan `watch-party` over `voice.watch`.
`welcomeVoicePeer` reads the room row for the initial state. `endWatchParty`
clears the columns when the room empties.

### 5.8 Metrics and moderation targeting

`getVoiceActivitySnapshot` rooms/participants from `voice_peers` (async; the
admin metrics route is already async). `getVoiceChannelForUser`,
`getVoicePeerIdentities`, `disconnectVoiceUser`, `notifyVoiceModeration` read
rows and publish `voice.moderation` so the target hears the notice on whichever
machine holds it before the row is deleted.

## 6. Rolling deploys on Fly with two machines

`fly.toml` changes (all `restarts-api`):

- `[deploy] strategy = "rolling"`, `max_unavailable = 1` (integer: one machine
  at a time; with two machines the other stays up throughout). Do **not** use
  `bluegreen` (doubles machine count during deploy, and the drain story below is
  simpler with in-place rolling).
- `kill_timeout = 30` stays. Shutdown sequence in `index.ts` becomes: flip a
  `draining` flag so `/health` answers 503 (Fly's proxy stops sending new
  connections to a machine failing checks; also protects the scenario where the
  check fires during the window), wait ~2 s, then close sockets with 1001 in
  **jittered batches over ~8-10 s** (e.g. 50 sockets per 500 ms) instead of all
  at once, so the surviving machine sees a ramp, not a stampede (the address
  limiter in `ws/index.ts` measured ~300 simultaneous joiners as its ceiling;
  `TRUST_PROXY=true` keeps that per client, but the pool and Clerk verification
  still prefer a ramp). Then `httpServer.close()`, `closeBus()`, `closePool()`.
- `[[http_service.checks]]`: `interval = "10s"`, `timeout = "5s"`, `grace_period
  = "30s"`. Tighter interval is now safe because an unhealthy machine has a
  sibling to fail over to.
- `[http_service.concurrency]` stays `type = "connections"`, `soft_limit = 400`,
  `hard_limit = 600`; the proxy prefers the machine under its soft limit, which
  spreads reconnects.
- `auto_stop_machines = "off"`, `auto_start_machines = false`, and
  `min_machines_running = 2`.
- Remove the single-machine banner and replace it with the new invariant
  (exactly two machines, both `gru`, `CLUSTER_BUS=postgres`, `LIVEKIT_*` set).

`deploy-api-fly.yml`: drop `--ha=false`, keep `--strategy rolling`, change the
assertion to `live == 2` and region `gru`, and add a post-deploy probe that both
machines report the new `version` (`fly machines list --json` + `fly ssh console
-C 'curl -s localhost:3001/health'` or the public `/health` sampled several
times). `fly scale count 2 --region gru` is a one-time manual step, recorded in
`docs/deploy-fly.md`.

Client side: `realtime.ts` already backs off on 1001 and re-resolves a Clerk
token per attempt; `use-voice.ts` already holds media across the blink. Add
jitter to `RECONNECT_BASE_DELAY_MS` if not present (check
`client/src/lib/realtime.ts`). iOS/Android still hang up on a socket close
(no resume token support); unchanged by this plan and stated in the risks.

## 7. Feature flags and rollback

- `CLUSTER_BUS=postgres` (exists) turns on fan-out.
- New `VOICE_REGISTRY=postgres|off` (default `off`) gates registry writes/reads.
  `off` keeps `voice.ts` byte-for-byte today's behaviour; the tables sit empty.
- Rollback at any milestone: `fly scale count 1 --region gru`, then set
  `VOICE_REGISTRY=off` (and `CLUSTER_BUS=off` if needed). Rows left in
  `voice_peers` are ignored when the flag is off and swept by the reconcile when
  it is next on. No schema rollback needed; all tables are additive.
- Rollback of LiveKit itself: unset `LIVEKIT_*`; next room in each channel
  is mesh; requires count 1.

## 8. Milestones

Each is independently shippable behind flags, marked `restarts-api` when merging
it redeploys `pqp-api` (any `server/` or `packages/` change does).

| # | Milestone | Effort | restarts-api | Pinning tests |
|---|---|---|---|---|
| M0 | **Bus on in production, still one machine.** LiveKit is already live in production (2026-09-05; the self-hosted server at `sfu.pqp.gg`). Set `CLUSTER_BUS=postgres` on prod (DATABASE_URL must be session-mode; the `direct.` MPG endpoint is). Soak one week watching `bus.*` log events. Update `docs/HANDOVER.md` phase 5 row. *Code half done (self-echo check, `voice.hello`); ops half pending.* | 0.5 day + soak | yes (secrets) | Existing `voice-transport.test.ts`, `admin.test.ts`, `cluster.test.ts`; confirm `revokeTokenTs` behaviour on Cloud and log it in `voice-backends.md` |
| M1 | **Voice registry, write-through.** Schema; `voice/registry.ts` module (rooms, peers, retired, instances heartbeat); `voice.ts` writes rows beside the local map when `VOICE_REGISTRY=postgres`; atomic transport pin; token endpoint accepts `resumeToken` and falls back to the row; moderation lookups fall back to rows; `getVoiceActivitySnapshot` from rows. *Landed 2026-09-06, flag off.* | 3-4 days | yes | New `voice-registry.test.ts` (Postgres-backed via `TEST_DATABASE_URL`): pin race (two concurrent inserts, one transport), unpin on last leave, retired-id blocks reconstruct; `api` test: token mint via HMAC proof on an instance with an empty map; `voice-state.test.ts` unchanged with flag off (byte-for-byte guarantee) |
| M2 | **Roster and room events over the bus.** `voice.room`, `voice.identity`, `voice.watch` topics; `broadcastRoster` from rows; `sendAllVoiceRosters` from rows; watch party columns. *Landed 2026-09-06, flag off.* | 2-3 days | yes | `voice-cluster.test.ts` (two module graphs, memory hub, shared `pqp_test`): join on A shows in roster fan-out on B; leave on A removes on B; state toggle and rename cross (`peer-updated`, both seats of one person); no republish; a socket authenticating on B is sent A's rooms; watch-party write on A reaches room peers on B, a mid-film joiner on B reads the row, a write that lost in the row is refused with the winner, a teardown crosses; with the bus off nothing crosses and the rows are still written; with the registry off no voice frame is published and no row is written |
| M3 | **Cross-instance resume and dead-instance reconcile.** `adopt` plan; instance heartbeat/lease; reconcile sweep (orphan by dead instance, delete after TTL, retire cleanup); `voice.room adopted` handling on the old owner. *Landed 2026-09-06, flag off.* | 2-3 days | yes | `voice-resume.test.ts` additions: resume on B for a peer owned by A (alive) adopts without `peer-left`; A marked dead by lease, peer orphaned, resume within 90 s reattaches, after 90 s removed with `peer-left` on B; retired id still refused on B |
| M4 | **Rings, moderation notices, SFU re-sweep claims.** `voice.call` fan-out and owner routing; `voice.moderation`; `voice_resweeps` claims ticker replacing `setInterval`. *Landed 2026-09-06, flag off.* | 2 days | yes | `voice-calls.test.ts`: callee on B rings, decline on B reaches owner on A, one missed-call message, `pushIncomingCall` called once; `voice-eviction.test.ts`: two instances tick, exactly one `listParticipants` per interval per key, claim survives "restart" (new module graph picks up the row) |
| M5 | **Deploy plumbing and mesh guard.** `fly.toml` (rolling, checks, min 2), drain flag + jittered close in `index.ts`, CI count == 2 assertion and dual-version probe, mesh refusal when >1 live instance, boot warning, `voice.hello` drift log; docs (`deploy-fly.md`, `CLAUDE.md` pitfall #11, `voice-backends.md` "What can still split a call"). Rehearse on staging with `fly scale count 2 -a pqp-api-staging` (temporarily disable staging auto-stop). *Landed 2026-09-06, flag off; staging rehearsal pending.* | 1-2 days | yes | `lib/drain.test.ts`: batched 1001 closes under fake timers, `/health` 503 on drain; `transport-policy.test.ts` and the "mesh guard (M5)" group of `voice-cluster.test.ts`: mesh join refused with two live instances, forced to the SFU when configured, holder keeps seating, drained instance not counted, one warning per episode; staging rehearsal checklist recorded in `docs/STAGING.md` |
| M6 | **Flip production to two machines.** `fly scale count 2 --region gru`, `VOICE_REGISTRY=postgres`, watch `bus.*` and `voice.*` log events and the admin dashboard for a week; then remove the `VOICE_REGISTRY` flag's `off` path in a follow-up. | 0.5 day + soak | yes | Playwright e2e (`client/e2e/voice-resume-deploy.spec.ts`): two browsers in a LiveKit channel against a local two-process rig (two `tsx` servers on different ports behind a tiny round-robin WS proxy in `client/e2e/fixtures`), kill one server, assert both stay `connected`, same peer ids, roster intact on both. If the rig proves too heavy, replace with a Node integration script in `server/scripts/` like the 2026-08-07 LiveKit verification rig and record results in `voice-backends.md` |

Total: ~12-16 working days. M0 and M5/M6 are the only ones with operational
steps outside git.

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `DATABASE_URL` points at a transaction-mode pooler; LISTEN silently never receives, instances split without error | low on MPG `direct.`, medium if anyone switches to the `pgbouncer.` host | Boot check: after `whenConnected()`, publish `voice.hello` and require our own echo within 5 s (Postgres self-delivers); fail `/health` if not. Already flagged in `.env.example`. *M1 ships the check as a loud log (`bus.selfEchoMissing`, `server/src/ws/voice-hello.ts`); failing `/health` waits for M5, when there is a sibling to fail over to.* |
| Bus down while two machines run: rosters diverge, rings do not cross | low | Media unaffected (LiveKit); registry rows are still written, so the periodic reconcile rebuilds rosters when the bus returns; `bus.*` log events already exist |
| Ghost seats after an instance dies | low (M3 landed) | Lease + reconcile in M3: orphaned at the dead lease's last heartbeat, removed 90 s later by whoever is alive |
| Two instances pin a room differently | low | Atomic insert; `voice.hello` config hash |
| Reconnect stampede on the surviving machine during a deploy | medium | Jittered batched 1001 closes; concurrency soft limit; client backoff jitter |
| Rate limits multiply by 2 | certain, accepted | Documented in `lib/rate-limit.ts`; revisit only if abuse appears |
| iOS/Android still drop voice on deploy | certain | Unchanged from today; a later plan adds resume tokens to the native clients |
| Missed-call record lost if the ring owner dies mid-ring | low | Accepted; push already sent |
| LiveKit Cloud cost creep past "Ship" included minutes | medium: every room is SFU today | Dashboard alert at 80% of 150k minutes; route small rooms to mesh (open question in 5.6); self-host per `docs/plans/SELF_HOSTED_LIVEKIT.md` |
| Postgres NOTIFY queue pressure | very low | Voice adds tens of frames/s at most; the transport's own ceiling note stands |

## 10. Rollback story, in one paragraph

Every step is flag-gated and additive. If anything misbehaves after M6: `fly
scale count 1 --region gru --app pqp-api` (seconds; the surviving machine keeps
all its sockets and the other machine's clients reconnect to it with resume), then
`fly secrets set VOICE_REGISTRY=off` if the registry itself is suspected (one more
restart). The schema stays; the rows are ignored and swept. The CI assertion
should read the expected count from a repo variable (`API_MACHINE_COUNT`) so a
rollback does not also break the next deploy.

## 11. Bugs found while reading (fix regardless of this plan)

- `POST /api/voice/token` uses the local peer map, so with two machines roughly
  half of mints would 403. Fix: accept the existing resume HMAC as proof.
- `scheduleResweep` timers die on deploy, so a ban inside the 15-minute window
  stops being enforced against a pre-ban token. The claims table fixes this.
- `sendToUserSockets` for rings is local-only, so a callee on another machine
  would never ring.
