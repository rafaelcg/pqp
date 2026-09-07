# `server/scripts`

Operational scripts that are not part of the API. Nothing here is imported by
`src/`, and nothing here should ever be pointed at production.

| Script | What it is for |
|---|---|
| `load-fanout.ts` | The realtime load harness: what one machine costs to hold a big room. |
| `seed-qg.mjs`, `qg.config.mjs` | Seed the QG layout into a local database. |
| `grant-turma-1000.mjs` | One-off badge grant. |

---

## `load-fanout.ts` — the voice and chat fan-out harness

### Why this exists, and what the other load test does not answer

On 2026-09-05 a watch party plateaued at roughly 120 to 130 concurrent
participants. LiveKit was innocent: the Cloud dashboard shows a peak of 130
against a limit of 1000, and it never complained. The ceiling was our own join
path.

The load test written up in `docs/plans/SELF_HOSTED_LIVEKIT.md` §5 drives
`lk load-test` straight at the media server. It answers "can the SFU forward
this many tracks" and **bypasses every line of our own code**, so it could not
have found this, and did not. What broke was:

- one `join-voice-room` costing a handful of sequential database round trips,
  against a pool that was pinned at 25 of 25 with hundreds of statements queued;
- a roster fan-out whose frame is the size of the ROOM and whose audience is the
  size of the SERVER, so a 130-person call in a 508-member community wrote tens
  of megabytes a second of participant lists;
- the client giving up on a join it had not been welcomed into, which turned the
  plateau into a retry loop: LiveKit counted 552 unique participants in 41
  minutes for a room that held about 90.

So this harness drives the WebSocket the real client drives, with real accounts,
against a server with a realistic audience, and measures **time to join** and
**failure rate** as first-class numbers rather than throughput.

### Running it

The database is created and written to, so give it one of its own. Never point
it at production; read `docs/STAGING.md` before pointing it at staging, whose
database shares a Postgres cluster (and one `max_connections`) with production.

```bash
createdb pqp_load

# Let it spawn and manage the server.
DATABASE_URL=postgresql://$USER@localhost:5432/pqp_load \
  pnpm --filter @pqp/server exec tsx scripts/load-fanout.ts \
    --spawn --n 200 --voice 150 --seconds 30

# Or point it at a server you are already running.
pnpm --filter @pqp/server exec tsx scripts/load-fanout.ts \
  --url http://localhost:3001 --pid "$(lsof -ti:3001)" --n 200 --voice 150
```

| Flag | Default | Meaning |
|---|---|---|
| `--n` | 200 | Sockets to open. Each is a distinct account. |
| `--voice <k>` | all | Only the first k join the call; the rest are the **sidebar audience** — members who receive every roster without being in the room. Passing this also turns on the stampede phase. |
| `--seconds` | 30 | Length of the steady-state phase. |
| `--caps <list>` | all | Wire capabilities every socket declares at `auth`. `0` is the empty set — a client built before any of the delta frames — so a before/after comparison runs on one binary. A comma list (`--caps presence-delta`) isolates one, which is the only way to attribute a saving to the change that produced it. |
| `--json <path>` | — | Write the run's numbers for comparison. |
| `--db <url>` | `$DATABASE_URL` | Exact statement counts, when `pg_stat_statements` is installed. |
| `--msgs / --typing / --toggles / --churn / --views` | | Steady-state rates. |
| `--spawn` / `--url` + `--pid` | | Manage the server, or attach to one. |

### The two phases

**Stampede** (needs `--voice`). Every socket connects and does the SPA
bootstrap, then all `k` joins are sent in the same tick — a streamer saying
"entra aí". Reports time to join (p50/p95/p99/max), how many were never
welcomed, frames and bytes written per arrival, CPU, statements per join, and
whether every socket ended up holding the same roster the server holds.

**Steady state** (the original phase, unchanged). Messages, typing, mute
toggles, channel switches and voice join/leave churn at fixed rates, with a
per-frame-type breakdown of everything the server wrote.

### Exact database counts

`pg_stat_statements` is optional and off by default on a stock Postgres. With
it, the harness reports statements per join instead of nothing:

```sql
ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';
-- restart Postgres, then in the load database:
CREATE EXTENSION pg_stat_statements;
```

### The baseline this was built to prove

Local, Apple silicon, Postgres on the same machine, so the absolute latencies
are far better than a shared vCPU in `gru` and only the ratios travel. Two runs
of the same binary, `--n 400 --voice 300 --seconds 30`, differing only in
`--caps`:

| | whole rosters (`--caps 0`) | roster deltas |
|---|---|---|
| roster bytes, 30s steady state | 1767 MB | 147 MB |
| per socket | 148.3 KB/s | 12.3 KB/s |
| everything the server wrote | 2726 MB | 1104 MB |
| server CPU | 10.1% of one core | 9.5% |
| stampede: welcomed | 300/300 | 300/300 |
| stampede: time to join p95 | 182 ms | 181 ms |
| convergence | 400/400 sockets exact | 400/400 sockets exact |
| database, per join | 7 statements | 7 statements |

At `--n 200 --voice 150` the same comparison is 448 MB against 46 MB.

Two things that reading those numbers should not miss:

- **The stampede row is identical on purpose.** #260 already collapses a burst
  of joins into one roster, so a single instantaneous burst costs one frame
  either way. The deltas pay off in the SUSTAINED arrival stream that a watch
  party actually is, which is what the steady-state row measures.
- **`presence-update` is now the biggest thing this server writes** (846 MB of
  the 1104 MB above). The voice roster is no longer the wall; chat presence is.

### The second baseline: presence deltas

Same machine, same binary, `--caps` the only difference again. `presence-update`
is the same shape of problem the roster was — every viewer of a channel, to
every viewer of that channel — so it gets the same treatment and the same
convergence rule.

`--n 400 --voice 300 --seconds 30`:

| | roster deltas only | + presence deltas |
|---|---|---|
| presence bytes, 30s steady state | 845.4 MB | 49.4 MB (2.1 delta + 47.2 keyframe) |
| per socket | 71.0 KB/s | 4.2 KB/s |
| everything the server wrote | 1103.8 MB | 311.2 MB |
| per socket | 92.6 KB/s | 26.1 KB/s |
| server CPU | 10.5% of one core | 10.6% |
| stampede: time to join p95 | 227 ms | 212 ms |
| convergence | 400/400 exact, 0 gaps | 400/400 exact, 0 gaps |

`--n 800 --voice 600 --seconds 30`, which is where the curve rather than the
point becomes readable:

| | roster deltas only | + presence deltas |
|---|---|---|
| presence bytes | 2924.7 MB | 185.9 MB |
| everything the server wrote | 3652.0 MB | 922.2 MB |
| per socket | 153.2 KB/s | 38.7 KB/s |
| stampede: time to join p95 | 1949 ms | 1503 ms |
| convergence | 800/800 exact, 0 gaps | 800/800 exact, 0 gaps |

**Reading the curve.** Total outbound goes as roughly `N^1.72` before and
`N^1.57` after, because both frames are quadratic (a list of the room, to the
room) and shrinking the frame does not change that — it moves the constant, and
the constant is what the ceiling is made of. Fitting the two measured points on
each curve, the outbound rate that the "before" configuration reaches at ~360
concurrent is the rate the "after" configuration reaches at ~800. **So the
ceiling roughly doubles**, and the check is in the table: at 800 sockets the
after run writes 30.2 MB/s, which is what the before run wrote at ~360.

**What is now the biggest thing on the wire, and it is one thing, not two.**
Of the 922 MB above, `voice-roster` keyframes are 384.6 MB and
`presence-update` keyframes are 180.3 MB — **61% of everything the server
writes is now a periodic whole-list snapshot**, and both are dominated by the
copy sent to people who are NOT in the call and NOT the ones the list is about.
Deltas made the news cheap; the keyframe is the remaining cost, and its size is
the audience's problem rather than the room's.

### The third baseline: the room and the audience

A voice roster goes to everyone who can *see* the channel, so most of that
keyframe cost is paid on behalf of a sidebar badge rather than a call. The two
are not owed the same thing — a participant's roster is the signalling
allowlist, an audience member's is an icon — so the audience's whole-roster
interval is `ROSTER_AUDIENCE_KEYFRAME_MS` (30 s) against the room's
`ROSTER_KEYFRAME_MS` (10 s). **Neither is the delta rate; both keep receiving
every change as it happens.**

Measure it with a realistic audience: `--voice` well below `--n`, since a
community around a call is several times its size. `--n 800 --voice 200`:

| | one clock (10 s for everyone) | room 10 s / audience 30 s |
|---|---|---|
| `voice-roster` keyframes | 110.6 MB, 2400 frames | **48.6 MB, 1124 frames** |
| per socket | 4.6 KB/s | **2.0 KB/s** |
| everything the server wrote | 635.4 MB | 578.9 MB |
| convergence | 800/800 exact, 0 gaps | 800/800 exact, 0 gaps |

The frame count is the arithmetic made visible: 200 participants at three
keyframes each plus 600 watchers at one is 1200, against 800 × 3 = 2400. **The
saving scales with the audience fraction**, so a big community around a small
call gains more than this and a full room gains nothing, which is the correct
shape for it to have.

Total only moves 8.9% here, and the reason is worth knowing before reading too
much into it: this harness puts all 800 sockets in ONE text channel, so
`presence-update`'s list is 800 people and its keyframes (180.6 MB, unchanged
by this) are inflated relative to a real deployment where people are spread
across channels. The roster has no such spread — it goes to the whole server
whatever channel you are looking at — so in production the roster keyframe is a
much larger share of the wire than this table shows.
