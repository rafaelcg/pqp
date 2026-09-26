# Runtime feature flags

Switches that used to need an env edit and a container recreate are now flipped
live from the operator dashboard (**controles → interruptores**), with no deploy
and no restart. Code: `server/src/lib/flags.ts`.

## Precedence

For `isEnabled(key, { serverId })`, first match wins:

1. **Per-server override** (`feature_flag_overrides`), only for flags whose
   registry entry says `perServer: true`.
2. **Global row** (`feature_flags.enabled`, when not NULL).
3. **Environment variable**, parsed exactly the way its old reader parsed it
   (same words, same case sensitivity).
4. **Code default.**

With no row, steps 3 and 4 are the whole answer, which is byte for byte what the
switch did before this existed. "Seguir a variável" on the dashboard writes NULL,
which returns to that.

## Adding a flag

One entry in `FEATURE_FLAGS` in `server/src/lib/flags.ts`:

```ts
my_switch: {
  description: "Uma linha pro painel.",
  env: "MY_SWITCH",               // the variable that stays the default
  parseEnv: exactTrue,            // or onUnlessOff, or words({ on, off })
  codeDefault: false,             // or "bound" + bindFlagDefault(key, fn)
  perServer: false,               // true only if EVERY reader knows the server
  clientVia: "GET /api/…/config", // optional, shown on the dashboard
},
```

then replace the env read with `isEnabled("my_switch")`. The key is the variable
in lower case. The write routes only parse registered keys, so nothing else can
be flipped. Add a line to the old-reader table in `flags.test.ts`.

A flag whose client needs to know goes out through the config endpoint that
already carries that feature (`/api/live-hls/config`, `/api/community-home/config`,
the waitlist state). The web client asks those again on focus and every 10 min
(`client/src/lib/config-refresh.ts`, at most once per 2 min). Mobile picks the
change up on its next config read.

## Caching and the cluster

Reads are synchronous: the whole table sits in one in-process snapshot.

- The instance that takes a write reloads before it answers.
- It then publishes `flags.changed` on the cluster bus (`CLUSTER_BUS=postgres`),
  and every sibling reloads as soon as the frame arrives, within milliseconds
  (proved with two real API processes in `flags-two-process.test.ts`).
- If the bus is off, the frame was dropped, or the process only publishes (the
  worker), a read that finds the snapshot older than `FEATURE_FLAGS_TTL_MS`
  (default 10 000) reloads in the background. A flip is then up to one TTL late.
- **Database down:** the last snapshot keeps answering, and reloads back off for
  a TTL. Before any snapshot has loaded, the environment answers.
- Before `startFeatureFlags()` (called at boot after `initDb`) nothing touches
  the database, so unit tests that set `process.env.X` behave as before.

## Operator surface

Machine-token routes (in `ADMIN_MACHINE_ROUTES`) and the same routes for an
instance moderator's session:

- `GET /api/admin/flags`: every flag with its effective value, where it came
  from, what the environment alone would say, the overrides, and the last 50
  flips.
- `PUT /api/admin/flags` `{ key, enabled: true | false | null }`
- `PUT /api/admin/flag-overrides` `{ key, serverId, enabled: true | false | null }`

Every change goes into `feature_flag_audit` (who, or "painel" for the machine
token, when, before and after). A write that changes nothing is not recorded.
`GET /api/admin/metrics` → `flags` has every value and source, flips since boot,
flips in the last 24 h per key, and cache health (`loads`, `loadFailures`,
`busInvalidations`, `ageMs`).

## Self-hosting

Nothing to do. Without a dashboard nobody writes a row, and every flag follows
its environment variable exactly as before. The three tables are created by
`schema.sql` on boot and stay empty.

## What is converted, and what deliberately is not

Converted (global unless noted): `WATCH_PARTY_WAITLIST` (per server),
`LIVE_HLS_CAMERA`, `LIVE_HLS_CAMERA_480`, `LIVE_HLS_VOICE_TRACK`,
`LIVE_HLS_MIC_ARCHIVE`, `LIVE_HLS_REAP_ORPHANS`, `HLS_SHARER_RESUME_HOLD`,
`LIVEKIT_REGION_REQUIRE_CAP`, `VOICE_MESH_RESUME_REQUIRES_CAP`,
`TURN_PREFER_STATIC`, `READ_CACHE`, `COMMUNITY_HOME_ENABLED`, `COMMUNITY_HOME_VIP_ENABLED`.

Staying environment-only, on purpose:

- **Boot-time wiring:** `CLUSTER_BUS`, `VOICE_REGISTRY`, `VOICE_REGISTRY_BATCH`,
  `WORKER_MODE`, `WS_COMPRESSION` (negotiated when the socket server is built),
  `PG_*`. Flipping these mid-process would leave half-built state.
- **`DB_BREAKER`:** the breaker guards the pool the flag store reads through. Its
  rollback must not depend on the database being reachable.
- **Auth and security gates:** `DEV_AUTH_BYPASS`, `LOAD_TEST_TOKEN`,
  `CHARACTER_ACCOUNTS_ENABLED`, `OUTGOING_WEBHOOKS_ALLOW_PRIVATE`,
  `LIVE_HLS_SIGNED_URLS`. A dashboard token must not be able to widen who can
  sign in or what is exposed.
- **`COMMUNITIES_ENABLED`:** changes the instance's legal category
  (`docs/CONTENT_SAFETY.md` §Communities). That should be a deliberate deploy,
  not a click.
- **Watch party master switches `LIVE_HLS_ENABLED` / `LIVE_HLS_LL`:** they need
  infrastructure configured beside them, and per-server availability is already
  live data (`servers.live_hls_enabled`, `servers.live_hls_ll_enabled`).
- **Anything that is not a boolean** (limits, URLs, allowlists, TTLs).

Per-server overrides exist only where every reader knows the server. The camera
switches, for example, are read by the egress side with no server in hand, so a
per-server value would make the config endpoint and the transcoder disagree.
