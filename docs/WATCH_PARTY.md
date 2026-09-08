# Watch party channels

A watch party used to be a button on any voice channel. It is now also a
channel of its own: created with a name like `cinemoon`, joined by everyone
as audience, with a stage only some people may take.

## The type

`channels.type = 'watch_party'`. Everything else about the row is a voice
channel: same columns, same overwrites, same voice room on `/ws`, same
transport decision (`server/src/voice/transport-policy.ts` looks at `kind`,
not `type`). `createChannelSchema` accepts it, and gained an optional `topic`
(max 200) so the create dialog can take a short description.

Shared helpers in `packages/shared/src/watch-party-channel.ts`:

| Name | What it answers |
|---|---|
| `isVoiceRoomChannelType(type)` | "does this channel open a voice room" (`voice` or `watch_party`). Use it instead of `type === "voice"`. |
| `isWatchPartyChannelType(type)` | just the new type |
| `canStartWatchPartyStream({ channelType, permissions })` | the ONE gate for the stage (below) |
| `liveStateFromRoster(participants)` | sidebar live state derived from the voice roster |
| `channelLiveStateSchema` / `ChannelLiveState` | the seam the HLS branch fills |

## The bit

`Permission.START_WATCH_PARTY` (bit 23, `8388608`). `PERMISSION_ALL` is now
`16777215`.

Defaults: Admin (ALL), Manager (ALL minus Administrator) and the seeded
Moderator hold it. `@everyone` does not, which is the whole point. Per-channel
overwrites apply like any other bit, so a server can hand the stage of one
channel to a guest with a member overwrite, or bench a mod on one channel with
a deny.

Backfill: `schema.sql` block `start_watch_party_bit_2026_09` (a one-shot on
`data_migrations`) ORs the bit onto every non-everyone role that already holds
MANAGE_CHANNELS, plus every `system_key = 'moderator'` role, and bumps
`permissions_version`. `pqp_ensure_staff_ladder` seeds the new masks for new
servers (Moderator `12927234`, Manager `16777207`).

## The gate

In a `watch_party` channel the stage asks for START_WATCH_PARTY. In a plain
voice channel it still asks for STREAM. Both go through
`canStartWatchPartyStream`, which is called from exactly two server places:

- `server/src/voice/speak.ts` `resolveVoicePublish`, which feeds the SFU
  token grant and the live re-check after a permissions change;
- the join in `server/src/ws/voice.ts`, which sets `peer.canStream`.

`set-sharing-screen` refuses on `peer.canStream` with `screen-share-denied`.
`set-camera` reads the same flag, so an audience member cannot turn a camera
on either (it is an audience). The client hides the share and Watch party
buttons when `welcome.canStream` is false, and shows the row's join button
(`Entrar`) to everyone.

Tests, each proven to fail with the check removed:
`packages/shared/src/watch-party-channel.test.ts` (admin yes, member no,
overwrite flips it), `server/src/ws/voice-watch-party.test.ts` (the same three
through the WS join and `set-sharing-screen`), and a case in
`server/src/voice/speak.test.ts`.

## The seam for the HLS branch

`fix/hls-watch-mode-loading` keeps live state in `hls-egress.ts` as
`LiveHlsStream { hlsUrl, startedAt, presenterPeerId, delaySeconds }` and
pushes it on a `voice-stream` message. `ChannelLiveState` uses the same field
names on purpose:

```ts
{ live, presenterPeerId, viewerCount, startedAt, hlsUrl }
```

On main it is derived from the roster (`liveStateFromRoster`: the peer with
`sharingScreen` is the presenter, `viewerCount` is everyone else,
`startedAt` and `hlsUrl` stay null). When that branch lands:

1. `reconcileLiveHls` / the HLS start must read `peer.canStream` (or call
   `canStartWatchPartyStream` with the same resolved bits). Do not add a
   second check keyed on `type`.
2. Build `ChannelLiveState` from the stream (`live: stream !== null`, copy
   `presenterPeerId`, `startedAt`, `hlsUrl`) and prefer it over the roster
   derivation. The `TODO(hls)` in `watch-party-channel.ts` marks the spot.
3. Nothing else changes: the type, the bit, the sidebar and the create flow
   are transport-agnostic.

Scheduling (built in parallel) attaches to the channel; the sidebar row has a
`TODO(schedule)` where the next session time goes in the idle state.

## Client flag

`VITE_WATCH_PARTY_CHANNELS=true` turns on the create affordance and the
distinct sidebar row (icon, description, pulsing `AO VIVO` pill with the
viewer count, off under `prefers-reduced-motion`). Default off: production
shows nothing new until Rafael flips it. With the flag off an existing
`watch_party` channel renders and joins as a plain voice channel. With the dev
auth bypass on, `?watchParty=1|0` latches the flag for that tab
(`client/src/lib/watch-party-channels.ts`). The snapshot's
`GET /api/live-hls/config` is not on main; when it is, this flag can follow
it the way Baú follows `/api/community-home/config`.

## Native apps

Both decode `type` as a plain string, so the new type never fails a parse.
This PR widened `isVoice` on both (`ios/pqp/Sources/Core/Models.swift`,
`android/.../core/Models.kt`) so a watch party lists as a voice room and joins
as audience; the server refuses their share claim like any other. Still to do
later, per app:

- iOS: a distinct icon and the `AO VIVO` pill (needs `sharingScreen` from the
  roster it already receives); hide the share control in a watch party unless
  `welcome.canStream`; the create sheet does not offer the type.
- Android: same three; also `WireProtocolTest` mirrors the shared enum and was
  updated here.
