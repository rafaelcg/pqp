# SFU regions: runbook

How to add a LiveKit box outside São Paulo (Miami first, London second), turn
routing on for a list of countries, and roll it back. The code ships dark: with
`LIVEKIT_REGIONS` unset every room goes to `sfu.pqp.gg` exactly as before.

Background and the latency numbers behind this: `~/.config/pqp/international/EDGE.md`
(operator notes, not in git). The short version: a room on the SFU is a star
around one box, so two people in Europe in a large-server room hear each other
through São Paulo, about 240 ms one way. A box near them fixes it, as long as
the whole room is on that box.

## How it works

- **A room's region is pinned at first join**, beside its transport pin, and
  never changes while anybody is in the room (`voice_rooms.sfu_region` with
  `VOICE_REGISTRY=postgres`, which production runs; an in-process map always).
  Everybody in the room is sent to that box. LiveKit single nodes do not relay
  to each other, so there is no other correct answer.
- **The signal is where the server's people are** (since 2026-09-24). Every
  account's last seen country (two letters, never an IP) is recorded at WS
  auth, throttled to once per 6 h unless it changes. A room opens on the
  region that at least 60% of its server's members seen in the last 30 days
  map to, given at least 5 of them; with 5 or more but no such majority it
  opens on `LIVEKIT_REGION_DEFAULT` (home unless set). Only a server with
  fewer than 5 known members falls back to the first joiner's
  `CF-IPCountry`, which is how it worked before: one visitor from London
  first into a Brazilian server's channel used to move the whole call to
  London. See `server/src/voice/region-audience.ts`.
- **The country comes from `CF-IPCountry`**, captured from the
  WebSocket upgrade. Cloudflare adds it on every proxied request; Caddy passes
  it through unchanged (verified locally against the `(upstreams)` snippet of
  `tools/api-host/Caddyfile`, on plain HTTP and on the `/ws` upgrade).
- **The token says where to go.** `POST /api/voice/token` signs the token with
  the room's box's own key pair and returns that box's `url` (plus an
  informational `region` field, only when regions are on). Every client dials
  `url` and nothing else.
- **The API replicas agree** because the region is claimed in the same
  `INSERT ... ON CONFLICT` as the transport: the second replica adopts the
  stored region instead of deciding its own. A token minted on the replica
  that never saw the join reads the row.
- **Resume keeps the box.** The resume token carries the region (`r`, only
  when regions are on); a resume after an API restart re-pins from the row, or
  from the token when the registry is off. A resume whose LiveKit media is on
  a different box than the room is pinned to becomes a cold join, never a
  split call.
- **Watch parties stay in São Paulo.** Egress and remux only talk to the home
  box, so a `watch_party` channel is always pinned home, ahead of the operator
  override, and `pushLiveHls` refuses (and logs `voice.hlsRefusedRemoteRegion`)
  for any room that got elsewhere anyway.
- **Every client is trusted to follow the URL** (since 2026-09-24). A room a
  phone opens follows the same policy as one a browser opens, with no app
  update, because every build of every client dials the `url` the server
  answers (see "Clients" below). `LIVEKIT_REGION_REQUIRE_CAP=true` is the
  rollback: a room is then only moved off home when its first joiner declared
  the `sfu-region` capability on `auth` (`reason=old-client` otherwise).
- **Moderation asks the room's box, and every box only when it cannot know.**
  Kicks, bans, server mutes and publish-grant changes (`voice/admin.ts`) go to
  the box the room is pinned to (this process's pin, the `voice_rooms` row, or
  a hint captured when the eviction started) and nowhere else. When no pin is
  known, which is real because a banned account's LiveKit connection outlives
  its WebSocket and the pin with it, every box is asked, in parallel and
  independently, under a budget and a circuit. See "The control plane" below.
- **Mesh rooms carry a region too**, so a mid-call promotion onto the SFU goes
  to the box decided when the room opened.

Decision order (`decideSfuRegion` in `server/src/voice/regions.ts`): single
region, conversation (home), watch party (home), first joiner without the cap
(home, only with `LIVEKIT_REGION_REQUIRE_CAP=true`), operator override, the
server's members (`server-majority`, or `server-mixed` to the default), and
only with too few known members the first joiner's country through the map,
then `LIVEKIT_REGION_DEFAULT`.

## Configuration

All on the API box, in `/opt/pqp/.env` (both replicas read the same file). Read
at call time; a rolling restart applies a change.

| Variable | Meaning |
|---|---|
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | The home box, unchanged. Watch parties, egress and remux use only this. |
| `LIVEKIT_HOME_REGION` | The home region's id. Default `sao`. |
| `LIVEKIT_REGIONS` | `mia:wss://sfu-mia.pqp.gg,lon:wss://sfu-lon.pqp.gg`. The other boxes. An entry for the home id is ignored (home is always `LIVEKIT_URL`). **Unset is today's single-region behaviour.** |
| `LIVEKIT_API_KEY_<ID>` / `LIVEKIT_API_SECRET_<ID>` | That box's own key pair (`_MIA`, `_LON`). Falls back to the home pair when unset. |
| `LIVEKIT_REGION_COUNTRIES` | `US:mia,CA:mia,MX:mia,GB:lon,IE:lon`. ISO country to region. **This is the switch that routes people.** Regions configured with no country map route nobody anywhere new. |
| `LIVEKIT_REGION_DEFAULT` | Where unlisted countries (and requests with no country) go. Default: home. |
| `LIVEKIT_REGION_REQUIRE_CAP` | Default off: every client may open a room off home. `true` is the rollback to the old caution, where only a first joiner that declared `sfu-region` can. |

**Key pairs: one per box (decided).** `tools/sfu/install.sh` generates a pair
when none is given, and a separate pair means a leaked Miami key cannot mint a
token for a São Paulo room. The shared-pair fallback exists so a box installed
with the home pair still works, not as the recommendation.

**Operator override.** The dashboard's controles tab (per channel, "região")
or `PUT /api/admin/channel-sfu-region { channelId, region | null }` sets
`channels.sfu_region`. Like the transport override it applies to the next room
that opens, never to a live one. Refused for a `watch_party` channel (always
home) and for a region the deployment does not run. Audited as
`channel.sfu_region_update`.

## Add a region

Miami as the example; London is the same with `lon`.

1. **Box.** Vultr High Performance AMD, 2 vCPU / 4 GB (4 vCPU / 8 GB if it will
   carry watch-party-sized rooms), region Miami, Ubuntu 24.04. Same shape as
   `sfu-pqp`; `tools/sfu/README.md` has the reasoning. Verify the price at
   checkout.
2. **DNS** (Cloudflare, **grey cloud**, never proxied: media is UDP and TURN
   terminates TLS on the box):
   - `sfu-mia.pqp.gg` A to the new IP
   - `turn-mia.pqp.gg` A to the new IP
3. **Install**, from a laptop in the repo:
   ```bash
   scp -r tools/sfu tools/sfu-monitoring root@<new-ip>:/opt/
   ssh root@<new-ip> 'SFU_DOMAIN=sfu-mia.pqp.gg TURN_DOMAIN=turn-mia.pqp.gg \
     SFU_BOX_NAME=sfu-mia \
     GC_PROM_USER=3563744 GC_PROM_TOKEN=<metrics:write token> \
     bash /opt/sfu/install.sh'
   ```
   With no `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` given, the installer
   generates a pair and prints it once: that is the pair for step 4. Keep it
   out of git and out of chat. `SFU_BOX_NAME` keeps this box's Grafana series
   (`instance`, `box`) off São Paulo's; leaving it unset would overwrite them.
   Check: `curl -sI https://sfu-mia.pqp.gg/` answers, and the installer's last
   lines print 200s for both hostnames.
4. **API config, staged dark.** In `/opt/pqp/.env` on the API box:
   ```
   LIVEKIT_REGIONS=mia:wss://sfu-mia.pqp.gg
   LIVEKIT_API_KEY_MIA=<from step 3>
   LIVEKIT_API_SECRET_MIA=<from step 3>
   ```
   No `LIVEKIT_REGION_COUNTRIES` yet. Apply with a rolling restart in the
   trough, never while a watch party is live (this is a `restarts-api` event,
   CLAUDE.md pitfall 11). Prefer re-running the Vultr deploy workflow for the
   sha already deployed, which pins the image and rolls `api-a`, then `api-b`,
   then `worker`. If it has to be by hand: pin `APP_IMAGE_TAG` to the deployed
   sha and recreate one replica at a time, waiting for `healthy`.
5. **Verify, still routing nobody:**
   - `GET /ready` has `checks.livekitRegions.mia` with `ok: true` and
     `host: "sfu-mia.pqp.gg"`. A region being down never turns the top-level
     `ok` false (the deploy gates on it); monitors should watch the region key.
   - Dashboard, voz / sfu, "regiões do sfu": `mia` is "no ar", and the
     country-header line shows most connections arriving **with** a country.
     If it says zero, Cloudflare's IP Geolocation is off for the zone
     (Network settings) or something is stripping the header; fix that before
     step 6, or everybody lands on the default.
   - `/status.json` lists a `voice-mia` component.
   - Force one test room there: set the override on a test voice channel to
     `mia`, join from a browser that has reloaded onto this release, confirm
     the token's `url` is `wss://sfu-mia.pqp.gg` (network panel, `POST
     /api/voice/token`) and that two people hear each other. Clear the
     override.
6. **Route countries.** Add to `/opt/pqp/.env` and roll the replicas again:
   ```
   LIVEKIT_REGION_COUNTRIES=US:mia,CA:mia,MX:mia,CO:mia
   ```
   Start with the countries that are clearly closer to Miami than to São
   Paulo. Do not route AR, CL, UY, PY or BR: São Paulo is nearer for them.
7. **Watch.** `voice.regionPinned` in the logs (region, reason, country) and
   the dashboard's pinned-rooms-per-region count. `voice.regionAdopted` is the
   second replica adopting a pin, expected and harmless.

## Roll back

Fastest first. None needs a code deploy; each is an `.env` edit plus a rolling
restart, and rooms already open stay on the box they are on until they empty.

1. **Stop routing a country** (or all of them): remove it from
   `LIVEKIT_REGION_COUNTRIES` (or unset the variable). New rooms go home.
2. **A phone build turns out not to follow the URL** (a room it opened off
   home, with its own media on the wrong box): set
   `LIVEKIT_REGION_REQUIRE_CAP=true`. Rooms opened by a client that did not
   declare `sfu-region` (every iOS build up to 1.0 (103101), every Android
   APK before this change) go home again, with `reason=old-client` on
   `voice.regionPinned`; web, Electron and the phone builds that declare the
   cap keep routing. Read on every decision, so the rolling restart that
   picks up the `.env` edit is all it takes.
3. **A box is down:** remove its countries as above. Rooms already pinned
   there lose media; people rejoining after the room empties land at home.
   There is no automatic failover in v1: an unreachable region is reported
   (`/ready`, dashboard, status page) but not avoided.
4. **Turn regions off entirely:** first do step 1 and wait for the rooms
   pinned outside home to empty (dashboard, pinned rooms per region, or
   `SELECT sfu_region, COUNT(*) FROM voice_rooms GROUP BY 1` read-only). Only
   then unset `LIVEKIT_REGIONS`: while it is unset the API has no credentials
   for the other boxes, so a member who reconnects to a still-open Miami room
   would be handed a token for an empty room of the same name at home. Then
   everything is single-region again, byte for byte: no column written, no region field in
   any response, no region claim in resume tokens. Rows with a stored
   `sfu_region` read as home once the flag is off.

## Clients

| Client | Dials the server's `url`? | Declares `sfu-region`? | What it does today |
|---|---|---|---|
| Web (`client/src/lib/livekit-session.ts`) | Yes, `room.connect(session.url, ...)` | Yes, from this release | Opens rooms in its region; joins any room anywhere. |
| Electron | Loads the web client | Yes, when the bundle reloads | Same as web. No host allowlist in the shell. |
| iOS (`ios/pqp/Sources/Voice/LiveKitVoiceClient.swift`) | Yes, `room.connect(url: info.url, ...)`; ATS has no host restriction | From the build after 1.0 (103101); not needed | Opens rooms by the policy, like web. |
| Android (`android/.../voice/LiveKitEngine.kt`) | Yes, `credentials.url`; release network config has no host pinning | From the next APK; not needed | Same as iOS. |

**Audit, 2026-09-24**, over the whole git history of `ios/` and `android/`
since LiveKit support landed (#243 iOS, #248 Android) and of the web session:
every version of every client passes the `url` of a `POST /api/voice/token`
answer straight to `Room.connect` (iOS `room.connect(url: info.url, ...)`,
unchanged since #243; Android `created.connect(credentials.url, ...)`,
unchanged since #248; web `room.connect(session.url, ...)`). The token is
minted fresh for every connect: iOS on every `connectSfu` (first join, a
mid-call promotion, a cold rejoin after a refused resume), Android inside
every attempt of `connectWithRetries`, presenting the resume token so a mint
on the other replica works. `GET /api/voice/backend` is read only for its
`backend` field (whether to declare `resume`), never for a host, and no
client ever hardcoded `sfu.pqp.gg` or a region host (only comments and
tests). A resume keeps the LiveKit connection it already has to the box the
room is pinned to; a resume the server turns into a cold join mints a new
token, whose `url` is the room's box. LiveKit's own reconnects reuse the URL
they were given, which is the pinned box for the room's whole life. That is
why the cap gate is off by default: it protected against a break no build
has.

## The control plane: calls from the API to each box

`voice.sfuRegionCallFailed` fired 872 times between 2026-09-24 and 10-03:
468 London, 403 Miami, 1 São Paulo, all timeouts but one, 764 of them on the afternoon
of 10-02, none while an API instance was busy (about 2.5% CPU) or a box was
(14 of 754 rooms between the two). The boxes were not overloaded. The
defect was in the shape of the call:

- **Every call went to every box and waited for the slowest.** A re-sweep runs
  every ~5 s for 15 minutes after each eviction (a kick, a ban, a deleted
  channel, a channel made private), and each pass listed the room on São Paulo,
  Miami and London. Nearly every room is in São Paulo, so nearly every call to
  Miami and London was for nothing, and each one is a cold request over a long
  path (DNS, TCP, TLS and the request: about four round trips; `fetch`'s
  default keep-alive is 4 s, so a box not called in the last 4 s is cold). The failures were independent per call (in
  about half the sweeps only one of the two remote regions failed), clustered
  in a few windows, and never touched the home box: a heavy tail on a path most
  rooms never needed, which then set the pace for every moderation call.
- **Real moderation on real rooms was never the victim**: all 24 successful
  kicks, mutes and grants since 09-26 completed with no regional failure within
  a minute. The cost was the volume of speculative calls and that each one
  could hold up its caller for the SDK's full 5 s.

What changed (`voice/sfu-control-plane.ts`, `voice/admin.ts`):

1. **Routing.** A call about a room goes to the box that room is pinned to.
   Known means: this process's pin, the `voice_rooms.sfu_region` row (so the
   other instance's rooms count, read with a 500 ms bound that falls back to
   every box), and a `regions` hint stamped into the re-sweep when the
   eviction started, all unioned (the registry row is gone by the second tick,
   because the eviction itself empties the room). A pin says where the room is
   NOW, not where somebody holding a token minted before the eviction still is:
   a participant whose WebSocket dropped keeps their LiveKit connection after
   the room's pin and row go, and the room can be reopened on another box. So
   the **first pass of every eviction asks every box** (known boxes as pinned,
   the rest as one-shots), and a repeat does the same in a five-second window
   of every thirty seconds, under the budget and circuit. The other repeats
   (the volume behind the 872 timeouts) stay on the known boxes. The worst case
   for a person on a box the room is not pinned to is the first pass if that box
   answered it; otherwise the next wide repeat, which is at most about 30 s
   later, and up to about a minute if that box's circuit was open (30 s
   cooldown); a token replayed onto an old box later in the window is caught by
   the next wide repeat (about 30 s). A region id the deployment no
   longer runs reads as home. No pin and no hint, or `rooms === null` ("wherever
   they are"): every box, as before, because "no pin" must mean ask more boxes,
   never fewer.
2. **Independence.** Each box runs its own sweep, in parallel. São Paulo is
   done when São Paulo answers; a slow box delays only its own share. An
   awaited call (a server mute) returns when the slowest box it asked is done,
   which for a known room is the one box.
3. **A budget** for the repeats of a sweep on a remote box whose room is not
   known: four times that box's measured p99 (over its last 200 answers, floor
   1.5 s, ceiling the SDK's 5 s), 3 s until it has 30 answers. Never for a
   write, a call to the box a room is known to be on, the home box, or a call
   nothing will repeat (a moderator's mute or grant, the first pass of an
   eviction), which keep the SDK's full 5 s: cutting those short would be a
   change that is not applied.
4. **A circuit per region**, per process: three consecutive failures skip
   those repeats (*reads* only) of that region for 30 s, then one probe. The
   skip is reported once as `voice.sfuRegionPartial` (answered / skipped /
   failed). A pinned call, a write and a one-shot are never skipped. It is per process because what it measures is
   this process's path to the box; the sibling has its own, and every sweep is
   repeated within seconds, so the other instance or the next pass covers it.
5. **It says why.** `voice.sfuRegionCallFailed` now carries `stage` (the call),
   `caller` (`sweep-room`, `sweep-private`, `sweep-user`, `mute`,
   `publish-grant`, `probe`), `mode` (pinned or speculative), `errorClass`
   (timeout, budget, dns, connect-timeout, refused, reset, http-4xx, http-5xx,
   other), `durationMs` against `budgetMs`, `idleMs` since that region's last
   call (a cold connection looks like a large idle time) and
   `consecutiveFailures`, rate limited to one line per region per ten seconds
   with `suppressed=N`. The circuit logs `voice.sfuRegionCircuit state=open|closed`.
6. **Counters**, per process: `sfuRegions.controlPlane.<region>` on
   `GET /api/admin/metrics` has `calls`, `failures`, `failuresByClass`,
   `skippedByCircuit`, `circuitOpen`, `p50Ms`/`p95Ms`/`p99Ms`, `budgetMs`,
   `lastFailureClass` and `sinceLastOkMs`. Read each instance, not the sum.

Not changed: the SDK calls the global `fetch` and takes no dispatcher, so the
connection lifetime is the runtime's default (4 s keep-alive) and cannot be
sized per region without replacing the process-wide dispatcher. Fewer calls to
the remote boxes is the lever instead, and `idleMs` on the failure line is how
a cold-connection cause would show itself if one remains. What the logs could
not say, because success was never logged and durations were not recorded, is
whether the tail is DNS, a lossy long-haul path or the boxes; the new line and
counters exist to answer that.

**Runtime flag `sfu_region_scoped_calls`** (default on; dashboard, or
`SFU_REGION_SCOPED_CALLS=off`): off restores asking every box, no budget, no
circuit. Measurement and the failure line stay on either way.

Tests: `server/src/voice/sfu-control-plane.test.ts` (budget, circuit, the line,
the counters), `admin-region-scoping.test.ts` (a dead region does not delay a
São Paulo room; the flag-off case is the "before"), `admin-region-pins.test.ts`
(the registry row, on a real Postgres).

## Known limits (v1)

- **First joiner decides.** A Brazilian admin opening a European community's
  channel pins it home. The per-channel override is the workaround.
- **No automatic failover** from a dead region (roll back step 3).
- **A box that hangs no longer slows moderation of other boxes' rooms** (fixed
  2026-10-03, see "The control plane"). A room whose box is unknown is still
  asked everywhere, so a hanging box can still delay *that* one call (a
  moderator's mute) by the SDK's 5 s. The repeats of a sweep are budgeted and
  fenced, which is where the volume was.
- **The public status page** counts a region that is down as a component that
  is down, which the page's overall state reflects.
- **The promotion budget** (`VOICE_PROMOTION_MAX_SFU_MBPS`) prices every room
  on every box together, so it over-counts for a remote room and errs towards
  refusing a promotion there. The reachability check does use the room's own
  box.
- **Monitoring** needs the new box added to the Grafana dashboards by hand
  (`SFU_BOX_NAME` gives it its own series; see
  `pqp-metrics-pipeline-manual-steps` in the operator notes).
