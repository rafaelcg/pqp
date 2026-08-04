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

If the SFU session cannot be established (token error, server unreachable), the client logs a warning and **falls back to mesh** rather than leaving the user with no audio.

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

**How it works:**

1. Client joins the voice room over `/ws` and receives `welcome` with its `peerId`.
2. Client `POST /api/voice/token` `{ voiceChannelId, peerId }`.
3. Server verifies the peer is live, owned by the caller, and in that channel, then mints a LiveKit JWT (room = channel id, identity = `peerId`, 6h TTL, publish/subscribe — covers mic and screen-share video alike).
4. Client connects to LiveKit and publishes the processed mic track; remote audio tracks are mapped back onto the same `RemotePeer[]` the mesh path produces. A screen share publishes a second track tagged `Track.Source.ScreenShare`, subscribed separately into `RemotePeer.screenStream`.

`livekit-client` is loaded via dynamic `import()`, so mesh deployments never download it (it is emitted as a separate ~530 kB chunk).

**Security:** the token endpoint refuses any `peerId` that is not a live voice peer belonging to the requesting user in the requested channel, so a caller cannot mint a token impersonating another participant.

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

## Not yet verified

The LiveKit path is **built and typechecked but has not been run against a live LiveKit server**. Token minting is verified (signature, grants, identity, TTL); the browser-side join/publish/subscribe flow needs a real end-to-end test — bring up the compose profile and join a voice channel from two clients.
