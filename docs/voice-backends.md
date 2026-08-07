# Voice backends (Phase 5)

pqp abstracts voice transport behind a media-path switch. The channel UX stays identical; only the media path changes.

**Presence is always the app WebSocket.** Roster, occupancy, join/leave and speaking rings ride `/ws` in every mode — the SFU replaces only the *media* transport (mic, and screen share when someone is presenting). That is why SFU participants use the WS-assigned `peerId` as their SFU identity: the roster lines up 1:1 with the mesh path.

## Choosing a backend

The **server** decides, via `GET /api/voice/backend`:

| Server env | Backend |
|---|---|
| `LIVEKIT_URL` + `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` | `livekit` |
| `CLOUDFLARE_REALTIME_APP_ID` | `cloudflare-sfu` (stub → mesh) |
| neither | `mesh` |

No client rebuild is needed to switch. `VITE_VOICE_BACKEND=mesh` is a build-time escape hatch that forces peer-to-peer even when an SFU is available.

If the SFU session cannot be established (token error, server unreachable), the client logs a warning and **falls back to mesh** rather than leaving the user with no audio. Read [Per-client fallback splits a call](#per-client-fallback-splits-a-call-verified) before treating that as harmless — it is a per-client decision made silently, and one client falling back while the others stay on the SFU is a call where nobody can hear that person.

## mesh (default)

- Full peer-to-peer WebRTC per voice channel
- Signaling over the existing WebSocket
- ~5–8 users per channel (`MESH_VOICE_LIMIT`)
- TURN for NAT traversal — see `/api/ice-servers`

## LiveKit — implemented

**When:** voice channels above the mesh ceiling; self-host or hosted.

**Config:**
```
LIVEKIT_URL=wss://livekit.yourdomain.com
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

**Local dev** — a LiveKit container ships in `docker-compose.yml` behind a profile:

```bash
docker compose --profile livekit up -d
```

Then in `.env` (dev credentials from `--dev` mode, do not use publicly):

```
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

Restart the server and join a voice channel — the "mesh limit" warning disappears once media is on the SFU.

The compose service publishes **7880/tcp (signal), 7881/tcp (ICE over TCP) and 7882/udp (media)** — the ports `--dev` actually binds. If you change the LiveKit config, check the container's startup line (`"rtc.portTCP": 7881, "rtc.portUDP": {"Start":7882}`) rather than assuming a port range.

**How it works:**

1. Client joins the voice room over `/ws` and receives `welcome` with its `peerId`.
2. Client `POST /api/voice/token` `{ voiceChannelId, peerId }`.
3. Server verifies the peer is live, owned by the caller, and in that channel, then mints a LiveKit JWT (room = channel id, identity = `peerId`, metadata = `{ userId }`, 15 min TTL, publish/subscribe — covers mic and screen-share video alike).
4. Client connects to LiveKit and publishes the processed mic track; remote audio tracks are mapped back onto the same `RemotePeer[]` the mesh path produces. A screen share publishes a second track tagged `Track.Source.ScreenShare`, subscribed separately into `RemotePeer.screenStream`.

`livekit-client` is loaded via dynamic `import()`, so mesh deployments never download it (it is emitted as a separate ~530 kB chunk).

**Security:** the token endpoint refuses any `peerId` that is not a live voice peer belonging to the requesting user in the requested channel, so a caller cannot mint a token impersonating another participant.

### Moderation must reach the SFU (`server/src/voice/admin.ts`)

Mesh eviction drops a peer from the signaling map, which makes the other clients tear down their connections to it. With an SFU the media never touches the app server, so that alone does **nothing** to the call — a kicked or banned account stays in the LiveKit room and keeps talking. Mesh and SFU must never disagree about who belongs in a call.

Every mesh eviction in `server/src/ws/voice.ts` therefore fires an SFU eviction beside it:

| Trigger | Helper | SFU action |
|---|---|---|
| kick / ban, server leave, private-channel member removed | `evictVoiceUser` | remove that user's participants from the scoped rooms |
| channel deleted, server deleted | `evictVoiceChannel` | remove every participant of the room |
| channel turned private | `evictVoiceUsersExcept` | remove everyone not still on the access list |

Four properties this depends on:

- **The token carries `{ userId, mintedAt }` in participant metadata.** The LiveKit identity is a per-join `peerId`, so without `userId` a ban could not name a participant whose peer id the acting instance never issued — i.e. anyone connected through another instance. `mintedAt` is what lets a repeat sweep (below) tell "still riding the token they were evicted on" apart from "has since been unbanned and re-authorised", so an unban inside the token TTL does not turn into a boot loop.
- **Removal asks for the token to be revoked** (`revokeTokenTs`) — and that is **LiveKit Cloud only**. See below; it is not what makes eviction stick on a self-hosted server.
- **The room is re-swept for the token's lifetime.** `removeParticipant` disconnects but does not bar a return, so `scheduleResweep` repeats the removal every 5s for `TOKEN_TTL_SECONDS` (15 min), after which any pre-eviction token has expired on its own. Only participants whose `mintedAt` predates the eviction are touched.
- **It is a no-op without LiveKit config, and it never throws.** A mesh-only deployment makes no network call at all, and an unreachable SFU logs `[pqp] voice.sfuEvictFailed` rather than failing the moderation request — the ban is committed before the eviction runs and can never be unwound by it.

#### `revokeTokenTs` does nothing on a self-hosted LiveKit (verified)

Measured against `livekit/livekit-server:latest` (v1.13.5, `--dev`), with two real browser participants in a live room:

```
>>> POST /api/servers/:id/bans { userId: bob }
LiveKit participants AFTER ban: [ { identity: '5c37c111-…' } ]        # bob removed
>>> bob re-connects using the SAME token minted before the ban
rejoin error: (none — connect resolved)
LiveKit participants AFTER rejoin attempt: [ '5c37c111-…', '247e8651-…' ]   # bob is back
```

The server-side log shows the RPC carrying the field and being accepted:

```
livekit.psrpc.Participant.RemoveParticipant  client response
  {"request": {"room": "254e2ae1-…", "identity": "247e8651-…", "revokeTokenTs": 1786112470}, "response": {}}
API RoomService.RemoveParticipant … "status": "200"
```

Reproduced with LiveKit's own SDK and a hand-minted token, with no pqp code in the path, and with `revokeTokenTs` set an hour in the future: still readmitted. LiveKit's reference documents the field as "LiveKit Cloud only", and Cloud additionally revokes the current token on `RemoveParticipant` without being asked.

So: **on LiveKit Cloud one removal is enough. On a self-hosted LiveKit the re-sweep is the only thing keeping a banned account out**, and without it "banned" meant "disconnected once, free to reconnect for the next fifteen minutes". Verified fixed — after the re-sweep landed, the same test shows the rejoined participant ejected again within ~1s and the remaining participant no longer subscribed to them.

Not covered: closing a group conversation (`DELETE /api/dms/:channelId`) and blocking a user do not evict voice on **either** path today.

## Per-client fallback splits a call (verified)

`use-voice.ts` picks its media transport **per client, once per join, and tells nobody**. There is no field in the WS protocol that says which transport a peer is using, and no UI that compares. So two people in the same channel can be on different transports, and then:

- The mesh client sends `offer` / `ice-candidate` frames to the SFU client. The server relays them faithfully. The SFU client's `manager` is `null`, so `manager?.handleOffer(…)` is a no-op — the offer is dropped without a trace.
- The SFU client never appears in the mesh client's `remotePeers` as connected; the peer sits in `connecting`, then `failed` (a Retry button appears, and retrying cannot help).
- The mesh client never appears in the SFU client's `remotePeers` **at all** — `livekit-session.ts` builds that list from LiveKit room participants, and the mesh client is not one. The voice panel lists `remotePeers`, so the person is simply absent from the call; only the channel sidebar's occupancy roster (which comes from `/ws`) still shows them present.

Net effect: one participant is in the call, listed in the sidebar, silent, and indistinguishable from someone who is muted. Nobody is shown an error. The `SFU` badge in the status bar is the only tell, and it is only rendered when you are *not* looking at the voice channel.

Ways this actually fires on a single instance:

| Trigger | Who ends up on mesh |
|---|---|
| `GET /api/voice/backend` fails during bootstrap (blip, deploy) | that tab, for its whole life — the catch in `App.tsx` leaves the mesh path silently |
| LiveKit reachable from the API but not from one user's network (corporate firewall, blocked UDP+TCP) | that user only |
| `POST /api/voice/token` 502/503 for one caller | that user, that join |
| `VITE_VOICE_BACKEND=mesh` in a build | everyone using that build (the local `client/.env` sets this; CI does not) |

Measured fallback latency: a **refused** connection falls back in ~0.1s; a **black-holed** LiveKit host (the realistic cloud failure) takes **15.1s**, during which the UI says "Voice connected" and no audio flows in either direction.

Not fixed here. The minimum honest fix is for the client to report its transport on join and for the server to refuse — or at least surface — a mixed room.

## Screen share on the SFU (verified)

Publish/subscribe works: `publishScreen` tags the track `Track.Source.ScreenShare`, the far side subscribes it into `RemotePeer.screenStream`, and `unpublishScreen` clears it. Verified with two browsers against a live LiveKit.

The one-presenter lock is enforced in `ws/voice.ts` on the `set-sharing-screen` frame, so it is transport-independent and it does work: a second claimant gets `screen-share-denied` and the roster keeps naming the first presenter. Two caveats, both verified:

- **The lock binds the roster, not the media.** A client that publishes a `ScreenShare` track without announcing it is not stopped by anything — LiveKit has no such rule and the server cannot see the track. Every other participant subscribes and decodes it. It is never *rendered*, because `ScreenShareView` is driven by `screenSharePeerId` from the roster, so this is a bandwidth-grief vector rather than a way to hijack the presenter slot.
- **The honest client publishes before it is answered.** `startScreenShare()` sends `set-sharing-screen` and publishes to the SFU without waiting; on a denial, `screen-share-denied` arrives a round trip later and unpublishes. In the simultaneous-click race a second screen track is briefly live on the SFU.

## Cloudflare Realtime SFU — still a stub

**Status:** `createCloudflareSfuSession()` throws; deployments fall back to mesh.

Cloudflare Realtime uses a bespoke track push/pull HTTP API rather than a room-join SDK, so it needs its own adapter — it is not a drop-in for the LiveKit path.

**Config (unused today):**
```
CLOUDFLARE_REALTIME_APP_ID=...
CLOUDFLARE_REALTIME_APP_SECRET=...
```

## Implementation checklist

- [x] LiveKit token endpoint on server (`POST /api/voice/token`)
- [x] LiveKit client SDK integration (`client/src/lib/livekit-session.ts`)
- [x] Compose recipe with LiveKit container (`--profile livekit`)
- [x] Backend advertised to client (`GET /api/voice/backend`)
- [ ] Cloudflare Realtime session API on server
- [ ] Client SFU join/leave using Cloudflare's track API

## Running LiveKit in production

Nothing below has been deployed; it is the shape of the decision, priced.

**What a deploy needs.** Three values on the Fly app (`fly secrets set`, not `[env]` — two of them are credentials): `LIVEKIT_URL` (`wss://…`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`. Nothing changes on Cloudflare Pages — the client learns the backend from `GET /api/voice/backend` at runtime, and CI does not set `VITE_VOICE_BACKEND`. Do **not** copy `client/.env`'s `VITE_VOICE_BACKEND=mesh` into the build; it forces mesh for everyone.

**Option A — LiveKit Cloud.** Free "Build" tier: 5,000 WebRTC connection-minutes/month and 50 GB egress, no card. 5,000 participant-minutes is roughly *four people talking for 20 hours a month, in total* — enough to validate, not enough to run on. Next tier ("Ship") is $50/mo including 150,000 minutes, then $0.0005/participant-minute and $0.12/GB downstream. Cloud is also the only place `revokeTokenTs` works, so moderation costs one RPC instead of fifteen minutes of re-sweeping.

**Region.** LiveKit Cloud lists **Brazil** among its regions and routes participants to the nearest edge automatically, so a São Paulo audience is served from Brazil rather than from `us-east`. Confirm the project's region in the Cloud dashboard before committing — the docs describe the region list as service-wide, not per-plan, but the mapping is not contractual.

**Option B — self-host on Fly.** A second Fly app in `gru`, ~$5–10/mo for a `shared-cpu-1x`/1GB machine plus egress. Two things make this harder than it looks: LiveKit wants a UDP media port reachable from the internet, and Fly only forwards UDP on ports declared in `fly.toml` and bound to the `fly-global-services` address — so LiveKit has to be pinned to a single UDP mux port (`rtc.udp_port`) rather than a range, with TCP 7881 as the ICE fallback. It also needs its own TLS hostname for `wss://`. Cheaper per minute; it is a second piece of infrastructure to operate, and it inherits the `revokeTokenTs` gap above.

**If LiveKit is configured but unreachable** (verified against a server pointed at a dead port):

| Surface | Behaviour |
|---|---|
| `GET /api/voice/backend` | still answers `livekit` — it checks env, not reachability |
| `POST /api/voice/token` | **200 in 4ms**. Minting is local; it never talks to LiveKit, so a token is issued for an SFU that is not there |
| Client join | `connectLiveKit` rejects, the client falls back to mesh. **~0.1s** if the port refuses, **15.1s** if the host black-holes — 15s of "Voice connected" with no audio |
| Moderation | ban still returns **200 in 16ms**; the eviction logs `[pqp] voice.sfuEvictFailed … stage=listRooms error=fetch failed` and does not block the request |

So it fails *soft*, into mesh — which also means it fails into the per-client split described above, and into the 8-peer mesh cap that the SFU was there to lift. It never hangs the API.

## Verification status

Verified end-to-end on 2026-08-07 against `livekit/livekit-server:latest` (v1.13.5, `--dev`) via the compose profile, driving `client/src/lib/livekit-session.ts` in two headless Chromium instances with fake media devices, against the real server, real Postgres and real `/ws`:

| Claim | Status |
|---|---|
| `GET /api/voice/backend` advertises `livekit` | verified |
| Token grants / identity / metadata / 15-min TTL | verified (decoded) |
| Two participants join the room and exchange audio | verified — peak RMS ~0.31 in **both** directions |
| `setMuted` silences the far side and unmute restores it | verified (RMS 0 → 0.30) |
| Screen share publish/subscribe/unpublish | verified |
| One-presenter lock (roster) | verified; **media layer is not locked** — see above |
| Ban ejects from the live room | verified |
| Ban survives a rejoin on the pre-ban token | **was broken**, now verified fixed via re-sweep (`revokeTokenTs` is Cloud-only) |
| Banned user cannot mint a fresh token / re-enter over `/ws` | verified (403, no `welcome`) |
| `MESH_VOICE_LIMIT` does not apply with the SFU active | verified — 12 peers joined and all 12 minted tokens; the same 12 against a mesh-only server were cut off at 8 |
| Server switched to mesh under a client that expects an SFU | verified — token request answers a clean 503 and the client falls back |
| LiveKit configured but unreachable | verified — see the table above |

Not verified, and knowingly so:

- **Against LiveKit Cloud.** Everything above is a self-hosted `--dev` server. In particular the `revokeTokenTs` behaviour is expected to differ (that is the point), and the re-sweep has not been observed against Cloud.
- **Server switched to LiveKit under a client already running on mesh.** Reasoned through, not executed: that client keeps no `sessionProvider`, so it stays on mesh and produces exactly the split documented above.
- **Scale.** Two to twelve participants, one room, one machine, all on localhost. No claim is made about a busy channel, cross-NAT paths, or TURN interaction on the SFU path.
- **Real `getDisplayMedia`.** Headless Chromium cannot open the OS picker, so screen share was driven from a canvas capture. The publish/subscribe path is repo code and is verified; the capture call itself is browser API and is not.
