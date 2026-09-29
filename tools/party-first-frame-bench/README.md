# party-first-frame-bench

Local A/B of a watch party viewer's time to first frame, with and without the
`party_fast_start` flag (`docs/WATCH_PARTY.md` §"Fast first frame").

The numbers are **modelled**, not measured against production: the HLS origin
is a local mock serving ffmpeg-generated test media, and the network is a
Chrome DevTools throttle profile (`wifi` 50 Mbit/20 ms, `4g` 8 Mbit/60 ms,
`3g-fast` 1.6 Mbit/150 ms). What it can say is which requests compete and how
much each one costs. It cannot say what a real egress, a real edge or a real
phone would add.

```bash
# 1. a TEMPORARY database, never DATABASE_URL
psql -c "CREATE DATABASE pqp_bench"
# 2. an API on 3151 (dev bypass, raised rate limits, no seed)
PORT=3151 DATABASE_URL=postgresql://.../pqp_bench DEV_AUTH_BYPASS=true DEV_SEED=false \
  RATE_LIMIT_API_CAPACITY=100000 RATE_LIMIT_API_REFILL=10000 \
  RATE_LIMIT_WRITE_CAPACITY=100000 RATE_LIMIT_WRITE_REFILL=10000 \
  pnpm --filter @pqp/server exec tsx src/index.ts
# 3. a production build pointing at it (hls.js is a lazy chunk only there)
cd client && VITE_DEV_AUTH_BYPASS=true VITE_API_URL=http://localhost:3151 \
  VITE_WS_URL=ws://localhost:3151/ws pnpm exec vite build --outDir /tmp/pqp-bench-dist
# 4. run
DIST=/tmp/pqp-bench-dist RUNS=3 LADDER=three,single node tools/party-first-frame-bench/bench.mjs
```

The flag is flipped per run by rewriting `GET /api/live-hls/config` in the
page, so one build serves both arms. Fresh browser context per run.

Knobs: `PROFILES`, `LADDER` (`three` = 720p/480p/360p, `single` = 720p only, the
shape an LL master has), `RUNS`, `SERVICE_WORKERS=allow` with `RELOAD=1` (a
service-worker-controlled page, which is what somebody who came through a
sign-up redirect has), `BLOCK_FILM=1` (aborts the bubbles film in the flag-off
arm, to attribute the difference).

Drop the database and stop the API when done.
