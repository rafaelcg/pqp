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

If the browser connects to the signal socket and then logs `could not establish pc connection`, LiveKit is advertising the container's own IP (`"nodeIP": "172.x.x.x"` in its startup line), which Docker Desktop on macOS does not route. Run it with `--node-ip <your LAN IP>` (seen 2026-09-06; `docker run ... livekit/livekit-server --dev --bind 0.0.0.0 --node-ip 192.168.x.x` with the same three port mappings works).

**How it works:**

1. Client joins the voice room over `/ws` and receives `welcome` with its `peerId`.
2. Client `POST /api/voice/token` `{ voiceChannelId, peerId }`.
3. Server verifies the peer is live, owned by the caller, and in that channel, then mints a LiveKit JWT (room = channel id, identity = `peerId`, metadata = `{ userId }`, 15 min TTL, publish/subscribe — covers mic and screen-share video alike).
4. Client connects to LiveKit and publishes the processed mic track; remote audio tracks are mapped back onto the same `RemotePeer[]` the mesh path produces. A screen share publishes a second track tagged `Track.Source.ScreenShare`, subscribed separately into `RemotePeer.screenStream`, and, when the capture came with sound, a third tagged `Track.Source.ScreenShareAudio` that lands in `RemotePeer.screenAudioStream`.

`livekit-client` is loaded via dynamic `import()`, so mesh deployments never download it (it is emitted as a separate ~530 kB chunk).

**Security:** the token endpoint refuses any `peerId` that is not a live voice peer belonging to the requesting user in the requested channel, so a caller cannot mint a token impersonating another participant.

### Speak permission (`Permission.SPEAK`)

The roles editor and the per-channel overwrite editor expose **Speak**. It is enforced, permissively: every existing role and channel already carries the bit, so nothing changes on deploy until an owner takes it away.

**How an owner makes a stage.** In the voice channel's permissions, set Speak to *Deny* for `@everyone` and to *Allow* for a moderator (or "speaker") role. Everyone else joins muted and cannot unmute; moderators talk. Owner and Administrator resolve to every bit, so they can never lock themselves out. The overwrite editor says this in one line under the Speak row.

**What is enforced where.**

| Path | Enforcement |
|---|---|
| Join (`ws/voice.ts`) | SPEAK is resolved with CONNECT (one query, with the channel's overwrites) and written into the peer. `welcome.canSpeak` and every roster entry's `canSpeak` carry it. A false value logs `voice.speakDenied` once per join. |
| SFU token (`POST /api/voice/token`) | The LiveKit grant is `canPublish = SPEAK`. Screen share and camera are publishes too, so a listener cannot present. `canSubscribe` stays true. The response carries `speak`. **This is the real enforcement:** LiveKit refuses the publish, so a modified client is still silent. |
| Live change | Every permissions bump (role edit, overwrite, role granted or removed) re-resolves SPEAK for everyone in that server's rooms (`reevaluateVoiceSpeak`, hooked on `onPermissionsUpdate`, local and cluster-relayed alike). A change sends `voice-speak-changed { canSpeak }` to that person and, on the SFU, rewrites their participant permission (`setSfuUserCanPublish`: mutes every published track, then `updateParticipant` with `canPublish`). A grant works without re-minting a token; the client publishes its mic as soon as it is told. |
| Roster claims | `set-sharing-screen` and `set-camera` are refused for a listener (`screen-share-denied` / `camera-denied`), and `set-voice-state` cannot show a listener as unmuted. |
| Client | Joins muted, the unmute is disabled ("Listening only. You do not have permission to speak in this channel."), share and camera buttons are not offered, push-to-talk does not open the mic, and a "Listen only" badge sits in the call bar. A mid-call grant unlocks the controls with a notice and leaves the person muted until they unmute. |

**The mesh caveat.** In a mesh room the audio never touches the server, so the server cannot silence anyone at the media layer. Dropping a listener's offer/answer frames is not an option either: those carry both directions, so it would also stop them *hearing*. Mesh enforcement is therefore client-side (the same gate that already keeps a muted mic muted), plus the roster refusals above. That is a real limit: a modified client in a mesh room can still send audio. Rooms where this matters are large, and large rooms are on LiveKit, where the SFU enforces it. `voice.speakDenied` in the logs says which transport a listener joined on.

Tests: `server/src/voice/backends.test.ts` (the grant), `server/src/voice/speak.test.ts` (the resolver), `server/src/voice/publish-grant.test.ts` (the live SFU update), `server/src/ws/voice-speak.test.ts` (welcome, roster, refusals, live change), `client/src/hooks/use-voice.test.ts` ("speak permission").

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
### Native clients

**iOS runs LiveKit rooms** (PR feat/ios-livekit). The app declares `transports: ["mesh", "livekit"]`, and on a `welcome` that says `livekit` it builds no peer connections: it `POST`s `/api/voice/token` for the peer id the welcome minted, connects a LiveKit `Room` (`client-sdk-swift` 2.16.0) to the returned URL, publishes the microphone, and subscribes to everybody's audio, camera and screen share. Participant identity is the peer id, so the roster, the mute badges and the tiles are keyed exactly as on the mesh. The failure semantics are the web's: token 5xx, a refusing SFU, or 45 s without a connected room leaves the WS room and shows the same "Could not reach the voice server" sentence, and it never builds a mesh instead. A `/ws` blip in a LiveKit room keeps the media: the app declares `resume` on an SFU deployment (read from `GET /api/voice/backend`), presents the `resumeToken` on the rejoin, and skips the media rebuild when `welcome.resumed` comes back for the same peer id.

What iOS does **not** do yet on LiveKit: publish a screen share. The ReplayKit broadcast bridge feeds the mesh's `RTCVideoSource` and is not armed in a LiveKit room, so the share button is hidden there. Receiving shares (video and `ScreenShareAudio`) works. The video quality ladder (`VideoQualitySettings`) is mesh-only too; LiveKit publishes at the SDK's defaults.

**Android is still mesh-only.** It declares `["mesh"]` and is refused from SFU rooms with `voice-transport-unsupported`, exactly as iOS was before this.

### What can still split a call

Two server instances with **different** LiveKit config pin the same channel differently, because `roomTransports` is per-process like `peers`. That is the same constraint that already makes mesh voice single-instance (see the block comment above `peers` in `server/src/ws/voice.ts`); nothing here fixes it, and nothing here makes it worse. The registry below is the start of the fix.

### The voice registry (`VOICE_REGISTRY=postgres`, off by default)

Milestones M1 and M2 of [`docs/plans/MULTI_INSTANCE_VOICE.md`](./plans/MULTI_INSTANCE_VOICE.md): the peer map and the transport pin, copied into Postgres so more than one API instance can agree on a room, and the roster read back from those rows. `server/src/voice/registry.ts` owns five tables (`voice_rooms`, `voice_peers`, `voice_retired_peers`, `voice_instances`, `voice_resweeps`), all additive and empty until the flag is on.

What changes with the flag on, and only then:

- **Write-through.** Every join, state change, socket loss, resume and leave in `ws/voice.ts` is copied to `voice_peers`. The in-process map still holds the sockets and is exact for the peers this instance serves.
- **The roster is the rows (M2).** `broadcastRoster` and `sendAllVoiceRosters` read `voice_peers` joined to `voice_rooms` (one indexed query per roster, still serialised per channel), with this instance's own peers laid over by id, so an audience socket here sees the people on the other machine too. `welcome.peers` lists the other instance's live peers the same way. A roster is never built from the rows before this instance's own pending write has landed.
- **Room events over the bus (M2, needs `CLUSTER_BUS=postgres` as well).** Three topics: `voice.room` (`joined` / `left` / `updated` / `roster`, published from inside the roster queue after the row write settled), `voice.identity` (a profile edit; the other instance relabels its own seats for that person and writes its own rows), `voice.watch` (the watch-party state). The receiving instance does the local half only: forwards the `peer-*` frame to its room peers, then rebuilds the roster from the rows. **Frames are hints, rows are truth**: a frame that was lost costs the other instance's sidebar a moment, never a ghost participant. With the registry on and the bus off the rows are still written and nothing crosses; with the bus on and the registry off no voice frame but `voice.hello` is published.
- **The watch party is a column (M2).** `voice_rooms.watch_party` and `watch_party_rev`. `applyWatchPartyWrite` keeps its in-memory coalescing, then the accepted state is written with the contract's ordering as the `WHERE` clause (higher `rev` wins, ties on `actorId`); a row not updated is a write that lost, and the writer is handed the row's winner alone, which is how a client that missed a frame is put back in step in one round trip. A joiner reads the row for the initial state. The columns are cleared on teardown and go with the room row when the last peer anywhere leaves.
- **One room, one transport, across instances.** An unpinned room's decision goes through `INSERT INTO voice_rooms ... ON CONFLICT DO NOTHING RETURNING` before it is applied. Whoever inserts first decides; the loser adopts the stored transport (`voice.transportAdopted` in the log) and a client that cannot run it is refused as usual. The last peer's delete removes the room row in the same statement.
- **`POST /api/voice/token` from any instance.** The request may carry the `resumeToken` that `welcome` minted; a valid HMAC proves `{ user, peer, channel }` with no lookup. Without it the route checks this instance's map, then the `voice_peers` row, then 403. A room another instance pinned to mesh still answers 409. Old clients that omit the field behave exactly as before.
- **Moderation and the operator snapshot see the cluster.** `findVoiceChannelForUser` and `findVoicePeerIdentities` read the map, then the rows, so the SFU eviction can target a participant whose socket is elsewhere; `getVoiceActivitySnapshot` counts rooms from the rows. The notice frame and the mesh half stay local until M4.
- **Retired ids are cluster-wide.** A hung-up peer id cannot be reconstructed on another instance, or on this one after a restart, for the token's life.
- **Liveness.** Each instance upserts `voice_instances` every 15 s (`config_hash` is a digest of the LiveKit URL and key id); a row older than 45 s is a dead instance. M3 gives that its consequences.
- **`voice.hello` on the bus.** With `CLUSTER_BUS=postgres`, an instance publishes its config hash once connected and requires its own echo within 5 s. Silence is logged loudly (`bus.selfEchoMissing`): it means `DATABASE_URL` is a transaction-mode pooler and LISTEN is not delivering. A foreign hello with a different hash logs `voice.configDrift`. Neither fails `/health` yet.

Flag off means off: `isVoiceRegistryEnabled()` is read on every path and every registry call sits behind it, so a self-host that never sets the variable runs the code that shipped before the registry existed. `server/src/ws/voice-registry.test.ts` pins that the tables stay empty through a join, a state change, an orphan and a leave with the flag off; `server/src/ws/voice-cluster.test.ts` runs two module graphs over one memory bus and one `pqp_test` database and pins what crosses, what does not, and that neither instance republishes what it heard.

**This is not yet enough to run two machines.** A peer whose instance dies is not reclaimed (M3), rings and moderation notices are local (M4), and there is no drain or mesh guard (M5). The flag exists so the write path and the roster path can soak on one machine first.

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
- **Scale.** Two to twelve participants, one room, one machine, all on localhost. No claim is made about a busy channel, cross-NAT paths, or TURN interaction on the SFU path.
- **Real `getDisplayMedia`.** Headless Chromium cannot open the OS picker, so screen share was driven from a canvas capture. The publish/subscribe path is repo code and is verified; the capture call itself is browser API and is not.
- **Real network partition.** "LiveKit unreachable from one user only" was simulated by a session provider that throws and by a non-routable `LIVEKIT_URL`, not by a firewall between a real client and a real SFU.
