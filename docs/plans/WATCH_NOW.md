# Watch now: a banner for a live stream, and (optional) a notice when it starts

Status: built behind two runtime flags, both **off**. Written before the code,
kept in step with it. Flags: `watch_now_banner`, `stream_start_notifications`
(`docs/FEATURE_FLAGS.md`).

## Evidence

2026-10-04, Filminho, a server made that day: 86 members, 78 of them accounts
created that night. The owner shared a film into a plain voice channel and 40
people sat in the call. The server's chat shows the whole problem. The invitees
land in `#general` and cannot tell where the movie is: "cadê o filme?", "como
que assiste?", "gente como entra na call", "onde que ta a tela do filme?", "sou
lerda", and one helper answering "canto superior direito, botão verde". They
also asked four times for a mobile app.

Nothing on screen in a text channel says "somebody in this server is showing
something, here is the way in". The information was already on every client (the
voice roster carries `sharingScreen`, a watch party is a `watch-party-update`
frame plus `channel-live`) and only the sidebar drew it.

## What ships

1. **Banner** in the conversation pane, above the transcript. Calm, one primary
   button.
2. **Newcomer landing**: an invitee who arrives into a server with a stream live
   sees the banner at once and, once ever, a hint through the existing
   onboarding queue. Nobody is joined into a call without a tap.
3. **Start-of-stream notice** (separate flag), decided on the server, with hard
   limits.
4. Two flags, a per-user per-server setting, counters, docs, tests.

Native iOS and Android are separate code and are not touched; the list of what
they would need is at the end.

## 1. The banner

### What it says

`Alberto está compartilhando a tela em #filminho · 38 assistindo · Assistir`

- Who: the sharer's display name (the roster's `displayName`; for a party, the
  host's `hostDisplayName`).
- Where: `#channel` (a watch party says its own name instead, `Cinemoon`, because
  its channel is an internal slug nobody should read).
- How long: `há 12 min`, **only when the start is known**: a party's
  `wentLiveAt`, a stream's `startedAt`, or a share this tab watched begin. A
  share that was already running when the tab loaded says nothing about its age,
  because "há 0 min" on a film that is an hour in is a lie, and a client-side
  guess is the thing this feature is not allowed to be.
- How many: people in the room besides the sharer, from the roster the client
  already has; for a party, `watching` from `channel-live` (which already prefers
  the server's `viewers` when `watch_party_server_audience` is on, through
  `watchersWithoutSeat`) plus the seated roster. Zero says nothing. **No new
  server write per viewer, no new frame, no poll.**
- One primary button, `Assistir`. One secondary, `Agora não`.

### Where it comes from (client only)

`lib/watch-now.ts` is a pure function over what the client holds:

- `voiceState.occupancy[channelId]` (full `voice-roster` / delta frames, which
  the server already sends to exactly the people who can VIEW that channel);
- the open server's `channels` (name, type);
- `watchParties.byChannel` and `voiceState.channelLive` for parties;
- `blockedUserIds`, `perms.can(CONNECT, channelId)`, the viewer's own id and
  call, and the set of streams this person dismissed.

A voice channel is a stream when somebody **other than the viewer** is
`sharingScreen` in it and that somebody is not blocked. A `watch_party` channel
is a stream only while its party is `live` (a share during setup is the host
rehearsing, not a show).

**Scope: the open server, and a conversation's own call.** The client holds
channel names for the server on screen and for nothing else (a roster frame
names a channel by id), so a stream in a server the person is not looking at is
not shown, plain share or party alike. That is the known gap (see "What is
left"), taken on purpose: a banner that has to say "somewhere in another server"
without a name is worse than none, and the first night's whole problem was one
server. It also keeps the flag honest: the strip in a server is governed by that
server's flag, never by another's.

### Who must not see it

- **No VIEW**: the roster is never sent to them (`getChannelAudience`), so there
  is nothing to derive from. This is why a private voice channel does not leak
  its existence: the banner is computed from frames the person already received.
- **No CONNECT** on that channel: dropped client-side before the list is built
  (`canConnectIn`, the same gate the sidebar uses), so a person who can view but
  not join is not offered a button that fails.
- **Blocked sharer**: dropped.
- **The sharer**: dropped (their own stream is not news to them).
- **What is on screen already**: a watch party whose channel is open (opening it is
  watching), a share in a voice channel once the person is SEATED in it, a
  conversation's call once joined. An open voice channel they have not joined stays
  on the strip: its lobby's join button asks for a microphone, `Assistir` does not.
- A party the person cannot see is never in `watchParties` (the server resolves
  visibility per recipient).

### The button

| Stream | Not in it | In it |
|---|---|---|
| Plain voice channel | `Assistir`: open the channel, take an **audience seat** (`audienceOnly`: no microphone, no permission prompt, no camera), via `guardVoiceJoin` | `Voltar pra transmissão`: open the channel, no join |
| Watch party | `Assistir`: open the party channel; watching **is** selecting it and takes no seat | same, label `Voltar pra transmissão` while seated |
| A conversation's call | `Assistir`: join the call as an audience seat (no ring) | `Voltar pra transmissão` |

An audience seat can become a speaking seat later by pressing the mic, which is
how an audience seat already works (`retakeSeatWithMicrophone`). A person who is
in another call and presses `Assistir` moves to this one; that is what a tap on
a channel row does already and the banner does not invent a second rule.

A full room or a locked channel: the join comes back as the existing
`voice-room-full` / refusal state, which the stage and the voice bar already
word. The banner shows "Entrando na transmissão" on the button while the join is
pending (15 s at most) and, when it fails, one line under itself with the reason
the voice layer already chose ("Não deu pra entrar na transmissão. Este canal de
voz está cheio (máximo 8)."), for 8 s, then returns to the idle button.

### Several streams

Ordered by size (people watching), then earliest known start (unknown last), then
name, so two clients show the same list.
The first is the headline; the rest collapse to `+2 transmissões` which opens a
small list (each row: who, where, `Assistir`). The list is a disclosure button
with `aria-expanded`; nothing else moves.

### Dismissal

`Agora não` hides that stream: key `channelId:sharerUserId` (a different person
starting a share in the same channel is a new stream). Remembered in
`sessionStorage` and pruned the moment the stream is not live any more, so the
next stream of the evening shows again.

### Ending

When the stream ends the banner collapses over `--duration-base` (grid-rows
transition) and unmounts; under `prefers-reduced-motion` it just goes.

### Accessibility

`<section aria-label="Transmissão ao vivo">` is the landmark. A separate visually
hidden `role="status"` (polite) announces only when the headline stream
**changes**: "Alberto começou a transmitir em #filminho". The viewer count and
the duration are in `aria-hidden` text so a ticking number never chatters. It is
never `role="alert"`. The button is a real `<button>`, 44px tall on a phone,
reachable in tab order directly after the header.

### Phone width

Stacks: line one who and where, line two count and age, the button full width,
`Agora não` as a text button beside it. No horizontal scroll.

### Placement

Under the channel header, after the schedule card, **before** the arrival strip,
in text channels, voice channels and conversations. In a conversation it is
that conversation's own call, gated by the deployment-wide flag (there is no
server to hold an override).

## 2. Newcomer landing

An invite link lands a person in the server's channel. The existing arrival
strip says "say oi in #general". When a stream is live the strip is the wrong
instruction (same reasoning as the live party, which already suppresses it), so
`renderArrivalBanner` yields to the banner: **one strip, not two**. The campaign
corner cards (QG, phone app, What's new, cargos, shortcuts) yield too
(`campaignsYield`, the rule a live party already has), because the first thing
a stranger is told must not be "join the QG".

The one-time hint is a `FeatureHint` (`watchNow`) in the attached queue, right
after the call dock in `ATTACHED_FEATURE_HINT_ORDER` because it is a moment, not
a state. Copy:
"Tem uma transmissão ao vivo, toque em Assistir". Shown at most once ever
(`lib/hints.ts`, key `pqp:feature-hint-watch-now-2026-10`), only to somebody
whose arrival into this server is the open one (`arrivalServerId`) or whose
account finished first-run in the last 24 h. Like every hint it never shows on
localhost or to Playwright; its rule is a pure function with a test, and its
screenshot is taken with the webdriver bit hidden.

It does not join anyone. The tap is the person's.

## 3. Start-of-stream notice

Off by default behind `stream_start_notifications` (per server). It exists
because a movie night is announced in a channel people may not be looking at,
and 40 of them were in the wrong one. It is also the feature that could page
thousands of people on every screen share, so the limits are the design.

### Who may be notified (all must hold)

| Rule | Where it is enforced |
|---|---|
| flag on for that server | server, at the start and again at fire time |
| the server has **at most 200 members and is not a community**, or the person opted in explicitly for it | server (`streamAlertDefault`, `streamAlerts[serverId]`) |
| a person who opted OUT (`streamAlerts[serverId] === false`) is never notified | server |
| not the sharer | server |
| not already in that voice room | server (room roster at fire time) |
| not on Do Not Disturb (`settings.status = dnd`) | server, and again on the client |
| the channel's resolved notification level is `all` (server muted or mentions-only means no) | server (`resolvePushLevel`) |
| neither blocks the other | server |
| can VIEW **and** CONNECT the channel (overwrites, private channels) | server, bulk, one pass |
| not the app focused in the foreground | client (a focused window already shows the banner) |
| OS notification permission already granted and the existing desktop-notification opt-in | client; **nothing prompts on load** |

A server above 200 members, and every community, notifies **nobody by default**:
only people who turned it on for that server (cap `STREAM_ALERT_MAX_RECIPIENTS`
= 500, counted when hit). QG do pqp (~4,000 members) therefore costs one indexed
count and one bounded query per stream start and tells no one who did not ask.

### When

- The start must be **stable for 20 s** (`STREAM_START_STABLE_MS`). A share that
  stops inside that window notifies nobody and is counted as `debounced`.
- At most **one notice per channel per 30 min** (`STREAM_START_CHANNEL_COOLDOWN_MS`).
  The slot is spent by the claim, so a notice that found nobody to tell (a large
  server where nobody opted in, everybody already in the room) still uses its 30
  minutes: the cap is a cap on interrupting, not on trying.
- A plain voice channel triggers on the false-to-true change of a peer's
  `sharingScreen` (a re-declare of a share already running is not a start). A
  `watch_party` channel triggers when its party goes `live`, not when somebody
  shares during setup. Conversations never trigger one (they ring).

### Exactly once, across both API machines

The sharer's socket lives on one machine, which holds the 20 s timer. The claim
that decides is one atomic SQL statement on `stream_alert_channels`
(`channel_id` primary key, `last_notified_at`), an upsert that only succeeds when
the last notice for that channel is older than the cooldown, so two machines that
both saw the share (a sharer who reconnected to the other one inside the window)
race on the row and exactly one wins. The winner decides the recipients once and
delivers to its own sockets, publishes `{ event, userIds }` on the cluster bus
(`stream-alert.deliver`, one retry, the shape of `channel-session.reminder`) so
every other machine delivers to **its** sockets, and sends push for people with no
live socket **from the originating machine only** (a phone gets one push).

Nothing is per socket on the hot path: the `set-sharing-screen` handler reads the
flag (an in-process snapshot) and arms a timer. The one walk over sockets is the
delivery, once per notice.

### What the notice says

`Alberto começou a transmitir em #filminho` / `Filminho · Assistir`. Names the
person can already see. No content. Click or tap opens the app on that channel
(a party: watching; a voice channel: its stage with the join button), **never
joins**. One live notification per channel (`tag`).

### Delivery paths

- connected clients: a `stream-started` frame. The client raises an OS
  notification (Electron `desktop.notify`, a web `Notification` where permission
  was already granted, the service worker on Android Chrome) only when the window
  is not the foreground, DND is off and the desktop-notification opt-in is on.
- no live socket anywhere: the existing push path (Web Push, APNs, FCM through
  `deliverToUsers`) with the same payload shape and the user's locale. TTL 60 s:
  a notice about a stream that started is not news an hour later.

### The setting

`notifications.streamAlerts[serverId]: boolean` in the preferences the client
already syncs (`NotificationState.streamAlerts`). Absent means the default above.
A check item in the server rail's context menu, "Avisar quando alguém
transmitir", shown only where the flag is on for that server.
`GET /api/servers/:id/stream-alerts` answers `{ flag, enabled, default,
memberCount }`; it is asked when a server's menu opens (never for every server at
boot, a deployment with the flag off pays nothing), so the menu shows the real
default without the client guessing a member count.

### Counters

`GET /api/admin/metrics` -> `streamAlerts`: `starts`, `flagOff`, `debounced`,
`cooldown`, `claimed`, `recipients`, `skipped.{sharer,inRoom,dnd,muted,blocked,noAccess,optedOut,overCap}`,
`delivered` (sockets), `relayed`, `pushed`, `failures`, `decisionMsMax`.

## 4. Flags

| Flag | Env | Default | Scope | Served as |
|---|---|---|---|---|
| `watch_now_banner` | `WATCH_NOW_BANNER` | off | per server | `watchNowBanner` on `GET /api/live-hls/config?serverId=` |
| `stream_start_notifications` | `STREAM_START_NOTIFICATIONS` | off | per server | `streamStartNotifications` on the same answer |

Both through the config route the client already reads per server and refreshes
on focus and every 10 minutes (`config-refresh.ts`), next to `fastStart` and
`cameraSync`. The deployment-wide answer carries the global value, which is what a
conversation (no server) reads. Turning on for one server first: `PUT
/api/admin/flag-overrides { key, serverId, enabled: true }` or controles ->
interruptores. `docs/FEATURE_FLAGS.md` has the exact line.

Risk notes (also on the dashboard): the banner is client-only and reversible in
one click; the notifications are the dangerous one, which is why they are
separate, off, and capped as above.

## 5. Tests

- `lib/watch-now.ts`: derivation (every exclusion above), ordering, dismissal and
  pruning, labels.
- Component test for the banner (states, keyboard, a11y roles, reduced motion).
- Server, real Postgres (`TEST_DATABASE_URL`): the recipient decision, the claim,
  the cooldown, the cap on a large server, two API instances racing one share.
- `flag-client-contract.test.ts`: the two new fields, served and read, and the
  `stream-started` frame handled by the client.
- Playwright, Chromium, two or three dev users (`pqp:dev-user-suffix`): A shares
  a fake screen in a voice channel, B in `#general` sees the banner, taps
  Assistir and ends up in the room with the microphone off. Plus ends-stream,
  private channel, hide, several streams.

## What is left, and what the native apps need

Not done: streams in a server the person is not looking at (the client has no
channel names for it; a small `GET /api/me/live-streams` or a name on the
roster frame would do it); the banner on the Baú home; a sound.

Native iOS and Android, not touched here:

- read `watchNowBanner` / `streamStartNotifications` from
  `GET /api/live-hls/config?serverId=`;
- derive the same list from the `voice-roster` frames they already parse, and show
  the strip above the channel (rules in section 1);
- `Assistir` = open the channel and join with no microphone (the iOS and Android
  join must not open the microphone prompt for an audience seat; a party is just
  opening the channel);
- handle `stream-started` and the push payload (`path` is
  `/app/server/:id/channel/:id`); a tap opens the channel, never joins;
- the per-server toggle on `notifications.streamAlerts`.
