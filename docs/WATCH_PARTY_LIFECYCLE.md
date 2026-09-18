# Watch party lifecycle: the state map

Three state machines run a watch party and **none of them is the other two**.
A party is live because somebody pressed Ir ao vivo. A picture exists because
somebody is sharing. A playlist exists because an egress wrote one. They
overlap most of the time, which is exactly why every incident this feature has
had came from one of them being read as another.

This is the map. `docs/WATCH_PARTY.md` is the feature; this is what is true at
any instant, who changes it, and what a viewer sees while it is.

Written after 2026-09-17, when a single channel produced a zombie session, a
restart for a party that was over, three red log lines for an ordinary
teardown, a `voice.hlsStarted` with no playlist, and a viewer tab stuck on
"reconnecting" for minutes with the truth sitting in the sidebar next to it.
The violated invariants are at the bottom.

---

## 1. The party session (`channel_sessions`)

| State | What it is | Who moves it | The sidebar card |
|---|---|---|---|
| `draft` | Being set up. Invisible to everyone but the host and co-hosts. | The host creating one. | "Montando. Toca pra continuar." (host only) |
| `scheduled` | Announced for a time. | The host. | The countdown card |
| `live` | On air. `went_live_at` stamped. | Ir ao vivo; the takeover (`Assumir`). | The live block, with the audience count |
| `ended` / `cancelled` | Over. | Encerrar, the no-show sweep (`pqp-worker`), the host-gone sweep. | Back to the create/pending card |

Two things read this state outside the panel itself:

- `watchPartyKnownOver(channelId)` (`server/src/ws/watch-party-live.ts`), an
  in-memory mark of what **this process** saw end. It fails open on purpose: a
  channel it knows nothing about transcodes exactly as it always did.
- `GET /api/channels/:id/live` answers `partyLive` beside `ended`, so a viewer
  whose stream has gone can be told which of the two silences it is.

**A party ending ends the broadcast, and does not touch the share.** It is a
voice room; people watch each other's screens in one. Only the broadcast to
people without a seat stops.

---

## 2. The HLS session (the ladder, `rooms` in `hls-egress.ts`)

One session is one `startedAt`, two or three rungs, optionally a camera rung
and a mic archive, and a row per rung in `hls_sessions`.

| State | In the code | What a viewer is told |
|---|---|---|
| **starting** | `startRoom` has published the room into `rooms` with `announced: false` and is waiting for the primary rung's first live playlist (up to 45 s, `PLAYLIST_WAIT_ATTEMPTS`) | **Nothing.** `liveHlsStreamFor` answers null while `announced` is false, so no `voice-stream` carries a URL that does not resolve yet |
| **live** | `announced: true`, the reconcile returned the stream, the push fanned it out | The player attaches; the live badge |
| **restarting** | An egress died, `scheduleRestart` is on the clock (2 s, 4 s, 8 s, capped 15 s; three inside five minutes) | The holding screen's `restarting` copy with its countdown; the client holds rather than hammering a 404ing playlist |
| **stopping** | `stopRoom(channelId, reason)`: rows ended, rungs stopped, archive stopped | `voice-stream` with `stream: null`, `channel-live` with `ended` |
| **ended** | Out of `rooms`; the rows carry `ended_at` | Same as above; retention collects the objects |
| **failed** | Three restarts inside the window: `failedUntil`, no new egress for five minutes or until the share stops | `stream: null`, and the player's own "A transmissão caiu" if it got there first |

**The LL substate.** A party may ask for low latency (`low_latency_requested`).
`resolveHlsModeForChannel` answers `ll` or `conventional` for the channel and
that answer is the fork: `ll` runs on `pqp-remuxd` (`llRooms`, `hls-remux.ts`)
and the ladder above is not started at all. A demotion (the remux box's own
watchdog) clears the request, ends the LL session and reconciles the channel
onto the conventional ladder, which is a **new** `startedAt` and a real
re-attach for every viewer. Both drivers produce a stream, and every read that
asks "what is playing here" has to ask both (`liveHlsStreamFor ?? llStreamFor`)
-- a lesson that cost eighteen minutes of a dead session being re-served on
2026-09-15.

### Who moves the HLS session

| Trigger | Where | Effect |
|---|---|---|
| Presenter starts sharing | `set-sharing-screen` -> `pushLiveHls` | `startRoom` |
| Roster event (join, leave, camera, mute) | `pushLiveHls` | Reconcile; usually a no-op |
| Sharer vanishes | `pickHlsSharer` finds nobody, 5 s grace (`HLS_NO_SHARER_GRACE_MS`) | `stopRoom("no-share")` |
| Presenter republishes their screen (new sid) | same-presenter branch | `stopRoom("screen-track-replaced")` then `startRoom` |
| Somebody else takes the share | `presenter-changed` | Stop, then start |
| Party ends | `noteWatchPartyState` -> the live listener -> `pushLiveHls` | `sharer` forced to null, so `stopRoom("no-share")`, with `voice.hlsPartyOver` naming it |
| An egress dies | the health monitor (10 s) | Drop a secondary rung, or end the session and `scheduleRestart` |
| A playlist stalls for 20 s | `rungHealth` | Same as a death, **plus** the rung is stopped: it is still transcoding |
| Mode flip / demotion | `sweepLlDemotions` -> `notifyChanged` | Stop one driver, start the other |
| API restart | `adoptRunningLiveHlsSession` on boot | The session is **adopted**, not restarted: the transcode never stopped, and the audience does not notice the deploy |
| Server allowlist turned off | `resolveLiveHlsForServer` per reconcile | `stopRoom("not-allowlisted")` |
| Presenter gone between the decision and the start | the presenter check, below | `voice.hlsStartCancelled`, no rung started |

---

## 3. What the viewer client shows

The player (`client/src/components/voice/hls-watch-player.tsx`) has its own
small machine, and `resolveHoldingScreenReason` (`client/src/lib/watch-holding-screen.ts`)
is the one place that maps it to words.

| Reason | When | Copy |
|---|---|---|
| `null` | A frame is playing | Nothing |
| `restarting` | `sequence-stuck` (playlist frozen 20 s) or `playlist-gone` (our own proxy answered 404/410) | "A transmissão reiniciou, volta em ~Ns" |
| `reconnecting` | Any other stall, or a fatal error | "A transmissão travou, reconectando" |
| `silent` | A playlist request 401'd inside the last 3 s (pitfall 16) | Nothing at all; it resolves itself |
| `over` | **The server was asked and said there is nothing live, and no party either** | "A sessão acabou" |
| `awaiting` | **Asked, nothing live, party still live** | "Esperando o apresentador voltar" |
| `dead` | The watchdog gave up (rebuild budget, or 8 reconnect checks) | "A transmissão caiu" plus a retry button |
| `buffering` / `unavailable` | A replay (`mode: "vod"`), which never uses the live vocabulary | Plain spinner / "a gravação não está mais disponível" |

`over` and `awaiting` come from `GET /api/channels/:id/live` answering
`stream: null` with `ended: true` -- a null the server **explicitly vouches
for**, never a failed query. They outrank every stall reason, because every
stall reason is an inference from the outside and this one is an answer.

**Coming back needs nothing pressed.** Two doors, deliberately: the `src` prop
(the server pushes `voice-stream` the moment a new session is announced) and
the player's own 20 s poll while it is showing `over`/`awaiting`. Either one
adopting a different `startedAt` clears the state and re-arms the watchdog.
And `WatchChannelStage` drops the dead player on `onSessionOver`, keyed to that
exact session, so the pane goes back to the party panel -- which owns "nothing
is on air" and the button that starts the next show.

---

## The invariants, and the five that broke on 2026-09-17

Channel `d5559e70`, the presenter and the viewer one person in two tabs.

1. **An HLS session is only ever started for somebody who is presenting NOW.**
   Broken: two `pushLiveHls` raced, the second still holding "party live,
   peer f408cf6a sharing" from before the party ended. It waited its turn in
   the reconcile queue and started a two-rung ladder at 19:20:47, 200 ms
   before that presenter's `voice.leave`. **Fixed** by asking the room again
   at each point a start commits -- `LiveHlsPresenterCheck`, registered by
   `ws/voice.ts`, read in `startRoom` before the track probe, after it, and
   after the readiness wait.

2. **A restart is for a live share.** Broken: those egresses died at 19:21:21
   on `track TR_... not found` and the monitor scheduled a restart for a party
   that had ended thirty-four seconds earlier. **Fixed**: `scheduleRestart`
   refuses when the presenter is gone, logs `voice.hlsRestartSkipped`, spends
   no restart budget, and tells the audience the stream is gone instead.

3. **A failed stop is a failure.** Broken: `egress with status EGRESS_COMPLETE
   cannot be stopped` is LiveKit agreeing with us, and it was logged three
   times as `voice.hlsStopFailed` for one ordinary teardown, and parked the id
   in the orphan backoff to be re-asked for an hour. **Fixed**:
   `egressAlreadyStopped` classifies it, `voice.hlsStopNoop` says so, and the
   backoff is cleared rather than grown.

4. **Nobody is told about a session that cannot be played.** Broken:
   `startRoom` publishes the room before its readiness probe, so for the 52.7 s
   that probe ran, every other reader -- `liveHlsStreamFor`, `GET /live`, the
   same-presenter branch of a concurrent reconcile -- could hand a viewer a
   playlist URL that did not exist. **Fixed**: `RoomHls.announced`, false until
   the primary rung's live playlist has been read once. `voice.hlsStarted` now
   carries `announced` beside `playlistReady`, so the line an operator greps
   says whether anybody was told.

5. **A viewer is never told something the server can contradict.** Broken: the
   tab sat on "A transmissão travou, reconectando" while the sidebar card next
   to it said the party was over, and would have gone on to "A transmissão
   caiu" -- a crash report for a show that simply finished. **Fixed**: the
   answer `reconnect()` was already fetching is believed, the watchdog stands
   down, and the two truthful states above appear with a slow poll behind them.

Two older ones this map exists to keep visible:

6. **A cap counts what it says it counts.** `LIVE_HLS_MAX_SESSIONS` is
   sessions, and a session is only a fixed number of processes while nothing
   leaks handlers (pitfall 15).

7. **Both drivers are drivers.** Anything that reads "what is playing on this
   channel" reads the conventional map AND the LL map, or an LL party's
   teardown is invisible (2026-09-15).
