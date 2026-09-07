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
| `--caps 0` | on | Make every socket look like a client built before roster deltas, so a before/after comparison runs on one binary. |
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
