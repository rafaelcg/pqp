# Music queue load harness

Two scripts, local only (they mint `dev-local-token:<suffix>` identities, so
`DEV_AUTH_BYPASS=true`). The numbers they produced are in `docs/MUSIC.md`.

## Link resolution against the real upstreams

```bash
node tools/music-load/resolve-load.mjs all      # or: cold | cached | burst | playlist | spotify | sustained
```

Creates a pool of 40 age-checked users (`POOL=`), then runs the scenarios
round-robin across them so the per-user limiter never decides the result.
What is measured is InnerTube and Spotify behaviour plus the upstream budget
in `server/src/services/music.ts`. `API=` overrides the base URL.

## Fan-out over the socket

```bash
cd server && cp ../tools/music-load/ws-load.mjs ./ws-load.tmp.mjs \
  && CHANNEL=<voice channel uuid> N=50 QUEUE=50 node ./ws-load.tmp.mjs; rm ./ws-load.tmp.mjs
```

Seats `N` sockets in one voice room (the writer is made an admin of the
server, the rest members), then one writer sends `set-music` at 1, 5 and 10
writes a second with a `QUEUE`-track queue while every socket times the echo.
Needs a LiveKit room to seat more than eight (`LIVEKIT_URL=ws://localhost:7880`
with the docker-compose dev keys), otherwise the room pins to mesh and stops at
eight. Run from `server/` so `ws` resolves. Bytes are reported before
`permessage-deflate`, which is on by default on `/ws`.
