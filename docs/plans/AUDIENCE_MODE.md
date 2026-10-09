# Audience mode (Modo plateia)

## Why

2026-10-04: a brand-new server ran a movie night in a plain voice channel with
40 people. The host asked in chat *"como eu muto só o alberto e abro o mic de
todo mundo?"*: he wanted everyone muted except the presenter. The only tool he
had was a SPEAK overwrite on the channel, and the server logged 146
`voice.speakDenied` lines across 70 of 71 people. That line is logged once per
**join** (rejoins included), not per unmute attempt, and it carried no reason;
the people behind it saw a locked mic with a generic "listen only" tooltip, and
nobody could ask for the floor.

Audience mode gives a host one tap that turns a running call into a stage:
only the people running the room speak, everyone else is told why on the mic
button itself, and the raised hand becomes the way to ask. The host lets a
person speak with one tap and takes it back with another.

## The decisions

### (a) A per-call state, not a channel setting

Audience mode belongs to **the call that is running**, not to the channel. It
lives with the room (`voice_rooms`), and the room's row is deleted when the
last seat (orphans held for resume included) leaves. So it ends by itself when
the call does.

A persistent channel setting was rejected for v1. The worst failure this
feature can have is a forgotten mute: a channel where nobody can talk, hours
later, in a call that has nothing to do with the movie night, and nobody in it
knows why or can undo it. A session cannot be forgotten: it dies with the call.
The host turns it on in one tap when the film starts; that is cheap enough that
a default buys little. If a default is ever wanted, it should be "start each
call in audience mode" (still a session, still cleared), never a standing
mute. Not in this PR.

Two tables, not two columns on `voice_rooms`:

```sql
voice_audience_mode     (channel_id PK -> voice_rooms ON DELETE CASCADE,
                         enabled_by UUID, enabled_at TIMESTAMPTZ)
voice_audience_speakers (channel_id -> voice_audience_mode ON DELETE CASCADE,
                         user_id UUID, granted_by UUID, granted_at TIMESTAMPTZ,
                         PRIMARY KEY (channel_id, user_id))
```

Separate tables because `ALTER TABLE voice_rooms ADD COLUMN` takes ACCESS
EXCLUSIVE on the hottest voice table on the deploy that ships it (pitfall 22),
and because the cascade chain then states the lifetime in the schema: the room
goes, the mode goes; the mode goes, every invitation goes.

With `VOICE_REGISTRY` off (one process, self-hosts) the same state is an
in-process map, which is the truth there. With the registry on the map is a
cache of the rows, cleared when this process holds no seat in the room, and
the rows are read on every join and every token mint.

**Who may turn it on:** anybody holding `MUTE_MEMBERS` or `MANAGE_CHANNELS` in
that channel (owner and Administrator resolve to every bit), who is seated in
the room. Not "the first speaker": in a new server the host is the owner, and
a rule based on who arrived first would hand the room to whoever clicked first.
**Who may turn it off:** the same bits, seated or not. Turning it off is the
safe direction and must be easy.

### (b) Who speaks while it is on

| Person | Mic | Camera / screen |
|---|---|---|
| **Stage**: holds `MUTE_MEMBERS` or `MANAGE_CHANNELS` in the channel (owner and admins included) | as their permissions say | as their permissions say |
| **Invited**: a host tapped "Liberar o microfone" for them in this session | as their permissions say | no |
| **Audience**: everyone else | no | no |

One rule makes this safe to reason about: **audience mode only ever takes
away.** It never grants `SPEAK` or `STREAM` to anybody who does not already
hold it. A channel overwrite that denies SPEAK still denies it to an invited
person. The resolver is `applyAudienceMode` in `server/src/voice/audience.ts`,
and it is applied in exactly the one place the answer already comes from
(`resolveVoicePublish`, plus the join path which resolves the same bits from
the same row).

Camera and screen share are stage-only: a movie night where a member's camera
or share can take over the picture is not a stage. An invitation is for the
microphone. Moderators keep everything, which means a moderator can never
silence another moderator with this tool (that is what the server mute is for,
with its outrank check).

An invitation is keyed on the person, like a raised hand: it survives a socket
blip and a refresh inside the resume window, and it is dropped when the person
holds no seat in the room any more, or when audience mode is turned off.
Granting speak also lowers that person's hand (they have been called on).

No outrank check on the toggle or on an invitation, deliberately. Neither is a
sanction: stage holders are never affected, so the only people it touches are
ones without a moderation bit, and the host is running the room the way
lowering a hand is. The server mute keeps its outrank check.

### (c) Enforcement is server-side

| Path | What happens |
|---|---|
| Join (`join-voice-room`) | the bits are resolved with CONNECT and then `applyAudienceMode` with the room's state read from the row. `welcome.canSpeak`, `welcome.canStream`, the roster entry and the new `welcome.speakReason` all say it. |
| Resume (reattach, reconstruct, adopt) | same code path as the join: the welcome carries the grant as it is NOW, so a mode switched on during the gap arrives with the resume. A reattach keeps its LiveKit connection; its SFU permission was already rewritten by the room pass below, which never depended on the socket. |
| Token mint (`POST /api/voice/token`) | `resolveVoicePublish` reads the room's state (row with the registry on), so a re-minted token carries the audience grant. |
| A role or overwrite edit while it is on | `reevaluateVoiceSpeak` goes through the same resolver, so a permissions bump cannot reopen the audience's mics. |
| `set-voice-state` unmute | refused (muted stays true) because `canSpeak` is false; logged as `voice.unmuteRefused reason=audience`, rate limited per room. |
| `set-sharing-screen`, `set-camera` | refused because `canStream` is false (the existing refusal frames). |
| **Live toggle, LiveKit** | the instance that took the request asks the SFU for the room's participants and rewrites every participant whose permission differs from the target (`reconcileSfuRoomPublishGrants` in `voice/admin.ts`): mute the tracks they may no longer publish, then `updateParticipant`. It is region-routed through `targetsFor` like every other admin call (the room's pinned box, Miami or London included), and **a revoke's first pass asks every box** (`wide`), known boxes as pinned and the rest as one-shots, because a participant whose WebSocket dropped can still be on a box the room is no longer pinned to. It reads the SFU, not this process's map (pitfall 19): a seat held on the other machine, an orphan in its resume window and a participant whose socket died are all in the SFU's list. |
| Live toggle, every instance | the row is written first, then `voice.audience` goes on the bus, then each instance re-resolves its own seats in that room, sends `voice-speak-changed` (with `speakReason`) and a `voice-audience` frame to its own sockets, and rewrites its seat rows. A missed frame is caught by the 15 s sweep and by the next join, which read the row. |
| **Mesh** | there is no media server to refuse a publish. The server pins `muted`, the speaker's own client locks its mic, and **every receiving client silences a peer whose roster entry says `canSpeak: false`** (new in this PR, the same trust boundary as a server mute on mesh). A modified sender is heard only by a modified receiver, and a tab that has not reloaded onto this bundle does not silence. Mesh rooms are at most 8 people and are usually small private servers; large rooms are on LiveKit, where the SFU enforces it. The host's answer says `transport: "mesh"`, and the doc (`docs/voice-backends.md`) says so. |

### (d) Fail-safe

The two failure directions are not symmetric, and each path picks the one that
cannot strand a room:

- **The toggle's write fails** (database down): 503, nothing changes, the host
  sees an error on the control. No half state.
- **A read fails** (join, token mint): this process's cached state answers
  when it holds one; with nothing cached it does not guess "off", the read's
  error goes to the caller, which refuses the same way it refuses when the
  permission read beside it fails (the token mint answers 503, a join is
  retried). Logged as `voice.registryReadFailed op=audience`. Only reached
  where the flag is on for the server.
- **A permission resolution fails for one seat while it is on**: that seat is
  locked as audience until the next pass (+3 s, +10 s, the sweep) resolves
  it; on a mesh room nothing else would stop it. At the SFU the same person
  is reported as failed and retried, never counted as enforced.
- **The SFU update fails or times out for somebody**: the HTTP answer carries
  `enforcement: { pending: [userIds], unreachable }`, the room state carries
  `unenforcedUserIds`, and the host's control shows "N microfones ainda
  abertos" with the names, instead of claiming it worked. Retry: the pass runs
  again at +3 s and +10 s, and then every 15 s while the mode is on (the
  sweep), each time only touching participants whose permission is still
  wrong, so a repeat is cheap. A pass that succeeds clears the warning for
  everybody. `voice.audienceMode.enforceFailed` logs which box and why;
  `voice.audienceMode.enforceFailures` counts it.
- **The OFF direction has a backstop too.** Turning it off leaves no row for
  the sweep to find, so a restore the SFU refused is remembered per room
  (`audienceRestorePending`) and retried on every sweep until a pass comes back
  clean, with no deadline (an unreachable box costs one call per sweep;
  giving up would be choosing to leave people silenced). Without it, a box blip during the off would leave people
  revoked at the SFU while everything else says they may talk.
- **A slow pass cannot overwrite a newer change.** Every change bumps a
  per-room generation; a pass that started before it stops rewriting anybody
  it resolves afterwards, and the newer change's own passes do the work.
- **Honest receivers silence anyone whose roster says they cannot speak**, on
  both transports, so an SFU update that has not landed yet is still not heard
  by any client on this bundle.

### (e) Audience UX

- The mic button, for a person whose `speakReason` is `audience`, is disabled
  with the reason as its label ("Modo plateia: só quem apresenta fala"), never
  a silent no-op. A person locked by a channel permission is told that instead
  ("Você não tem permissão pra falar neste canal"), which is what the 70 people
  on 2026-10-04 never saw.
- A persistent badge "Modo plateia" sits in the call bar while it is on.
- The raise-hand button becomes the primary control for the audience (signal
  colour, labelled "Pedir pra falar" when the hand is down).
- When a host lets you speak, `voice-speak-changed` unlocks the mic with a
  notice; you stay muted until you unmute.

**The host leaving.** The mode persists while any stage person (MUTE_MEMBERS or
MANAGE_CHANNELS) holds a seat, orphans in their resume window included. When
the last one goes, nobody left can turn it off, so it turns itself off and the
room is told ("Modo plateia desligou: ninguém da staff ficou na call"). The
check runs on every departure from a room in audience mode (debounced per
room) and on the 15 s sweep, and it reads the registry, not this process's
map.

### (f) Host UX

- One control in the call controls, "Modo plateia", a toggle with
  `aria-pressed`, no confirm. Its pressed state is the visible ON.
- Its tooltip says what it does: "Silenciar todo mundo menos a staff e quem
  você liberar".
- The raised-hand queue, while it is on, gives a host one tap per person:
  "Liberar o microfone" for somebody in the audience, "Silenciar" for somebody
  already invited. On the collapsed strip (most calls have no picture) the
  first hand in the queue gets the button inline.
- The sidebar occupant right-click gets the same two items.
- Every change is announced to everyone in the call with a short transient
  notice ("Fulano ligou o modo plateia", "Modo plateia desligado").

### (g) Moderation, audit and counters

- Audit: `channel.voice_audience_on` and `channel.voice_audience_off`, written
  for a person's explicit toggle. An automatic off (room emptied, no stage
  left, flag off) is not audited: nobody did it. Invitations are not audited,
  for the reason lowering a hand is not: it is the ordinary running of a room.
- `GET /api/admin/metrics` -> `voice.audienceMode`: `enabled` (the flag's
  global answer), `activeRooms` (this process), `sessionsStarted`,
  `sessionsEnded` by reason (`host`, `no-host`, `flag-off`, `room-empty`),
  `speakersGranted`, `speakersRevoked`, `enforcePasses`, `enforceUpdates`,
  `enforceFailures`, `unmuteRefused`, and `speakDenied` by reason.
- Logs that say why: `voice.speakDenied` now carries `reason`
  (`permission` | `audience`) and is rate limited to one line per room per
  minute with `suppressed=N` (pitfall 16). `voice.unmuteRefused` is new, same
  limit. `voice.audienceMode.on|off|speaker|enforced|enforceFailed`.

### (h) Interactions

- **Watch party channels**: refused (`400`). A watch party already has a stage
  model (presenter, co-hosts, guests, a seatless audience) and this does not
  change it. Audience mode is for plain `voice` channels.
- **DMs and group calls**: not applicable (no roles, no moderators); refused.
- **Screen share**: stage only while it is on (an invitation is the mic).
- **Slow mode**: text only, unaffected.
- **The join-muted rule** (SPEAK per channel): composes by AND. Audience mode
  never grants SPEAK, so a channel that denies SPEAK to `@everyone` stays that
  way for invited people; a host who wants hand-raise-and-invite should leave
  SPEAK on and use audience mode instead, which is exactly what 2026-10-04
  needed.
- **Server mute**: still outranks an invitation.
- **Music**: unaffected (`MANAGE_MUSIC` is its own bit).
- **Promotion to the SFU**: unaffected. A camera refused by audience mode never
  asks for a promotion.

### (i) The runtime flag

`audience_mode` (`AUDIENCE_MODE`), **per server**, default **off**, served by
`GET /api/voice/config?serverId=` as `audienceMode`. The flag gates turning it
**on**. Turning it off is always allowed. When the flag reads off for a server,
the 15 s sweep switches off every live session on that server (reason
`flag-off`): the flag is also the kill switch, with no deploy.

Turn it on for one server: dashboard, controles -> interruptores ->
`audience_mode` -> the server's override, or
`PUT /api/admin/flag-overrides { key: "audience_mode", serverId, enabled: true }`.
Open tabs pick it up on focus or within 10 minutes (`config-refresh.ts`).

## Wire

- `welcome.speakReason?: "permission" | "audience"` and
  `welcome.audience?: VoiceAudienceState | null`.
- `voice-speak-changed.speakReason?`.
- New `voice-audience { voiceChannelId, audience, change? }`, where
  `audience = { since, byUserId, speakerUserIds, unenforcedUserIds }` or null,
  and `change = { kind: "on" | "off" | "speaker-added" | "speaker-removed",
  byUserId, userId?, reason? }`.
- `PUT /api/channels/:channelId/voice-audience { enabled }` and
  `PUT /api/channels/:channelId/voice-audience/speakers/:userId { allowed }`,
  both answering `{ audience, enforcement }`.
- `GET /api/voice/config?serverId=` -> `{ audienceMode }`.

Every field is optional on the wire: an older client ignores it and still gets
the locked mic it already understood.

## Native clients (not changed here)

iOS and Android already obey `canSpeak: false` on `welcome` and
`voice-speak-changed` (the mic locks, and on LiveKit the SFU refuses the
publish anyway), so the enforcement reaches them today. What they need:

1. Read `speakReason` and show the audience copy on the mic control.
2. Handle `voice-audience` (badge, the transient notice).
3. Make the raise-hand button primary while locked by audience mode.
4. Host controls: the toggle and "Liberar o microfone" / "Silenciar" (the two
   HTTP routes above), behind `GET /api/voice/config?serverId=`.
5. Mesh receivers: silence a peer whose roster says `canSpeak: false`.

## Edge cases

- Toggled on while somebody is mid-join: their token may have been minted
  before the row was written. The +3 s and +10 s passes and the 15 s sweep
  list the SFU's participants again and fix it; receivers silence them from
  the roster meanwhile.
- A replayed old token (minted with a mic before the mode went on, or before
  a "Silenciar"): an SFU token lives `TOKEN_TTL_SECONDS` (15 minutes), and a
  modified client can reconnect to LiveKit with it. The participant is then in
  the SFU's list, so the next pass rewrites its permission: the bound is about
  15 s per reconnect (the sweep), repeatable until the token expires. Web
  receivers on this bundle do not play it meanwhile, because the roster still
  says `canSpeak: false` for that seat; older tabs and native receivers do.
  Closing it fully needs a LiveKit `participant_joined` webhook, which this
  repo does not receive today; not added here.
- A moderator who is only on a phone keeps the room "staffed" (the stage
  check counts them), but the phones have no audience mode control yet, so
  they cannot turn it off from there. The web or desktop app can, and so can
  the operator's flag.
- Two hosts toggling at once: the row is the arbiter (insert on conflict does
  nothing; delete is idempotent), and each pass computes the grant from the
  row, so both converge.
- A host on machine A turns it on while the room's seats are on machine B: the
  SFU pass is A's and covers everybody; B re-resolves its own seats from the
  bus frame or, if it missed it, from the sweep and the next join.
- The room is region-pinned to Miami or London: the pass goes to that box (and
  on a revoke's first pass to every box).
- Database blip while it is on: reads answer from the cache where there is
  one and refuse where there is not (no grant is issued on a guess); the SFU
  permission already written stays written.
- Flag turned off mid-session: the sweep turns the session off within 15 s.
  With the registry on, a process holding seats reads the rows even when the
  flag is off everywhere, so rows left from before a restart are deleted
  rather than coming back live the day the flag is turned on again.
- A restart that forgot the mode (registry off) while the SFU kept a revoke:
  the first sweep after boot runs one restore check for every LiveKit room it
  seats in a flagged server, and a seat still marked as audience in a room
  with no row is restored by every sweep after that.

## Tests

| What | Where |
|---|---|
| the resolver: stage, invited, audience, never widens | `server/src/voice/audience.test.ts` |
| the SFU room pass: target grants, only mismatches touched, failures reported, regions | `server/src/voice/audience-sfu.test.ts` |
| one process: toggle on revokes a connected listener, off restores, resume, unmute refused with reason, role edit cannot reopen, failure seen and retried, no host left, flag off, watch party refused | `server/src/ws/voice-audience.test.ts` |
| two instances on real Postgres sharing the registry | `server/src/ws/voice-audience-cluster.test.ts` |
| HTTP routes, permissions, audit | `server/src/api/voice-audience.test.ts` |
| the flag and the client read the same field | `server/src/lib/flag-client-contract.test.ts` |
| three dev users, host toggles, refused with reason, hand, grant | `client/e2e/audience-mode.spec.ts` |
