# Voice backends (Phase 5)

pqp abstracts voice transport behind a media-path switch. The channel UX stays identical; only the media path changes.

**Presence is always the app WebSocket.** Roster, occupancy, join/leave and speaking rings ride `/ws` in every mode — the SFU replaces only the *media* transport (mic, and screen share when someone is presenting). That is why SFU participants use the WS-assigned `peerId` as their SFU identity: the roster lines up 1:1 with the mesh path.

## Choosing a backend

The **server** decides, from its own env:

| Server env | Backend |
|---|---|
| `LIVEKIT_URL` + `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` | `livekit` |
| `CLOUDFLARE_REALTIME_APP_ID` | `cloudflare-sfu` (stub → mesh) |
| neither | `mesh` |

No client rebuild is needed to switch. `VITE_VOICE_BACKEND=mesh` is a build-time escape hatch that makes a build mesh-only — which, on an SFU deployment, now means it is *refused* from voice channels rather than silently split off from them. See [One room, one transport](#one-room-one-transport-fixed).

`GET /api/voice/backend` still reports the deployment-wide value, but it is no longer what decides a call: the room's transport arrives with the join.

## mesh (small rooms, and the fallback when `LIVEKIT_*` is unset)

- Full peer-to-peer WebRTC per voice channel
- Signaling over the existing WebSocket
- 8 users per channel, exactly (`MESH_VOICE_LIMIT`); the UI warns from 6
- TURN for NAT traversal — see `/api/ice-servers`
- On a deployment that **has** LiveKit, this is what DM calls and servers under
  `LARGE_SERVER_MEMBER_THRESHOLD` (10) members get. It is no longer what a
  crowded room gets. See [Which transport a room gets](#choosing-a-backend) and
  `server/src/voice/transport-policy.ts`.

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

If the browser connects to the signal socket and then logs `could not establish pc connection`, LiveKit is advertising the container's own IP (`"nodeIP": "172.x.x.x"` in its startup line), which Docker Desktop on macOS does not route. Run it with `--node-ip <your LAN IP>` (seen 2026-09-06; `docker run ... livekit/livekit-server --dev --bind 0.0.0.0 --node-ip 192.168.x.x` with the same three port mappings works).

**How it works:**

1. Client joins the voice room over `/ws` and receives `welcome` with its `peerId`.
2. Client `POST /api/voice/token` `{ voiceChannelId, peerId }`.
3. Server verifies the peer is live, owned by the caller, and in that channel, then mints a LiveKit JWT (room = channel id, identity = `peerId`, metadata = `{ userId }`, 15 min TTL, publish/subscribe — covers mic and screen-share video alike).
4. Client connects to LiveKit and publishes the processed mic track; remote audio tracks are mapped back onto the same `RemotePeer[]` the mesh path produces. A screen share publishes a second track tagged `Track.Source.ScreenShare`, subscribed separately into `RemotePeer.screenStream`, and, when the capture came with sound, a third tagged `Track.Source.ScreenShareAudio` that lands in `RemotePeer.screenAudioStream`.

`livekit-client` is loaded via dynamic `import()`, so mesh deployments never download it (it is emitted as a separate ~530 kB chunk).

**Security:** the token endpoint refuses any `peerId` that is not a live voice peer belonging to the requesting user in the requested channel, so a caller cannot mint a token impersonating another participant.

### Speak permission (`Permission.SPEAK`)

The roles editor and the per-channel overwrite editor expose **Speak** (microphone) and **Video** (`Permission.STREAM`: camera and screen share). Both are enforced, permissively: existing roles that had Speak also received Stream, and existing Speak overwrites were copied onto Stream, so a listen-only lobby stays silent on camera and screen until an owner splits them.

**How an owner makes a stage.** In the voice channel's permissions, set Speak to *Deny* for `@everyone` and to *Allow* for a moderator (or "speaker") role. The Quem fala recipe writes Stream the same way. Everyone else joins muted and cannot unmute; moderators talk. Owner and Administrator resolve to every bit, so they can never lock themselves out. Avançado can then deny Video while leaving Speak, or the reverse.

**What is enforced where.**

| Path | Enforcement |
|---|---|
| Join (`ws/voice.ts`) | SPEAK and STREAM are resolved with CONNECT (one query, with the channel's overwrites) and written into the peer. `welcome.canSpeak` / `welcome.canStream` and every roster entry carry both. A false SPEAK logs `voice.speakDenied` once per join. |
| SFU token (`POST /api/voice/token`) | The LiveKit grant is `canPublish` when SPEAK or STREAM is held, with `canPublishSources` when only one of them is. `canSubscribe` stays true. The response carries `speak` and `stream`. **This is the real enforcement:** LiveKit refuses the publish, so a modified client is still silent. |
| Live change | Every permissions bump (role edit, overwrite, role granted or removed) re-resolves SPEAK and STREAM for everyone in that server's rooms (`reevaluateVoiceSpeak`, hooked on `onPermissionsUpdate`, local and cluster-relayed alike). A change sends `voice-speak-changed { canSpeak, canStream }` to that person and, on the SFU, rewrites their participant permission (`setSfuUserCanPublish`: mutes tracks they may no longer publish, then `updateParticipant` with the split grant). A grant works without re-minting a token; the client publishes its mic as soon as it is told. |
| Roster claims | `set-sharing-screen` and `set-camera` are refused for a listener (`screen-share-denied` / `camera-denied`), and `set-voice-state` cannot show a listener as unmuted. |
| Client | Joins muted, the unmute is disabled ("Listening only. You do not have permission to speak in this channel."), share and camera buttons are not offered, push-to-talk does not open the mic, and a "Listen only" badge sits in the call bar. A mid-call grant unlocks the controls with a notice and leaves the person muted until they unmute. **All three clients**: web (`client/src/hooks/use-voice.ts`), iOS (`ios/pqp/Sources/Voice/VoiceSpeakRule.swift`) and Android (`android/app/src/main/kotlin/gg/pqp/app/voice/SpeakRule.kt`). On the SFU the native clients publish no microphone track at all for a listen-only seat, rather than publishing one the grant refuses. |

**The mesh caveat.** In a mesh room the media never touches the server, so the server cannot silence anyone at the media layer. Dropping a listener's offer/answer frames is not an option either: those carry both directions, so it would also stop them *hearing*. Mesh enforcement is therefore client-side (the same gate that already keeps a muted mic muted, and that hides camera and share when STREAM is off), plus the roster refusals above. That is a real limit: a modified client in a mesh room can still send audio, camera, or a screen share. Rooms where this matters are large, and large rooms are on LiveKit, where the SFU enforces it. `voice.speakDenied` in the logs says which transport a listener joined on.

Tests: `server/src/voice/backends.test.ts` (the grant), `server/src/voice/speak.test.ts` (the resolver), `server/src/voice/publish-grant.test.ts` (the live SFU update), `server/src/ws/voice-speak.test.ts` (welcome, roster, refusals, live change), `client/src/hooks/use-voice.test.ts` ("speak permission"), `ios/pqp/Tests/VoiceSpeakRuleTests.swift` and `ios/pqp/Tests/WireDecodingTests.swift`, `android/app/src/test/kotlin/gg/pqp/app/voice/SpeakRuleTest.kt`.

### ICE servers on the SFU: ours, not the media box's

Until 8 Sep 2026 every LiveKit participant took its ICE servers from the LiveKit server's join response and nothing else. On the hosted deployment that list is the media box's built-in TURN, `turn:216.238.114.79:3478?transport=udp` and `turns:turn.pqp.gg:443?transport=tcp`, and port 443 on that box belongs to Caddy, so the TLS relay was dead and only UDP relay worked. Meanwhile `GET /api/ice-servers` (Cloudflare TURN first, 24 h credentials cached 1 h, then Metered, then static) was fetched by all three clients and used by the mesh path only. Two consequences: someone on a UDP-blocked network could not join an SFU room at all, and relayed viewers (about 9% of joins, measured) went through the media box twice.

All three clients now hand the list they already fetched for the mesh to the LiveKit connection, under one rule, **only when the list carries at least one `turn:` / `turns:` entry**. An empty list, a failed fetch, or a STUN-only list passes nothing, so the server's own relays keep working, because on the web and iOS a client list *replaces* the server's. Nothing is fetched twice: the list is read at connect time, so a refreshed credential reaches the next call and an existing connection is left alone. `iceTransportPolicy` stays at its default. Mesh calls are untouched.

| Client | Where | What the pinned SDK does with a client list |
|---|---|---|
| Web | `client/src/lib/sfu-ice-servers.ts`, passed as `room.connect(url, token, { rtcConfig: { iceServers } })` from `livekit-session.ts`; `use-voice.ts` forwards the list `setIceServers` stored | livekit-client 2.21.0 applies the join response's servers only when `rtcConfig.iceServers` is absent (`RTCEngine.makeRTCConfiguration`). `rtcConfig` is a **connect** option, copied onto the engine in `Room.connect`; both `PCTransport`s are built from it (single-PC mode is the default, so usually there is one). |
| iOS | `ios/pqp/Sources/Voice/SfuIceServers.swift`, `ConnectOptions(iceServers:)` in `LiveKitVoiceClient.connect`; `CallModel` / `VoiceModel` keep the join's fetch | client-sdk-swift 2.16.0 overwrites the server list whenever `connectOptions.iceServers` is non-empty (`Room+Engine.swift`). |
| Android | `android/.../voice/SfuIceServers.kt`, `ConnectOptions(rtcConfig = RTCConfiguration(emptyList()), iceServers = ...)` in `LiveKitEngine` | livekit-android 2.28.1 ignores `ConnectOptions.iceServers` unless `rtcConfig` is also given, merges it into that config, and uses the server list only when the merged list is empty (`RTCEngine.makeRTCConfig`). So a non-empty list replaces there too, and the empty `RTCConfiguration` is required. |

Tests: `client/src/lib/sfu-ice-servers.test.ts`, `client/src/lib/livekit-session-ice.test.ts` (asserts the `Room.connect` arguments, the only place the option is honoured), `client/src/hooks/use-voice.test.ts` ("hands the ICE servers this tab already holds"), `ios/pqp/Tests/SfuIceServersTests.swift`, `android/app/src/test/kotlin/gg/pqp/app/voice/SfuIceServersTest.kt`.

**Verifying it in production.** The LiveKit log line `participant active` on the media box carries `connectionType` and the selected candidate pair. Once web clients have picked up the build, relayed web participants must show Cloudflare relay addresses instead of `216.238.114.x`, and `connectionType=turn` participants should start appearing from networks that block UDP:

```bash
journalctl -u livekit --since "1 hour ago" | grep "participant active" | grep -E "connectionType|candidate|relay"
# relay share and who is relaying through what
journalctl -u livekit --since "1 hour ago" | grep "participant active" | grep -oE '"connectionType": *"[a-z]+"' | sort | uniq -c
journalctl -u livekit --since "1 hour ago" | grep "participant active" | grep -c "216.238.114"
```

A `216.238.114.x` relay address on a web participant after the deploy means that tab has not refreshed yet (client deploys reach users gradually), or its `/api/ice-servers` fetch came back without a TURN entry. iOS and Android change with their next TestFlight and sideload builds, not with the web deploy.

**Cost.** Cloudflare TURN is US$0.05/GB after 1 TB/month free. At the measured 9% relay share a 500-viewer, 3-hour party relays about 95 GB, inside the free tier.

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

### Server mute works on both transports, by the eviction trick

`POST /api/servers/:serverId/members/:userId/voice-mute` used to be real on LiveKit and refused (409) on mesh, because the server never touches media on a mesh room. But eviction works on mesh, and it works because the server changes the **roster** and every other client enforces the roster. The mute uses the same trick.

- `VoiceParticipant.serverMuted` (`packages/shared/src/signaling.ts`, defaulted like `muted`) travels on `welcome`, `voice-roster`, `peer-joined` and `peer-updated`.
- The server keeps the flag per (room, user) in `roomServerMutes` beside `roomTransports` in `server/src/ws/voice.ts`: it outlives the seat, so leaving and rejoining comes back `serverMuted: true, muted: true`, and it dies when the room empties. While it stands the target's own `set-voice-state` unmute is refused (the roster is re-sent and the client snaps back).
- On LiveKit the route still asks the SFU to mute the publication first and can still 502; on both transports it then sets the flag and broadcasts the roster, so a tile looks the same whichever transport carried the call.
- Receiving clients (web: `VoiceAudioSinks` via `serverMutedPeerIds` in `use-voice`) play a server-muted peer at zero without touching the stored per-peer volume, suppress their speaking indicator, and draw a distinct glyph. The target's own client pins `isMuted`, disables the unmute control and says a moderator did it. Clearing the flag does **not** unmute them: the mic stays off until they turn it back on, so someone freed mid-sentence does not land in the room the instant staff releases them.

Trust model: a modified sender gains nothing (nobody plays it); a modified receiver can hear one muted person, which is exactly the power a modified receiver already has over an evicted peer's last packets. iOS and Android implement the same contract.

## One room, one transport (fixed)

### The bug this replaces

`use-voice.ts` used to pick its media transport **per client, once per join, and tell nobody**. Nothing in the protocol said which transport a peer was on, so two people in the same channel could be on different ones:

- The mesh client's `offer` / `ice-candidate` frames were relayed faithfully to the SFU client, whose `manager` is `null` — `manager?.handleOffer(…)` dropped them without a trace.
- The mesh client never appeared in the SFU client's `remotePeers` **at all**, because that list is built from LiveKit participants and it was not one.

Net effect: one participant in the call, listed in the sidebar, silent, indistinguishable from someone muted. No error on any screen. It fired whenever `GET /api/voice/backend` failed at bootstrap (permanently, for that tab), whenever LiveKit was reachable from the API but not from one user's network, on a one-off 5xx from `POST /api/voice/token`, or in any build carrying `VITE_VOICE_BACKEND=mesh`.

### The rule

**A voice room has one transport. The server picks it, states it, and does not change it while the room is occupied.**

1. **Who decides.** `ws/voice.ts` decides the transport when a room's *first* peer joins (config, narrowed by the per-room policy below) and pins it in `roomTransports` for as long as the room has anyone in it. It is sent in `welcome.transport` and in every `voice-roster.transport`, so no client has to infer anything. The pin is dropped when the room empties, so adding, removing or repairing LiveKit takes effect on the next call in that channel without a restart.

2. **Clients declare, up front, what they can run.** `join-voice-room` carries `transports: ["mesh"]` or `["mesh", "livekit"]`. A client that cannot run the room's transport is refused *before a peer is created* — it receives `voice-transport-unsupported` and nothing is broadcast, so it never appears in anyone's roster, not even for the round trip it would take to discover the mismatch. An absent `transports` field is read permissively as "both", because the only clients that omit it are builds older than the field.

3. **No silent fallback, ever.** If the SFU session cannot be established at runtime (token 5xx, SFU unreachable from this network), the client **leaves the call and says so**. It does not build a mesh. Building one is what produced the split: the rest of the room is on the SFU and would neither hear that client nor see it drop out. There is no useful degraded state to offer instead — the two transports are disjoint, so "listen only" on the wrong one still receives nothing.

4. **A live room never changes transport.** There is no correct way to move an in-progress call between transports without cutting everyone's audio mid-sentence, and a *partial* move is the original bug. So the room keeps what it started with, and clients can rely on that without any migration protocol. Room-level mesh fallback still exists — it is what a deployment without `LIVEKIT_*` gets, and what a repaired-then-broken deployment gets on the next call — but it is a decision the server makes for the whole room and announces.

5. **Mesh signaling in an SFU room is dropped by the server** and logged as `voice.meshRelayInSfuRoom`. Defence in depth: a client that ignores all of the above cannot half-connect to a call it is not in.

### What the user sees

| Situation | What happens |
|---|---|
| Mesh-only deployment (no `LIVEKIT_*`) | Exactly as before. Server says `mesh`, everyone builds a mesh, the 8-peer ceiling applies. |
| SFU deployment, everything works | As before, except the client reports "Connecting…" until media is actually up rather than "Voice connected" the moment `welcome` lands. |
| SFU deployment, `VITE_VOICE_BACKEND=mesh` build | Refused at join. Voice panel returns to its idle state with: *"This call runs on a voice server this app build cannot use, so you have not joined it. Nobody in the call can hear you."* The people in the call never see them. |
| SFU deployment, `POST /api/voice/token` fails, or LiveKit unreachable from this user | Joins the WS room, cannot establish media, leaves within ~12 s: *"Could not reach the voice server, so you have not joined this call. Check your network and try again."* Others see a join and a leave, never a permanent silent participant. |
| SFU deployment, LiveKit host black-holes | Same as above, bounded at 12 s by the join timer instead of LiveKit's own ~15 s, and the UI says "Connecting…" throughout rather than "Voice connected". |

`VoiceState.transportFailure` (`{ transport, reason: "unsupported" | "unreachable" }`) carries the outcome separately from `error`, so this is distinguishable from a mic failure or a dropped socket.

### Which transport a room opens on (2026-09-06)

LiveKit Cloud bills participant-minutes, and a call between three friends gains nothing from an SFU: the mesh is free, one hop shorter, and its ceiling (`MESH_VOICE_LIMIT`, 8) is far above what a small server or a DM ever fills. So with `LIVEKIT_*` configured a room still opens on **mesh** unless it can outgrow the mesh. The decision is one pure function, `resolveVoiceTransport` in `server/src/voice/transport-policy.ts`, taken once per pin:

| Room | Transport | `reason` in the log line |
|---|---|---|
| DM or group call | mesh | `dm` |
| Voice channel, server with fewer than 10 members | mesh | `small` |
| Voice channel, server with 10 or more members | livekit | `large` |
| Voice channel in a listed community (`servers.is_community`), any size | livekit | `community` |
| Channel with `channels.voice_transport` set (`'mesh'` or `'livekit'`) | that value, regardless of the rows above | `override` |
| No `LIVEKIT_*` on the deployment | mesh, always; nothing else is consulted | `unconfigured` |

- **The override** is the channel settings dialog's "Voice room size" select (Automatic / Small, peer-to-peer / Large, voice server), `PATCH /api/channels/:id` with `voiceTransport`, Manage Channels permission. A streamer's five-member server uses it to force the SFU. Explicit `null` goes back to automatic.
- **Cost of the decision:** one query, and only when it is needed: `getServerVoiceProfile` reads `servers.is_community` plus a correlated `COUNT(*)` over `server_members`' primary key `(server_id, user_id)`, so an index-only range scan. It is skipped for DMs, for a channel with an override, and whenever LiveKit is off. Because the result is pinned with the room, it runs once per call, never per join: a server crossing ten members mid-call does not move the call, the next call in that channel gets the SFU.
- **Everything about the pin is unchanged.** `welcome.transport` and `voice-roster.transport` state the result; a mesh-only client (Android) joining a room that resolved to `livekit` is still refused with `voice-transport-unsupported`, never silently downgraded; a mesh room still stops at 8 with `voice-room-full`, which is acceptable because the policy only picks mesh for rooms that cannot reach 8 by construction, and an owner who expects to can set the override. `POST /api/voice/token` now answers 409 for a room pinned to mesh, so no participant-minute is ever billed for a peer-to-peer call.
- **Log line**, one per pin: `[pqp] voice.transportPinned channelId=… transport=mesh reason=small` (`reason=resume` when a reconstructed resume re-pins what its token remembered).
### Live HLS (`LIVE_HLS_ENABLED`, staging)

A watch-party screen share can also go out as HLS: a LiveKit Track Composite egress (`server/src/voice/hls-egress.ts`) writes 2 s segments to the dedicated `LIVE_HLS_S3_*` bucket and viewers get the playlist through the signed proxy (`GET /api/voice/hls-playlist/:channelId/:startedAt`, `server/src/voice/hls-playlist-proxy.ts`). The transcode only exists on LiveKit, so a channel with live HLS on is pinned to `livekit` (`reason=hls`) even in a two-person server, ahead of the member-count rows above; the channel override still wins.

- **Per-server gate:** `LIVE_HLS_SERVER_ALLOWLIST`, comma-separated server ids, trimmed. Unset or empty means every server. A server outside the list keeps the normal policy above, `reconcileLiveHls` refuses to start an egress for it (and stops one already running on the next reconcile), and `GET /api/live-hls/config?serverId=<id>` answers `enabled: false` for it. A conversation has no server and is never HLS. `isLiveHlsEnabledForServer` in `hls-egress.ts` is the one function that answers; `decideRoomTransport` in `ws/voice.ts` and `reconcileLiveHls` both call it.
- **Encoding:** `LIVE_HLS_PRESET`, `720p30` (default, LiveKit `H264_720P_30`) or `1080p30` (`H264_1080P_30`). Any other value logs `voice.hlsPresetInvalid` once per value and uses the default. 720p is the default because the transcode shares the SFU box's CPU and the presenter is already capped at 720p in a large room.
- **Viewer auth on the proxy:** hls.js sends the Bearer through `xhrSetup`. Safari's native player and the iOS app cannot send a header, so the URL each viewer is handed carries `?t=<token>` (`server/src/voice/hls-viewer-token.ts`: HMAC over user, channel and session, 12 h, derived from `CLERK_SECRET_KEY`). `handleApi` accepts that token in place of the header for this one path only (`HLS_PLAYLIST_PATH`), still runs `requireChannelAccess` on the user it names, and falls through to the ordinary 401 when the token is missing or is for another channel or session. The Bearer path is unchanged.
- **Config route:** `GET /api/live-hls/config` returns `{ enabled, delaySeconds, allowlisted }`; `enabled` is per server when `?serverId=` is given and the global flag otherwise, `allowlisted` says whether a list exists at all.

### Native clients

**iOS runs LiveKit rooms** (PR feat/ios-livekit). The app declares `transports: ["mesh", "livekit"]`, and on a `welcome` that says `livekit` it builds no peer connections: it `POST`s `/api/voice/token` for the peer id the welcome minted, connects a LiveKit `Room` (`client-sdk-swift` 2.16.0) to the returned URL, publishes the microphone, and subscribes to everybody's audio, camera and screen share. Participant identity is the peer id, so the roster, the mute badges and the tiles are keyed exactly as on the mesh. The failure semantics are the web's: token 5xx, a refusing SFU, or 45 s without a connected room leaves the WS room and shows the same "Could not reach the voice server" sentence, and it never builds a mesh instead. A `/ws` blip in a LiveKit room keeps the media: the app declares `resume` on an SFU deployment (read from `GET /api/voice/backend`), presents the `resumeToken` on the rejoin, and skips the media rebuild when `welcome.resumed` comes back for the same peer id.

**Android runs LiveKit rooms too** (PR #248), watches a share in one since
`android/livekit-share-receive`, and draws cameras since
`feat/android-livekit-cameras`. It declares `transports: ["mesh", "livekit"]`,
mints a token for the peer id the welcome named, connects with
`autoSubscribe = false` and subscribes deliberately: every audio publication,
plus `SCREEN_SHARE` and `CAMERA` video. Anything else is refused by default.

Delivery, not subscription, is what the phone controls, and the two videos are
controlled differently because they are used differently:

- A **share** arrives disabled and is enabled only while the viewer is open,
  capped at 720p (360p on a metered link), so a phone in a 100-viewer watch
  party is never handed the 1080p layer.
- A **camera** arrives flowing and is paused a second later unless something is
  drawing it. What draws one is a strip of tiles under the call bar plus the
  full-screen viewer a tap opens, and each surface tells the transport it is
  drawing that camera for as long as it is composed and the app is started, so
  a tile scrolled off the strip, a phone in a pocket and a camera the strip has
  no room for are all paused. Claims are *counted*, because the viewer is a
  dialog over a strip that stays composed and closing it must not pause the
  tile behind it. The layer is capped per surface: the bottom layer for a tile,
  360p for the viewer on Wi-Fi, the bottom layer again on a metered link.
  Mirrors `client/src/lib/remote-video-delivery.ts`, whose grace period it also
  copies. The ceiling is worth less than it looks against a **web** publisher,
  which publishes its camera with `simulcast: false`: there is one layer on the
  server and the saving there is entirely the pausing.

Both controls need `adaptiveStream = false` on Android: unlike livekit-client,
the Android SDK ignores `setEnabled` and `setVideoQuality` on an adaptively
managed track rather than treating the manual value as a ceiling.
`SCREEN_SHARE_AUDIO` plays with the voice, silenced by deafen and gated on the
roster having announced the share. A camera the publisher *mutes* rather than
unpublishes drops its tile and its delivery until the unmute; every pqp client
unpublishes, so that path is for the server-side mute and for other clients.
A reconnect re-asks for both halves, the subscriptions and the track settings,
because the SFU keeps neither across one.

What Android does **not** do on LiveKit: publish a screen (the button is hidden
there), publish a camera (it has no capture at all, on either transport), or
per-peer stats, because LiveKit's stats arrive in the other libwebrtc's types.
None of the receive path has been run on hardware yet.

**iOS publishes screen shares on LiveKit** (PR `ios/livekit-share-send`). The ReplayKit bridge is unchanged and transport-agnostic: the extension writes NV12 over the App Group socket, and the app feeds the frames to the mesh's `RTCVideoSource` or to a LiveKit `BufferCapturer` track published as `Track.Source.ScreenShareVideo`. The bridge is armed once the room is connected, and the publish waits for the first frame, because the SDK resolves a buffer track's dimensions from what it captures. The SDK's own broadcast path is not used, deliberately: it JPEG-encodes every frame inside the ~50 MB extension process. The publish carries the web's ladder from PR #237, layer for layer (`sfuScreenPlan` in `ios/pqp/Sources/Voice/VideoQuality.swift`), including the large-room cap, so a phone cannot hand a watch party an uncapped 1080p30 stream. The share control follows `welcome.self.canSpeak`. Still mesh-only on iOS: the receive-side video quality ladder; LiveKit subscribes at the SDK's defaults. **Device-only and unverified:** ReplayKit broadcast has no simulator equivalent.

**Android is still mesh-only.** It declares `["mesh"]` and is refused from SFU rooms with `voice-transport-unsupported`, exactly as iOS was before this.

### What can still split a call

With the registry off (the default, and every self-host): two server instances with **different** LiveKit config pin the same channel differently, because `roomTransports` is per-process like `peers`, and a mesh room is relayed by the one process that holds its peers. That is why a flag-off deployment is single-machine, full stop.

With the registry on and two live instances (M5 of the plan, 2026-09-06):

- **Transport disagreement cannot split a call any more.** The pin is one row in `voice_rooms`; whoever inserts first decides, the other adopts (`voice.transportAdopted`). Two images mid-rollout with different LiveKit config still log `voice.configDrift` from the `voice.hello` exchange, and the CI assertion after a deploy fails if the started machines are not on one image.
- **Mesh spans instances (since 2026-09-08); the machine count does not pick the transport.** A room nobody has pinned gets the transport policy's answer, on one machine or two, and pins it atomically in `voice_rooms`; a room already pinned (on either transport) is adopted by whichever machine the join or resume lands on (`voice.meshPinAdopted` when it is mesh). For one day a guard sent a fresh mesh room to the SFU while a second lease was live (`voice.meshGuardForcedSfu`); it went the same night, because production has `LIVEKIT_*` set and a peak of forty small rooms would all have landed on the media box. A signaling frame for a peer this instance does not hold crosses on `voice.signal`, stamped with the sender's room; the instance holding the target applies the same-room rule against its own map before delivering, so the bus is no wider a door than the local relay. The ceiling counts the rows too. A machine that is draining withdraws its lease before it closes a single socket, so it stops counting at once. Until 2026-09-08 the guard refused a join into a room pinned elsewhere (`voice-join-refused`, `reason: "mesh-multi-instance"`), which hung up four resumes in the 2026-09-07 window; that refusal, and the `voice.meshClusterUnsafe` warning that went with it, no longer exist.
- **What can still split a call:** a client that cannot run LiveKit on a two-machine deployment (Android, which declares `["mesh"]`) is refused from every room the policy sent to the SFU, exactly as it is refused from a large server's room today; that is a refusal, visible, not a split. And a `DATABASE_URL` through a transaction-mode pooler, where LISTEN never delivers: the rows are still right, the hints never arrive, and the other machine's sidebar is stale until something local makes it re-read the rows. `bus.selfEchoMissing` at boot is the tell; the plan's note on failing `/health` for it is still open.

### The voice registry (`VOICE_REGISTRY=postgres`, off by default)

Milestones M1 to M4 of [`docs/plans/MULTI_INSTANCE_VOICE.md`](./plans/MULTI_INSTANCE_VOICE.md): the peer map and the transport pin, copied into Postgres so more than one API instance can agree on a room, the roster read back from those rows, a seat that outlives the instance that held it, and rings, moderation notices and SFU re-sweeps that cross instances. `server/src/voice/registry.ts` owns five tables (`voice_rooms`, `voice_peers`, `voice_retired_peers`, `voice_instances`, `voice_resweeps`), all additive and empty until the flag is on.

What changes with the flag on, and only then:

- **Write-through.** Every join, state change, socket loss, resume and leave in `ws/voice.ts` is copied to `voice_peers`. The in-process map still holds the sockets and is exact for the peers this instance serves.
- **The roster is the rows (M2).** `broadcastRoster` and `sendAllVoiceRosters` read `voice_peers` joined to `voice_rooms` (one indexed query per roster, still serialised per channel), with this instance's own peers laid over by id, so an audience socket here sees the people on the other machine too. `welcome.peers` lists the other instance's live peers the same way. A roster is never built from the rows before this instance's own pending write has landed.
- **Room events over the bus (M2, needs `CLUSTER_BUS=postgres` as well).** Three topics: `voice.room` (`joined` / `left` / `updated` / `roster`, published from inside the roster queue after the row write settled), `voice.identity` (a profile edit; the other instance relabels its own seats for that person and writes its own rows), `voice.watch` (the watch-party state). The receiving instance does the local half only: forwards the `peer-*` frame to its room peers, then rebuilds the roster from the rows. **Frames are hints, rows are truth**: a frame that was lost costs the other instance's sidebar a moment, never a ghost participant. With the registry on and the bus off the rows are still written and nothing crosses; with the bus on and the registry off no voice frame but `voice.hello` is published.
- **The watch party is a column (M2).** `voice_rooms.watch_party` and `watch_party_rev`. `applyWatchPartyWrite` keeps its in-memory coalescing, then the accepted state is written with the contract's ordering as the `WHERE` clause (higher `rev` wins, ties on `actorId`); a row not updated is a write that lost, and the writer is handed the row's winner alone, which is how a client that missed a frame is put back in step in one round trip. A joiner reads the row for the initial state. The columns are cleared on teardown and go with the room row when the last peer anywhere leaves.
- **One room, one transport, across instances.** An unpinned room's decision goes through `INSERT INTO voice_rooms ... ON CONFLICT DO NOTHING RETURNING` before it is applied. Whoever inserts first decides; the loser adopts the stored transport (`voice.transportAdopted` in the log) and a client that cannot run it is refused as usual. The last peer's delete removes the room row in the same statement.
- **`POST /api/voice/token` from any instance.** The request may carry the `resumeToken` that `welcome` minted; a valid HMAC proves `{ user, peer, channel }` with no lookup. Without it the route checks this instance's map, then the `voice_peers` row, then 403. A room another instance pinned to mesh still answers 409. Old clients that omit the field behave exactly as before.
- **Moderation and the operator snapshot see the cluster.** `findVoiceChannelForUser` and `findVoicePeerIdentities` read the map, then the rows, so the SFU eviction can target a participant whose socket is elsewhere; `getVoiceActivitySnapshot` counts rooms from the rows, and reports `cluster.framesRelayed` / `cluster.framesReceived` (voice frames this instance put on the bus for sockets held elsewhere, and frames from the bus it applied to sockets it holds) so a flip can be read as two climbing numbers rather than a log line.
- **A moderator's mute is a row and a frame (2026-09-08, needs the bus for the frame).** `voice_server_mutes (channel_id, user_id)` cascades with the room row, which is the sanction's lifetime. `setVoiceUserServerMuted` writes the row, publishes `voice.serverMute`, then does the local half; the instance holding the target's seat forces `muted`, rewrites its rows and fans out, and refuses the target's own unmute in `set-voice-state`. A join reads the row on its way in, so a seat minted on the other machine, or after a restart, comes back muted; every roster row carries `server_muted`.
- **Moderation crosses (M4, needs the bus).** Every eviction (`evictVoiceUser`, `evictVoiceChannel`, `evictVoiceUsersExcept`, `disconnectVoiceUser`) and the SFU mute notice publish `voice.moderation` before anything else. The instance holding the target's socket says the notice, when there is one, and forgets the peer without a `peer-left`; the instance the request landed on then releases each foreign row the way the beacon does (`releaseForeignPeer`: row and retired id, `adopted` then `left` on the bus, so the departure is announced exactly once) and runs the SFU half once, with the rows' peer ids merged into the identity hint. A lost frame costs the target the notice, never the sanction: the row goes regardless.
- **Rings cross, the ring does not (M4, needs the bus).** A call is owned by the instance holding the caller's socket: its 45 s timer, the empty-room grace and the pending set stay in that process. What crosses on `voice.call` is delivery: `call-incoming` and `call-ring-cancelled` addressed by user id to whichever sockets those people hold, `call-declined` to the call's peers, and, the other way, a `decline` or an `answered` from the other machine routed to the owner, which is the only instance that decides anything, calls `pushIncomingCall` or writes the missed-call message. Somebody already in the call on the other machine is not rung (rows), and the empty-room grace reads the rows before ending a ring, since the caller may have come back elsewhere. Accepted degradation: an owner that dies mid-ring ends the ring with no `call-ring-cancelled` and no missed-call record. The phone push already went out and the client's own timeout ends the ring on screen.
- **SFU re-sweeps are claims (M4).** `scheduleResweep` writes a `voice_resweeps` row (the sweep is data: kind, room or user, allowed ids, `knownIdentities`, `evicted_at`, `until`) instead of a per-key interval. `tickSfuResweeps` deletes expired rows, claims live unclaimed ones for 4 s in one `UPDATE ... RETURNING`, and sweeps only what it won; it runs after every heartbeat on every instance (`runVoiceReconcile`), and a process that wrote a row keeps one 5 s ticker alive while any row is live. So at most one sweeper per key per window, no leader, and a deploy inside the fifteen-minute window no longer drops the remaining sweeps: the survivor claims the row on its next beat. With the flag off the per-key `setInterval` runs exactly as before.
- **Retired ids are cluster-wide, and only there (M3).** A hung-up peer id cannot be reconstructed on another instance, or on this one after a restart, for the token's life. With the flag on `voice_retired_peers` is the one store; the in-process map is never written.
- **Resume lands anywhere (M3).** A `join-voice-room` with the resume pair for a seat another instance holds *adopts* it: one conditional `UPDATE` stamps this instance on the row and clears the orphan mark, the welcome says `resumed`, the seat keeps what its row says (a share or camera still up on the SFU, a standing mute), and nobody ever hears a `peer-left` for a person who never left. The old owner is told with `voice.room { kind: "adopted" }` and forgets its entry without a word; if its socket was half-open its eventual close finds nothing. The same whether the old owner is alive (a Wi-Fi blip landing on the other machine) or dead; the log says which (`voice.resumeAdopted`). A hangup on one instance is refused as a resume on the other, because the retired row is checked first.
- **Liveness has consequences (M3).** Each instance upserts `voice_instances` every 15 s (`config_hash` is a digest of the LiveKit URL and key id); a row older than 45 s, or absent, is a dead instance. After every beat each instance runs the reconcile (`runVoiceReconcile`): the dead instance's peer rows are stamped `orphaned_at` as of its last heartbeat (seat held, sidebar still shows them), then deleted once that is 90 s old, in one statement that also retires the id and unpins an emptied room, with `peer-left` fanned out by whoever ran the sweep and a `left` hint on the bus; room rows with no peer and older than 30 s, dead lease rows and expired retired ids go too. Every statement names exactly the rows it changed, so two instances running it in the same second announce each departure once between them. An instance never touches its own rows: its own orphan timers are the authority on its own seats.
- **The beacon lands anywhere (M3).** `POST /api/voice/leave` (and `leave-voice-room` carrying the resume pair on a fresh socket) retires a seat whichever machine holds it: a local seat goes in the same tick as before; a foreign row is verified against the HMAC, deleted, the id retired, and the cluster hears `adopted` then `left`, so the owner forgets the seat before its room is told and its orphan timer never announces a second departure.
- **The transport is answered synchronously for a room pinned elsewhere (M3).** `getRoomTransport` reads the local pin, then a per-process read-through cache of `voice_rooms.transport` filled by every row read and dropped for a channel on every `voice.room` frame about it, then the configured ceiling. The share and camera caps and the relay guard stay synchronous.
- **`voice.hello` on the bus.** With `CLUSTER_BUS=postgres`, an instance publishes its config hash once connected and requires its own echo within 5 s. Silence is logged loudly (`bus.selfEchoMissing`): it means `DATABASE_URL` is a transaction-mode pooler and LISTEN is not delivering. A foreign hello with a different hash logs `voice.configDrift`. Neither fails `/health` yet.

Flag off means off: `isVoiceRegistryEnabled()` is read on every path and every registry call sits behind it, so a self-host that never sets the variable runs the code that shipped before the registry existed. `server/src/ws/voice-registry.test.ts` pins that the tables stay empty through a join, a state change, an orphan and a leave with the flag off; `server/src/ws/voice-cluster.test.ts` runs two module graphs over one memory bus and one `pqp_test` database and pins what crosses, what does not, and that neither instance republishes what it heard.

**With M5 (the drain, the two-machine `fly.toml`, the CI count and image assertion, and the mesh guard above) plus the 2026-09-08 prerequisites (mesh across instances, mutes on the bus, the frame counters) the code is enough to run two machines.** Production ran two for 2 h 39 min on 2026-09-07 and is back to one by choice; the flip is M6 (`docs/deploy-fly.md` 6a-bis), after the staging rehearsal with `LIVEKIT_*` set (`docs/STAGING.md`).

## The roster wire: a whole room, or only what changed

Voice occupancy drives the channel-list badges, so `voice-roster` goes to everyone who can **see** the channel, not to the people in the call. That audience is the server's membership, and the frame is the size of the room, and the product of the two is what stopped working on 2026-09-05: 130 people in a 508-member community is roughly 45 KB to every socket, and #260 had bounded how OFTEN that goes out without touching how BIG it is.

So a room that has already been described is described incrementally.

- **`voice-roster-delta`** carries three lists applied in order — `joined`, `updated`, `left` — each an **absolute** statement about one peer (present with this state, or absent). Because they are absolute rather than relative, applying one twice is the same as applying it once, which is what makes a delta that overlaps a snapshot the receiver already holds harmless.
- **`seq`** is monotonic per room, +1 per frame (full or delta), and **restarts at 1 whenever the room has been empty**. A receiver applies a delta only when `seq === held + 1`, and a receiver holding nothing holds 0 — so the first delta of a fresh call is self-sufficient for somebody who was not watching the last one.
- **`size`** is how many participants the room has after the delta. A receiver that applied everything and still disagrees has diverged for a reason `seq` cannot see.
- On either failure the receiver **stops applying deltas for that room** and waits. It does not ask for anything.

**The convergence guarantee is the server's, not the client's.** Every keyframe interval the whole roster goes out again, whatever happened in between. That answers every failure with one mechanism, including the one a client cannot detect as a gap at all: a socket that entered the audience mid-call and never had a baseline to compare against. Whatever went wrong, and whether or not anyone noticed, the next keyframe replaces the receiver's state wholesale — so the worst staleness any roster bug can produce is bounded by that constant, by construction. A client-driven resync would instead let a wrong or hostile client decide when the server does expensive work.

**The room and the audience are not owed the same interval.** A roster goes to everyone who can see the channel, and that audience is routinely several times the size of the room, so most of the keyframe cost is paid on behalf of a sidebar badge rather than a call. The two are genuinely different promises:

| receiver | interval | what a stale one costs |
|---|---|---|
| in the call | `ROSTER_KEYFRAME_MS`, 10 s | the signalling allowlist (`knownPeerIds`), which decides whose offer may open a microphone, and the prune of a dead peer connection |
| watching the channel | `ROSTER_AUDIENCE_KEYFRAME_MS`, 30 s | a mic-off icon next to a channel this browser is not in |

Decided **per socket**, not per account: the same person can hold a tab in the call and a phone looking at the sidebar, and they are not owed the same frames. Neither number is the delta rate — both keep receiving every change as it happens, and this only governs how often the whole list is restated. Thirty seconds rather than a minute because the saving is a ratio (most of it is already had at 3x) while what grows linearly is the one case a keyframe is the only answer to: a socket that gained audience membership mid-session and holds no baseline at all, so it cannot detect its own gap and cannot ask.

Measured at 800 sockets with 200 in one call: whole-roster frames 2400 → 1124, 110.6 MB → 48.6 MB. The arithmetic is visible in the frame count (200 participants at three keyframes each plus 600 watchers at one), so **the saving scales with the audience fraction** — a big community around a small call gains more, a full room gains nothing.

Two asymmetries worth knowing:

- **A snapshot rebuilds the client's signaling allowlist from scratch; a delta never clears it.** `knownPeerIds` in `client/src/hooks/use-voice.ts` is a trust boundary, not a display: absence from a delta means "unchanged", so clearing on one would drop every peer the delta did not happen to mention. The periodic keyframe is therefore what keeps a stale id from lingering as an accepted signaling source, now within 10 s rather than instantly.
- **A snapshot may be dropped under backpressure; a delta may not.** Snapshots supersede each other, so a socket holding a megabyte of unsent frames is better served by the next one. Deltas *compose*, so dropping one silently corrupts every later one. Insisting on sending them is safe because they are small by construction and a socket far enough behind to worry about is reaped by the heartbeat inside a minute.

**Compatibility is per socket, negotiated at `auth`.** A client sends `caps: ["voice-roster-delta"]` on its first frame; anything that does not ask keeps receiving a whole `voice-roster` every time anything changes, byte for byte what it received before. The packaged desktop shell and the two native apps update on their own schedule and a person in a call is the last person to want a forced refresh, so the server may never assume a client understands a frame that did not exist when that client was built. See `SOCKET_CAPS` in `server/src/ws/sockets.ts`.

**With `VOICE_REGISTRY` on the delta is a diff, not a folded queue.** There the rows are the truth and this instance's local event queue is only half the story (a join on the other machine never enters it), so `sendRoster` keeps, per channel, the participants it last sent and diffs the freshly read rows against them: in the rows and not in the memory is `joined`, in both with a different field is `updated`, in the memory and not in the rows is `left`. A change made on another instance therefore reaches this instance's audience as a delta too, because its bus hint makes this instance re-read the rows. Whenever that memory is missing the whole roster goes out, exactly as before: the first frame of a room, a registry read that failed (the fallback is this instance's own peers, which must not be diffed against), a process restart, a channel deleted or made private. It is dropped when the room empties. Until 2026-09-07 this path sent **no deltas at all** (`registryOn() ? null : foldRoomEvents(events)`), and since production runs with the registry on, `voice.roster.deltas` read 0 there while every delta test was green. `server/src/ws/voice-roster-delta-registry.test.ts` pins the registry path on a real Postgres; `voice-roster-delta.test.ts` still pins the in-process one. Measure them separately.

**How to tell, from outside, that any of this is running.** A roster bug is silent by construction: it shows up as somebody missing from a participant list, never as an error, and a deploy where no client negotiated the capability would serve whole rosters forever and look exactly as healthy as one where the change works. So `GET /api/admin/metrics` carries `voice.roster`:

| field | what it says |
|---|---|
| `deltas` / `snapshots` | roster frames written since boot, by kind. Deltas should dominate heavily once a room is busy. |
| `socketsOnDeltas` / `sockets` | how many connected clients asked for deltas at all. This is the denominator; without it the pair above cannot distinguish "working" from "nobody is using it". |

The `ws.auth` log line carries the negotiated `caps` for the same reason, so a single connection can be traced. Both exist because of CLAUDE.md pitfall 9, where Cloudflare TURN was configured, deployed and never once used, and nothing anywhere said so.

`server/src/ws/voice-roster-delta.test.ts` holds the receiver rule against the server; the client half is in `client/src/hooks/use-voice.test.ts`. `server/scripts/README.md` has the measurements and how to reproduce them.

## Screen-share audio

The capture is requested with `audio` plus **`systemAudio: "exclude"`**, and most of the time the browser hands back no audio track at all. That is the expected answer, not a failure:

| Browser / OS | Sound in a screen share? |
|---|---|
| Chrome or Edge, any OS, sharing a **tab** | Yes, when the user ticks "share tab audio" |
| Chrome or Edge on **Windows or ChromeOS**, sharing the **whole screen** | Only after the user arms "send this computer's sound" in the call controls, and then ticks "share system audio" |
| Chrome on **macOS or Linux**, sharing a screen or a window | No. The OS does not hand the browser its own output |
| **Safari**, anything | No display audio at all |
| **Firefox**, anything | No display audio at all |

Both transports carry it the same way the video is carried. Mesh adds the audio track to every peer connection under the capture's own MediaStream, so both halves share one msid, and announces that id on `set-sharing-screen` (`audioStreamId`), which the server puts on the roster as `screenAudioStreamId`. That announcement is the whole receive-side story: without it a second incoming audio track would be filed as the presenter's microphone and silence them. LiveKit needs no such thing, because the publication is labelled `ScreenShareAudio`.

Playback is a second `<audio>` element in `VoiceAudioSinks`, next to the one that plays that person's voice, so deafen, the output-device choice and their volume slider all apply to it. The `<video>` elements stay muted in both the presenter's preview and the viewer's stage.

That element is mounted for every peer in `audibleScreenPeerIds` (hook state: both shares when two people are presenting, the focused share when there are three or more). The roster is still the gate: an unannounced LiveKit `ScreenShareAudio` publication never makes that list, so it stays silent. The list lives on the voice controller, not on whether the stage is mounted, so navigating to a text channel does not mute a live share.

### The echo, and why system audio is opt-in (2026-08-26)

A 3-star call rating on 23 Aug 2026: *"Quando alguém transmite, ele repete a Call de quem esta na chamada tbm. Aí fica com eco."* Somebody shares their screen and everybody hears themselves come back.

`systemAudio: "include"` was the cause. It asks the picker to offer the machine's whole output, and the machine's whole output contains the call, so on a Windows whole-screen share every voice in the room was tapped off the render endpoint and sent back to the person speaking. Three things that look like the fix and are not:

- **Echo cancellation cannot touch it.** AEC subtracts a known reference from what a *microphone* heard. System audio is tapped after the mixer and never goes near a microphone. `echoCancellation: false` on a screen-audio track is also correct: it is what keeps a film's soundtrack intact.
- **Headphones do not help.** The Windows loopback tap is WASAPI's render endpoint, which is the same endpoint whether the sound then leaves via speakers or a headset. This doc used to say headphones were the answer. They are the answer for microphone echo and they do nothing here.
- **`selfBrowserSurface: "exclude"` does not help.** It keeps our tab out of the *video* picker and says nothing about audio.

What is done instead, in `client/src/lib/screen-capture-audio.ts`:

1. **`systemAudio: "exclude"` by default.** The spec scopes that member to monitor surfaces, so a whole-screen share can no longer carry the machine's output and a **tab** share still carries its own sound. Measured on Chrome 151: a tab capture under `"exclude"` still hands over a `Tab audio` track. Tab share stays the recommended route because it is the only one that cannot echo.
2. **An explicit opt-in**, next to the share button in both the channel panel and the conversation stage, session-scoped and off on every reload. Arming it says out loud that the call's audio goes with it.
3. **`restrictOwnAudio: true`** whenever the browser knows the constraint (Chrome desktop 141+, Electron 43.4+, feature-detected). The spec: *"the user agent MUST attempt to remove any audio from the audio being captured that was produced by the document that performed getDisplayMedia()."* Our document is the one playing everybody's voices. Heard working on Windows Chrome (30 Aug 2026). The desktop app needs Electron 43.4.0 or newer, where `setDisplayMediaRequestHandler` started honouring the constraint and remapping `"loopback"` to `loopbackWithoutChrome`.
4. **`audio: false` in the Electron shell** unless the user opted in. The shell answers `setDisplayMediaRequestHandler` with `{ video, audio: "loopback" }` on Windows (`electron/lib/display-sources.js`). That string stays `"loopback"`; Electron 43.4+ remaps it when `restrictOwnAudio` is on the page request. Electron 34 (v0.1.3) ignores the constraint, so a new desktop binary is the remaining fix. The page not asking is still the off switch for installs that have not updated, and it costs nothing: the picker lists screens and windows, never tabs.
5. **A warning while it is live**, when the capture came back as `displaySurface: "monitor"` with an audio track and somebody else is in the room. The presenter is the one person who cannot hear the echo they are causing. Keep this until a 0.1.4 install has been heard clean; the copy still describes the old shell.

Neither native mobile client shares the defect: iOS drops every non-video `RPSampleBufferType` in `ios/pqp/Broadcast/SampleHandler.swift`, and the Android client never builds an `AudioPlaybackCaptureConfiguration`.

**Reproduced on Windows (30 Aug 2026).** Chrome on Windows, whole-screen share with the sound toggle on: YouTube/Spotify reached the other device, the call did not. The v0.1.3 desktop app on the same machine, same test: music went out and the Mac voice came back through the share. Headless Chromium on macOS still cannot hear this. What else was measured, on Chrome 151:

- A real tab capture under `systemAudio: "exclude"` still hands over a `Tab audio` track, `displaySurface: "browser"`, `echoCancellation` still false, `restrictOwnAudio` honoured. This is the fact the new default rests on.
- `getSupportedConstraints().restrictOwnAudio` is `true` in Chrome 151 and the setting comes back `true` when asked for.
- Headless Chromium on macOS refuses `getDisplayMedia` for every surface and every option set (`NotSupportedError`), so `client/e2e/screen-share-system-audio.spec.ts` runs against Chromium's synthetic capture device, which always reports a monitor with a "Fake audio" track. That spec pins the options the app really sends, that a share's audio still reaches the other person, and that a monitor-plus-audio capture raises the warning. It cannot and does not claim to have heard an echo.

## Screen share on the SFU (verified)

Publish/subscribe works: `publishScreen` tags the track `Track.Source.ScreenShare`, the far side subscribes it into `RemotePeer.screenStream`, and `unpublishScreen` clears it. Verified with two browsers against a live LiveKit.

Concurrent presenters are capped in `ws/voice.ts` on the `set-sharing-screen` frame: **2 on mesh, 4 on LiveKit** (`SCREEN_SHARE_LIMIT`). A claimant past the cap gets `screen-share-denied` and the roster does not add them. Two caveats, both still true under a cap:

- **The cap binds the roster, not the media.** A client that publishes a `ScreenShare` track without announcing it is not stopped by anything — LiveKit has no such rule and the server cannot see the track. Every other participant subscribes and decodes it. It is never *rendered*, because `ScreenStage` is driven by `screenSharePeerIds` from the roster, so this is a bandwidth-grief vector rather than a way to hijack a slot.
- **The honest client publishes before it is answered.** `startScreenShare()` sends `set-sharing-screen` and publishes to the SFU without waiting; on a denial, `screen-share-denied` arrives a round trip later and unpublishes. In the simultaneous-click race at the cap a spare screen track is briefly live on the SFU.
- **Cap 4:** with `adaptiveStream` on (below) a thumbnail share asks for its 360p layer, so four concurrent shares no longer mean four full-rate streams per viewer. Mesh is unchanged: `tuneScreenSender` already budgets per presenter across the peer count, so a second presenter adds no encode cost to the first.

### Bandwidth: simulcast and receive quality (2026-09-06)

Why: a 100-viewer watch party on 5 Sep 2026 consumed 323 GB of SFU downstream in 3.5 hours. The screen share went up as **one layer** and every viewer, phones included, received it. Worse, the publish passed the ceiling in `videoEncoding`, which livekit-client ignores for a `ScreenShare` source (it reads `screenShareEncoding`), so the one layer had **no bitrate cap at all**. Client-only fix, LiveKit path only; mesh is untouched.

**Presenter ladder** (`screenSimulcastPlan` in `client/src/lib/video-quality.ts`, published by `publishScreenVideo` in `livekit-session.ts` with `simulcast: true`, `screenShareSimulcastLayers` as `VideoPreset`s and `screenShareEncoding` for the top):

| Layer | Size | Ceiling | Note |
|---|---|---|---|
| top | capture size, 1080p on auto or an explicit 1080p | the chosen ceiling: 3 Mbps auto, 4 Mbps 1080p, 2 Mbps 720p | `setScreenMaxBitrate` moves this layer only |
| mid | 1280x720 | 1.4 Mbps | only when the top is above 720 |
| low | 640x360 | 450 kbps | only when the top is above 360 |

`degradationPreference: "maintain-framerate"` and 30 fps stay. The top layer is the **capture size** on purpose: livekit-client declares each layer's dimensions to the SFU and routes a viewer's size request against that declaration, so the session asks the capture for the plan's height with `applyConstraints({ height: { max } })` rather than scaling the top layer behind the library's back. A display capture climbs back to 1080 when the limit is lifted.

**Large-room cap.** Above `LARGE_ROOM_PARTICIPANTS` (20, counted off `room.remoteParticipants` plus self) the top is held at **720p / 1.5 Mbps** unless the presenter picked **1080p by name** in the send menu, which steps around the cap. The menu says so while it acts ("Large room: your screen goes out at 720p to keep it smooth for everyone. Pick 1080p to send it anyway."). A change of top *height* on a live share (crossing 20 people, or choosing 1080p mid-share) republishes the same track with `unpublishTrack(track, false)` so the capture survives; viewers see one blink at that moment. A change of *ceiling* at the same height moves the sender in place, no blink, as before.

**Viewer side.** The room is created with `adaptiveStream: true`, and every remote video stream carries a binding (`client/src/lib/remote-video-binding.ts`) so the three `<video>` sites introduce their element to the track via `RemoteVideoTrack.attach`; without that the library measures nothing and, after the first tab switch, tells the server the track is invisible. "Video you receive" gains a selector on the SFU path: **Auto, 1080p, 720p, 360p**, applied with `RemoteTrackPublication.setVideoQuality(VideoQuality.HIGH | MEDIUM | LOW)` to every subscribed video publication (share and camera tiles) and to any that subscribes later. Auto sends `HIGH`, which under adaptive stream means "the element decides".

**Adaptive stream and an explicit choice do not fight.** Verified in livekit-client 2.21.0 (`RemoteTrackPublication.emitTrackUpdate`): when both are set the library requests the **smaller** of the adaptive dimensions and the chosen layer's dimensions. The explicit pick is therefore a ceiling; a small element still saves below it. This is tighter than the docs' "manual overrides adaptive" and it is the behaviour wanted here.

**Device defaults** (`client/src/lib/receive-quality.ts`, `localStorage` key `pqp:receive-quality`, per device like the participant rail): coarse pointer, viewport under 900 px, or a phone user agent defaults to **720p**; desktop defaults to **Auto**. Anyone can pick 1080p. On mesh the selector is hidden and the "sender picks that size" sentence stays, because there it is still true.

**Cellular default** (2026-09-06). When the Network Information API (`navigator.connection`, Chromium and Android only; Safari and Firefox have none, so the rule is silent there) reports `type === "cellular"`, an `effectiveType` of `slow-2g` / `2g` / `3g`, or `saveData === true`, the default becomes **360p** on any device, ahead of the three signals above. A stored choice always wins; the default is never written to storage. The store listens to the connection's `change` event and, when nothing was ever chosen, recomputes the default mid-call (Wi-Fi to cellular drops to 360p, back again restores the device default) and the live SFU session follows it through the same subscription the menu uses. An explicit pick, stored or made during the call, is never moved. Picking the size the default already was counts as a pick. The menu says why in one line while the cellular default is in effect (`call.quality.receive.cellularDefault`) and, on the receiving half of a room above 20 people, that shares arrive at up to 720p unless the presenter chose 1080p (`call.quality.receive.largeRoomCap`; the presenter sees the sending-half sentence instead, not both).

**Video nobody is drawing** (`client/src/lib/remote-video-delivery.ts`, wired in `livekit-session.ts`). A remote video publication is delivered while at least one `<video>` element is bound to it through `bindRemoteVideo` and the tab is visible; otherwise it is paused with `RemoteTrackPublication.setEnabled(false)`, which stops the server forwarding without tearing down the receiver, so resuming is one signalling message rather than a renegotiation (`setSubscribed` would be the slow one). Losing the last element waits **1 s** before pausing, so a React rebind across a layout change or a tile scrolled just past the rail's edge does not blink; the tab going hidden (`document.visibilityState`) waits **10 s**, so a glance at another window does not stop every picture. Resuming is immediate. This covers the parked `RailTile` (the existing IntersectionObserver unmounts its `<video>`), a closed rail, and any camera no surface draws. Audio publications never pass through the rule. Lifting a pause **clears** the library's private `requestedDisabled` and re-emits the track settings instead of calling `setEnabled(true)`: verified in livekit-client 2.21.0 (`RemoteTrackPublication.isEnabled`), a manual `setEnabled(true)` pins the publication enabled and switches off the library's own adaptive-stream pauses (an attached element scrolled out of view; its five-second background pause) for the rest of the call. A build without that field gets `setEnabled(true)`.

Verification status: unit-tested (`livekit-session-quality.test.ts`, `video-quality.test.ts`, `receive-quality.test.ts`, `remote-video-delivery.test.ts`). The cellular rule and the pause were not observed against a live LiveKit or a real phone on mobile data; the `setEnabled` semantics are pinned on a fake publication shaped after the library's. See the PRs for what was and was not observed.

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

**LiveKit is deployed.** Production voice runs through a self-hosted server at `sfu.pqp.gg`, and `GET /ready` reports it. What follows is the decision record for how that was chosen and what it costs; the runbook for the box itself is [`plans/SELF_HOSTED_LIVEKIT.md`](./plans/SELF_HOSTED_LIVEKIT.md).

**What a deploy needs.** Three values on the Fly app (`fly secrets set`, not `[env]` — two of them are credentials): `LIVEKIT_URL` (`wss://…`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`. Nothing changes on Cloudflare Pages — the client learns the backend from `GET /api/voice/backend` at runtime, and CI does not set `VITE_VOICE_BACKEND`. Do **not** copy `client/.env`'s `VITE_VOICE_BACKEND=mesh` into the build; it forces mesh for everyone.

**Option A — LiveKit Cloud.** Free "Build" tier: 5,000 WebRTC connection-minutes/month and 50 GB egress, no card. 5,000 participant-minutes is roughly *four people talking for 20 hours a month, in total* — enough to validate, not enough to run on. Next tier ("Ship") is $50/mo including 150,000 minutes, then $0.0005/participant-minute and $0.12/GB downstream. Cloud is also the only place `revokeTokenTs` works, so moderation costs one RPC instead of fifteen minutes of re-sweeping.

**Region.** LiveKit Cloud lists **Brazil** among its regions and routes participants to the nearest edge automatically, so a São Paulo audience is served from Brazil rather than from `us-east`. Confirm the project's region in the Cloud dashboard before committing — the docs describe the region list as service-wide, not per-plan, but the mapping is not contractual.

**Option B — self-host on Fly.** A second Fly app in `gru`, ~$5–10/mo for a `shared-cpu-1x`/1GB machine plus egress. Two things make this harder than it looks: LiveKit wants a UDP media port reachable from the internet, and Fly only forwards UDP on ports declared in `fly.toml` and bound to the `fly-global-services` address — so LiveKit has to be pinned to a single UDP mux port (`rtc.udp_port`) rather than a range, with TCP 7881 as the ICE fallback. It also needs its own TLS hostname for `wss://`. Cheaper per minute; it is a second piece of infrastructure to operate, and it inherits the `revokeTokenTs` gap above.

**If LiveKit is configured but unreachable** (verified against a server pointed at a dead port):

| Surface | Behaviour |
|---|---|
| `GET /api/voice/backend` | still answers `livekit` — it checks env, not reachability |
| `POST /api/voice/token` | **200 in 4ms**. Minting is local; it never talks to LiveKit, so a token is issued for an SFU that is not there |
| Client join | `connectLiveKit` rejects (or hangs). The client **leaves the call and reports it** — it never falls back to mesh. ~0.1s if the port refuses; capped at 12s by the join timer if the host black-holes, with the UI saying "Connecting…" the whole time |
| Moderation | ban still returns **200 in 16ms**; the eviction logs `[pqp] voice.sfuEvictFailed … stage=listRooms error=fetch failed` and does not block the request |

So the API never hangs, but voice on that deployment is *down*, loudly, rather than silently degraded into a split call. Getting the room back on mesh means unsetting `LIVEKIT_*` — a deployment-level decision, taken by the operator, that then applies to every new room.

## Verification status

Verified end-to-end on 2026-08-07 against `livekit/livekit-server:latest` (v1.13.5, `--dev`) via the compose profile, driving `client/src/lib/livekit-session.ts` in two headless Chromium instances with fake media devices, against the real server, real Postgres and real `/ws`:

| Claim | Status |
|---|---|
| `GET /api/voice/backend` advertises `livekit` | verified |
| Token grants / identity / metadata / 15-min TTL | verified (decoded) |
| Two participants join the room and exchange audio | verified — peak RMS ~0.31 in **both** directions |
| `setMuted` silences the far side and unmute restores it | verified (RMS 0 → 0.30) |
| Screen share publish/subscribe/unpublish | verified |
| Presenter cap (roster: 2 mesh / 4 LiveKit) | unit-tested; **media layer is not locked** — see above |
| Ban ejects from the live room | verified |
| Ban survives a rejoin on the pre-ban token | **was broken**, now verified fixed via re-sweep (`revokeTokenTs` is Cloud-only) |
| Banned user cannot mint a fresh token / re-enter over `/ws` | verified (403, no `welcome`) |
| `MESH_VOICE_LIMIT` does not apply with the SFU active | verified — 12 peers joined and all 12 minted tokens; the same 12 against a mesh-only server were cut off at 8 |
| Server switched to mesh under a client that expects an SFU | verified — token request answers a clean 503 |
| LiveKit configured but unreachable | verified — see the table above |

### Transport partition — verified fixed (2026-08-07)

Same rig, plus a second server on a mesh-only config and a third pointed at a black-holing LiveKit address. The browser cases drive the **real `use-voice.ts` and `realtime.ts`** (esbuild bundle of the shipped modules) in headless Chromium with `--use-fake-device-for-media-stream`, against the real server, real Postgres, real `/ws` and the real LiveKit container.

| Claim | Status |
|---|---|
| `welcome` and `voice-roster` state the room's transport | verified over a real socket |
| Mesh-only client refused from an SFU room with `voice-transport-unsupported` | verified — no `welcome`, no peer id |
| The refused client appears in **nobody's** roster — no `peer-joined`, absent from a fresh socket's snapshot, absent from the other participants' `occupancy` | verified |
| Refusal is distinguishable (not a disconnect, not `voice-room-full`) | verified — `transportFailure.reason === "unsupported"` in the browser, with copy that says they have not joined |
| Client whose SFU session fails at runtime leaves rather than building a mesh | verified in-browser — `status: idle`, `reason: "unreachable"`, `remotePeers: []`, and the incumbent's roster is unchanged |
| Black-holed LiveKit host | verified — "Connecting…" throughout, gives up at ~12s with `unreachable`, never claims a live call |
| Mesh signaling into an SFU room is dropped by the server | verified |
| A live room keeps its transport when the config flips under it | verified (unit, via a mocked config flip) |
| Empty room picks up new config on the next call | verified (unit) |
| Two SFU browsers still hear each other | verified — both `connected`, media subscribed |
| Two browsers on a **mesh-only** deployment still build a real peer connection | verified — both `connected`, no transport failure, no SFU |
| Legacy client with no `transports` field is still admitted | verified over a real socket |
| Mesh-only deployment: `welcome` says mesh, relay works, token endpoint 503s | verified |

Not verified, and knowingly so:

- **Against LiveKit Cloud.** Everything above is a self-hosted `--dev` server. In particular the `revokeTokenTs` behaviour is expected to differ (that is the point), and the re-sweep has not been observed against Cloud.
- **Multi-instance.** Two instances with different LiveKit config would still pin a channel differently. Reasoned through, not executed — it needs a second process and a shared room registry that does not exist.
- **Scale.** The `--dev` verification above was two to twelve participants on localhost. Since then the self-hosted box has been load-tested to 150 subscribers on one publisher and has carried a real watch party of over a hundred people (2026-09-05). Still no claim about cross-NAT paths or TURN interaction on the SFU path.
- **Real `getDisplayMedia`.** Headless Chromium cannot open the OS picker, so screen share was driven from a canvas capture. The publish/subscribe path is repo code and is verified; the capture call itself is browser API and is not.
- **Real network partition.** "LiveKit unreachable from one user only" was simulated by a session provider that throws and by a non-routable `LIVEKIT_URL`, not by a firewall between a real client and a real SFU.
