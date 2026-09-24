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
- **Old clients keep rooms home.** A room is only moved off home when its first
  joiner declared the `sfu-region` capability on `auth`. Web and Electron
  declare it from this release. iOS and Android do not yet (see below), so a
  room a phone opens stays in São Paulo, and a phone that joins a room somebody
  else opened in Miami still works, because it dials the URL it is handed.
- **Moderation asks every box.** Kicks, bans, server mutes and publish-grant
  changes (`voice/admin.ts`) list the room on every configured box and act
  where the participant is. A banned account's LiveKit connection outlives its
  WebSocket, so the boxes themselves are the authority, not the pin.
- **Mesh rooms carry a region too**, so a mid-call promotion onto the SFU goes
  to the box decided when the room opened.

Decision order (`decideSfuRegion` in `server/src/voice/regions.ts`): single
region, conversation (home), watch party (home), first joiner without the cap
(home), operator override, the server's members (`server-majority`, or
`server-mixed` to the default), and only with too few known members the first
joiner's country through the map, then `LIVEKIT_REGION_DEFAULT`.

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
2. **A box is down:** remove its countries as above. Rooms already pinned
   there lose media; people rejoining after the room empties land at home.
   There is no automatic failover in v1: an unreachable region is reported
   (`/ready`, dashboard, status page) but not avoided.
3. **Turn regions off entirely:** first do step 1 and wait for the rooms
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
| iOS (`ios/pqp/Sources/Voice/LiveKitVoiceClient.swift`) | Yes, `room.connect(url: info.url, ...)`; ATS has no host restriction | No | A room it opens stays in São Paulo. It joins a Miami room correctly. |
| Android (`android/.../voice/LiveKitEngine.kt`) | Yes, `credentials.url`; release network config has no host pinning | No | Same as iOS. |

No shipped client hardcodes `sfu.pqp.gg` (checked: the only hits are comments
and tests). The `sfu-region` capability is caution rather than a known break:
it lets the server keep old builds exactly where they have always been.

**To opt the phones in** (one line each, ship with the next store build): add
`"sfu-region"` to the capability list each app sends in its WebSocket `auth`
frame, `RealtimeClient.wireCaps` in `ios/pqp/Sources/Core/RealtimeClient.swift`
and `WIRE_CAPS` in `android/app/src/main/kotlin/gg/pqp/app/core/RealtimeClient.kt`,
and update the handshake test beside each. Nothing else changes: both already
pass the token's `url` straight to `Room.connect`.

## Known limits (v1)

- **First joiner decides.** A Brazilian admin opening a European community's
  channel pins it home. The per-channel override is the workaround.
- **No automatic failover** from a dead region (roll back step 2).
- **A box that hangs slows moderation everywhere.** Moderation asks every box
  and waits for all of them, so an unreachable Miami box delays a server mute
  in a São Paulo room by the SDK's request timeout. Evictions are
  fire-and-forget and only log late. Removing the region from
  `LIVEKIT_REGIONS` ends it.
- **The public status page** counts a region that is down as a component that
  is down, which the page's overall state reflects.
- **The promotion budget** (`VOICE_PROMOTION_MAX_SFU_MBPS`) prices every room
  on every box together, so it over-counts for a remote room and errs towards
  refusing a promotion there. The reachability check does use the room's own
  box.
- **Monitoring** needs the new box added to the Grafana dashboards by hand
  (`SFU_BOX_NAME` gives it its own series; see
  `pqp-metrics-pipeline-manual-steps` in the operator notes).
