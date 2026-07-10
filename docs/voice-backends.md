# Voice backends (Phase 5)

pqp abstracts voice transport behind `VoiceBackend`. The channel UX stays identical; only the media path changes.

## Current: mesh (default)

- Full peer-to-peer WebRTC per voice channel
- Signaling over existing WebSocket
- ~5–8 users per channel
- TURN for NAT traversal (`VITE_TURN_*`)

## Hosted: Cloudflare Realtime SFU

**When:** pqp.gg production, voice channels with 8+ users.

**Why Cloudflare:**
- $0.05/GB egress, 1 TB/mo free (shared with TURN)
- Global edge, no SFU servers to operate
- TURN free when paired with SFU

**Config:**
```
VITE_VOICE_BACKEND=cloudflare-sfu
CLOUDFLARE_REALTIME_APP_ID=...
CLOUDFLARE_REALTIME_APP_SECRET=...
```

**Status:** Client stub in [`client/src/lib/voice-backend.ts`](../client/src/lib/voice-backend.ts) — falls back to mesh until SFU adapter is implemented.

**Security:** WebRTC media is DTLS-encrypted end-to-end; Cloudflare relays encrypted packets only.

## Self-host: LiveKit

**When:** Docker/Railway self-host deployments needing 8+ voice users.

**Why LiveKit:**
- Open-source media server
- Same stack devs already use for OSS realtime
- Runs in Compose alongside the Node app

**Config:**
```
VITE_VOICE_BACKEND=livekit
LIVEKIT_URL=wss://livekit.yourdomain.com
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

Add a `livekit` service to `docker-compose.yml` when implementing.

**Status:** Stub — falls back to mesh.

## Implementation checklist (future PR)

- [ ] Cloudflare Realtime session API on server
- [ ] Client SFU join/leave using Cloudflare SDK
- [ ] LiveKit token endpoint on server
- [ ] LiveKit client SDK integration
- [ ] Compose recipe with LiveKit container
