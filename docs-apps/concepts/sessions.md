# Sessions and participants

A **session** is one running copy of an app in one channel. This page is what you can rely on about who is in it, what is shared, and what happens when things go wrong.

## One session per channel

A channel has at most one live app session at a time (the database enforces it). The person who starts it is the **session host**: they hold `isHost: true`, and they are the one who may call `app.end()`. Starting does not seat them; they join like everyone else, and the launcher does that for them at once.

Starting needs the `USE_APPS` permission in that channel (and `MANAGE_CHANNELS` too if your manifest says `requires.start: "MANAGE_CHANNELS"`). Joining needs `VIEW_CHANNEL`, plus `CONNECT` in a voice channel. A session **pins the app version that was current when it started**: a new release never changes an app under people who are in it.

## Seats and participants

Each person in a session has one **seat**, however many tabs they have open. A seat has:

| Field | |
|---|---|
| `seatId` | 16 to 32 random characters. Yours alone, for this session. The only identifier you ever see. |
| `displayName` | What they are called, cleaned of control and bidirectional characters, at most 64 characters, never empty. |
| `avatar` | A `data:image/...` URL the page already fetched, or `null`. |
| `role` | `player`, or `spectator`. |
| `isHost` | Whether they started the session (or took over, below). |
| `connection` | `present`, or `reconnecting` while their seat is held. |
| `appUserId` | Only with `identity: "user-id"` and only for people who consented. |

`app.participants.get()` returns the list, and `app.participants.on` fires with the whole new list every time anybody joins, leaves, drops or returns (at most about four times a second).

**Players and spectators.** Up to `players.max` people are players. More become spectators if the manifest allows them and there is room; otherwise the join is refused with `full`. Somebody who is timed out in the channel joins as a spectator. Spectators see everything and **write nothing and send nothing**: their state writes and events get `not-allowed`.

**Resuming.** If somebody's connection drops, their seat is held for **90 seconds**: they stay on the roster as `reconnecting`, and when they come back they get the same `seatId` and role. Leaving on purpose releases the seat at once, and coming back after that gives them the same `seatId` but not their old place. In your UI, show `reconnecting` people differently, do not remove them.

## Shared state

The session has one JSON value, at most `state.maxBytes` (never above 16 KB), and a revision number `rev` that goes up by one with every change.

- **Read it** with `app.state.get()` (`{ rev, value }`). Listen with `app.state.on`. It fires with the **whole** value each time, not a diff.
- **Write it** with `app.state.patch(patch, { baseRev? })`. The patch is a [JSON Merge Patch (RFC 7396)](https://www.rfc-editor.org/rfc/rfc7396): an object merges key by key, `null` deletes a key, and a non-object replaces the value. `{ players: { a: { ready: true } } }` changes one nested key and nothing else.
- **Who may write** is `state.writers`: `participants` (players and the session host) or `host` only.
- **`baseRev`** turns the write into a compare-and-set: if the state has moved on, it fails with `stale-rev` and nothing is written. Use it for read-modify-write, such as a counter. Do not use it for writes to your own key (a vote under your seat id) where nobody else touches the same key: those merge safely without it.
- **Rate.** At most `state.maxWritesPerSecond` writes a second from one machine. Patches inside the same window are applied one after another into one write and one revision bump, so the last value wins and nothing composes inexactly. A patch that changes nothing writes nothing.
- **Size.** The cap is on the compact serialized bytes of the **merged** value, so a patch that makes the whole thing too big is refused with `too-large` even if the patch itself is small. A string with a NUL character (`\u0000`) is refused.

**The state is gone when the session ends.** See [What an app can keep](/concepts/storage), including the one thing you can leave behind.

### Design for the merge

Think of the state as a small document that several people edit at once. Two habits make that painless:

- **One key per person for what they alone change.** A vote is `votes[seatId] = ...`, and the patch `{ votes: { [me]: 3 } }` touches only your key, so two people voting at the same instant never overwrite each other and no `baseRev` is needed. Enquete, the live poll, works exactly like this.
- **`baseRev` for what everybody changes together.** A shared counter, a turn pointer, a "game over" flag.

## Events

`app.events.send(name, data)` sends an **ephemeral** message to the other people in the session: a ping, a cursor position, a "I raised my hand". It is relayed to the other seats on every server machine, never stored, never logged (only counters). `name` is lowercase letters, digits, dots and dashes; `data` is any JSON up to `events.maxBytes`. There is a per-person rate limit, and a spectator sends none. An event is delivered to the **others**; do not rely on getting your own back, show the effect locally when `send` resolves.

Use events for things that matter only now. Use state for anything a person who joins in a minute needs to see.

## When the host goes

`hostBound: true` in the manifest means the session's truth lives on the session host's machine (an emulator, for instance). If the session host stays gone past the grace period (2 minutes in the current schema), the session **ends**. With `hostBound: false`, the session host role passes to another seat instead, and `app.hello.self.isHost` and `participants` update.

## How it ends

`app.on("ended", reason)` tells you why. After it, every call rejects with `ended`.

| Reason | |
|---|---|
| `host` | The session host ended it. |
| `moderator` | Somebody with MANAGE_CHANNELS in the channel. |
| `operator` | A pqp operator. |
| `idle` | Nothing happened for too long. |
| `host-gone` | A host-bound session lost its host. |
| `empty` | Everybody left (the sweep waits 5 minutes after the last person). |
| `max-duration` | The session ran as long as one may. |
| `app-disabled`, `flag-off` | The app or the apps platform was switched off. |
| `channel-gone` | The channel was deleted. |

Ended sessions are deleted after 30 days.

Next: [what an app can keep](/concepts/storage).
