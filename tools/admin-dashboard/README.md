# pqp-admin: the operator dashboard

One static page (`site/index.html`) and one small Cloudflare Worker
(`src/index.ts`) in front of it, deployed as the existing `pqp-admin` Worker at
`https://pqp-admin.rafaelcg-a0a.workers.dev/`.

A view of the hosted instance for the person running it, plus **two controls**
that write. It is not part of the product and it is not linked from anywhere.

## What it shows

A strip of **signals** sits directly under the header: one pill per thing that
can need attention, coloured by state, so a scan does not have to read every
figure below. They are in incident order: health, **capacity**, the **SFU**,
voice load, message volume, call quality, house-cast share, Android APK clicks
today. Capacity and the SFU sit high because they are the two that go red for
something nobody has complained about yet.
Under it, one line of provenance: which account kinds the numbers exclude, the
server's cache window (and that the capacity card sits outside it), and the
page's own refresh interval.

Then a **rail** on the left with six sections. The whole payload still arrives
in one read, so choosing a section is a pane toggle and never a request; the
choice lives in the URL hash, so a reload or a link to yourself opens where you
left off, and arrow keys move between them.

### Why a rail and five sections, and not seven tabs

The page used to have seven tabs across the top, and during an incident the
three things worth looking at lived on three different ones: capacity in
*infra*, the SFU in *voz*, the report queue in *moderação*. The fix was not a
better tab bar. It was to group by **the order the questions arrive** rather
than by which table the data came from, and to put the whole first question on
one screen.

| Section | The question it answers |
|---|---|
| **agora** | Is something on fire, and what is happening this minute |
| **ao longo do tempo** | What has been changing (the only part of the page with a memory) |
| **controles** | What can I turn on and off, right now, without a deploy |
| **pessoas e conteúdo** | Who showed up, who came back, what they wrote |
| **moderação** | What is queued |
| **infra** | What is deployed, where, and how available it has been |

The trade is deliberate and it is real: a browser now has to pick a section,
and wandering is one click slower than a tab bar was. In exchange, an incident
never needs a second click. **agora** carries, in this order: the three
verdicts, the health table with 24 h of latency, capacity right now, the SFU,
and the rooms that are open with the media path each one is using. If a change
would push one of those out of **agora**, it is the wrong change.

### The three verdicts

At the top of **agora**, three sentences with the figures that produced them.
Not more pills: a pill says *that* something is off, and every one of these
says *what to conclude*, which is the part an operator otherwise assembles by
hand from three cards.

| Verdict | What it decides |
|---|---|
| **the pool** | A burst absorbed, or the ceiling. A queue on its own is normal after every deploy (pg queues whenever it cannot hand over a connection in the same tick); a queue **with the pool full** is the wall, and only that is red. |
| **latency** | Each component against **its own** median, from `statusHistory`. 241 ms means nothing beside a database at 7 ms and everything beside storage's own p50 of 236 ms, so the usual reading is the reassuring one: the slowest thing on the page is slow on purpose. It alarms only when a reading is **both** a multiple of its own median (1,4x warns, 2x is bad) **and** above its own p95 — see below. |
| **voice** | Today's peak against the last seven days, and what the media server's own peak was. It never adds the three daily numbers: they are independent maxima over the same day, so `mesh + livekit` is not `participants`, and the sentence says so out loud. |

**Why the latency verdict needs two conditions.** The first reading this card
ever took against production nearly went red for nothing. The SFU probe is
bimodal — p50 33 ms, p95 235 ms, mostly fast with an occasional full cold round
trip — and it read 220 ms, which is 6,7x its median and would have alarmed,
while sitting *below* its p95: the component had already spent part of the day
up there. The ratio alone says "unusual for the middle of the distribution";
the p95 alone is crossed 5% of the time by definition and means nothing on its
own. Only the pair is worth waking somebody for, and a strip that cries wolf on
day one is worse than no strip. A reading that is high against the median and
still inside the band gets its own sentence saying exactly that.

They live in **fixed slots** and there are always three. A slot with no honest
verdict renders dashed and muted and says what is missing (no history yet, no
`runtime` block, fewer than two days of samples) rather than reaching for a
weaker claim.

The arithmetic is in `site/insights.js`: pure functions, no DOM, no fetch, and
`test/insights.test.js` runs against them in CI. That file exists because this
is the one part of the page where being wrong is *believed* rather than seen. A
wrong figure next to a label is visible; "storage está a 3x o normal dele" is
acted on. Each rule was broken on purpose and restored while the tests were
written, including the two claims these functions are forbidden from making: a
pool queue meaning exhaustion, and the three daily voice maxima being a split
of one another.

Under them, in a dashed box, **what stays raw and why**. There is no cost
reading anywhere on this page: no billing source, no R2 byte count, no SFU
minute count, so any number would be invented and would outlive every caveat
around it. What can honestly be said is headroom, and that is the capacity card
directly below. Retention is raw for the same reason: messages are the only
per-user activity this schema records, so somebody who reads without posting
counts as inactive.

### The health table

One row per component: what is probed, 24 h of latency, the reading now, that
component's own p50, and uptime. It replaced seven cards that said "nothing is
wrong" in the most expensive way a screen can say it, and that had nowhere to
put the shape over time.

Each row's sparkline is on **its own** scale, with that component's p50 as a
dashed baseline. A shared axis would flatten four rows into a line at the
bottom (7 ms next to 241 ms); the comparison that matters is each component
against its own past. A bucket with no samples is drawn as a gap, because a
stopped sampler and a steady latency must not draw the same picture. A bucket
with a failed probe gets a red tick, so an outage that healed inside the window
is not smoothed away by the mean of the good samples.

`/ready` and the host moved into the table's footer. Neither is a component
with a latency curve, and giving them tiles the same size as one made the row
read as nine equals.

### What is on each section

| Section | What is on it |
|---|---|
| **agora** | the three verdicts and the raw-numbers note, the health table (24 h latency per component, its own p50, uptime, with `/ready` and the host in the footer), **capacity right now** (open WebSockets and the Postgres pool, see below), **voz / sfu** (the media server, see below), and the rooms open *right now* with each one's media path, who is sharing a screen, and how long it has been open |
| **ao longo do tempo** | the six headline metrics with sparklines, the two 24-hour charts, and **quantas pessoas em chamada**, the one chart on this page with a memory (see below) |
| **pessoas e conteúdo** | who is actually active (24h and 7d), the returning-writer share, what people filled in (handle / avatar / banner / game account / age check), first-touch acquisition, game connections, text-vs-voice composition, the busiest text channels, the shape of the instance (direct and group conversations, private channels, channels that never received a message), the community directory (off by default, and it says so), the five most active servers, the full call-quality distribution with notes, and **apps e produto** (Android APK clicks + GitHub downloads, friendships, attachments, invites, push) |
| **moderação** | the report queue (open / actioned / dismissed / new today), bans, timeouts in force, and the feedback queue with the last eight entries. The rail carries a count badge when anything is open |
| **infra** | the deployed commit, region, database latency, worst-component uptime over 24h and 7d, and availability per component |

### controles: the only part of this page that writes

Two levers, and deliberately only two. Both existed before and neither could
be reached by the person running the event: one was a Fly environment
variable, the other was a column you changed with hand-written SQL against
production.

| Control | What it writes | When it takes effect |
|---|---|---|
| **watch party por servidor** | `servers.live_hls_enabled` | the next join, the next share, the next config read. No deploy, no restart, no socket closed |
| **caminho de mídia por canal** | `channels.voice_transport` | the next room that opens in that channel. A call already running is not moved |

Above them, **o que está no ar**: how many transcodes this process is running
(from `/metrics`, so it moves on the 30-second poll), and how many servers
have been decided either way (from `/operator/servers`).

**The three states of watch party availability**, and the sentence the row
shows for each, are in `docs/WATCH_PARTY.md` §"Widening it is a click now".
Short version: the column beats `LIVE_HLS_SERVER_ALLOWLIST` in both
directions, and **seguir a variável** clears it so the variable decides again.
`LIVE_HLS_ENABLED` is above all of it and is not on this page: it is the
master switch and it is a deploy either way.

**What a wrong click costs.**

| Click | Cost | Guarded |
|---|---|---|
| **ligar** a server | a host there can run a party; the SFU carries those bytes | no. One click to undo, and friction on a harmless control teaches people to click through the dialog on the harmful one |
| **desligar** a server with no party live | the create control goes away on the next page load | no |
| **desligar** a server **that is streaming right now** | the egress stops at the next reconcile and **the audience loses the picture** | **yes**, a confirmation naming the server. This is the only genuinely disruptive click here |
| **seguir a variável** | back to whatever the environment said | no |
| pin a channel to **ponto a ponto** | the next room there is peer-to-peer | no, except: |
| pin a **watch party** channel to **ponto a ponto** | the next party in that room has no stream at all, and nothing on the host's screen says why | **yes**, a confirmation |
| pin a channel to **servidor de mídia** | the next room there is on the SFU | no |

Nothing on this page deletes anything, and there is no account, ban or
moderation action on it. That is not an oversight: the machine token that
reaches these routes lives in a Cloudflare Worker behind an HTTP Basic
password, and `DELETE /api/admin/users/:id` is deliberately absent from
`ADMIN_MACHINE_ROUTES` (`server/src/api/index.ts`) for exactly that reason.
Terminating an account stays something a signed-in instance moderator does.

**Every write is audited.** `audit_log` is server-scoped and both of these
writes are about one server, so they land in that server's own log as
`server.live_hls_update` and `channel.voice_transport_update`, with the old
value and the new one in `changes`. The actor is **NULL** when the write came
from this dashboard (the machine token has no account, and the schema already
means NULL as "the system did it"); an instance moderator writing with their
own Clerk session is recorded by id. The server's owner sees the entry, which
is the point: it is a change to their server made from outside their staff.

**How the section behaves.** It does not ride the 30-second poll, because a list
that reshuffles under the cursor is how a wrong row gets clicked. It reads
when the section is opened, when you search, after every write, and when you
press **atualizar**. A write disables its own row until it answers, and the
row is redrawn from the API's reply rather than from what the page hoped, so
a write that silently failed cannot look like one that worked.

**One caveat the page states out loud.** Turning a server on does not make
the create button appear in a tab that is already open: the client caches
`GET /api/live-hls/config?serverId=` for the page's lifetime. The server-side
capability is immediate either way. Flip it before the host opens the channel,
or tell them to reload.

### The SFU card names the host, because a rollback is invisible otherwise

Production voice moved on 2026-09-05 from LiveKit Cloud to a self-hosted
LiveKit at `wss://sfu.pqp.gg` (a Vultr box in São Paulo). Pointing the API
back at LiveKit Cloud is one Fly secret and a restart, and **nothing in the
product looks different afterwards**: same calls, same client, same
`backend: "livekit"` everywhere else on this page. So the card states the
host in full and badges it:

| Badge | Means |
|---|---|
| **host esperado** (accent) | `sfu.pqp.gg`. The self-hosted box is serving. |
| **host inesperado** (red) | Some other host, LiveKit Cloud included. The card names the host and repeats what was expected. |
| **sem livekit · só mesh** (amber) | The API has no `LIVEKIT_URL` at all. Every call is peer-to-peer and the ~8-person mesh ceiling is back. |

Beside it: whether `listRooms` answered and how long it took, then the counts
**as the SFU reports them**: rooms, participants, largest room. Those come
from `RoomServiceClient.listRooms` on the API, cached 10 s there, so the
dashboard cannot hammer the SFU whatever its own poll rate is.

The counts exist only when the SFU answered. An unreachable SFU shows dashes,
never zeros: "0 salas" on an SFU nobody can reach reads as a quiet night
instead of as a blind spot.

**The room count is deliberately shown next to the API's own.** `salas abertas
agora` below it is this process's peer map; the SFU card is the SFU's own
count. When they disagree the card says so (`api diz 2 salas`), which is the
symptom of somebody being in a call on one side and not the other.

The same host rides on `/ready`'s `livekit` check (`{ ok, ms, host }`), so an
external monitor sees the rollback too, and in the health table's footer.
Hostname only, ever: never the API key or the secret. Every voice client is
already handed that host in its session token, so it is not a secret; it is
just not repeated anywhere it does not earn its place.

### The capacity card is the one live thing on the page

Every other number here is from the API's 30-second cache. The `runtime` block
is not: the API samples it on each request, because a *cached* queue length
reads as calm during the one event it exists to report.

It shows two things, and they are different kinds of number:

- **WebSockets open now**, plus the peak. Every signed-in client holds one for
  its whole session, so this is the closest thing the process has to "people
  connected". The peak is exact rather than sampled — the API measures it on
  every connection, and a maximum is always reached immediately after one opens.
- **The Postgres pool**: one block per connection it may hold (`PG_POOL_MAX`),
  filled by how many are checked out, amber from 80% and red the moment anything
  queues. Beside it: in use, **na fila**, and the peak queue length.

**`na fila` above zero is the earliest honest warning this system can give**:
nothing is broken, nothing is slow enough for anybody to complain, and requests
are already standing in line for a connection.

**It is not, on its own, proof that the pool is exhausted.** pg queues a request
whenever it cannot hand it a connection *in the same tick* — including while the
pool is still opening its first connections, which is every cold start. Measured
locally: a single `/api/admin/metrics` call against a fresh pool queues 14
requests even with `PG_POOL_MAX=40`, where there was never any shortage. So:

| Reading | Means |
|---|---|
| queue > 0, pool **not** full | amber. A burst the pool absorbed. Normal after a deploy. |
| queue > 0, pool **full** | red. The ceiling is the constraint. This is the wall. |
| `pico em uso` == `PG_POOL_MAX` | the wall was hit at some point since the card started counting, even if everything looks calm now. |

Red is reserved for that middle row, because a colour that appears on every
deploy stops being read.

The queue is deliberately not drawn as more blocks — it is unbounded, and 170
people waiting must not render as a wider bar that looks like more capacity.

The peak queue is observed at checkout (there is no event for *joining* the pool
queue), so it can sit slightly below the true instantaneous peak and can never
exceed it. Both peaks reset on deploy and at São Paulo midnight, and the card
says which by naming the time it has been counting from.

### The occupancy chart is the only thing here with a history

Everything else on this page is "agora" or "last 24 h", and the voice peak in
`/metrics` is a counter this process keeps in memory that every deploy resets.
So the evening after a spike there was nothing left to look at. **quantas
pessoas em chamada** is the persistence: a sampler on the API writes one row a
minute with how many people were in calls and which media path carried them,
rolls each reporting day up into peaks, and this card reads it back.

Three series, drawn as grouped columns and **never stacked**: `total`,
`servidor de mídia` (the LiveKit SFU) and `ponto a ponto` (mesh).

**On the 30-day view the three numbers do not add up, and the card says so.**
They are three independent maxima over the same day: the busiest minute for the
SFU is almost never the busiest minute overall, so `mesh + livekit` is not
`participants` and a stacked chart would draw a total nobody ever measured. The
daily rollup also has no per-path room split, so the room counts are only ever
reported for the day as a whole.

Clicking a column (or picking from the **ver um dia** select, which is the
keyboard way in) re-reads that one day at minute resolution and swaps the card
for three lines, with **voltar aos 30 dias** to come back. Minute points are
instantaneous samples rather than peaks, so on that view the total *is* the sum
of the two paths, and the note under the chart changes to say it.

Retention is asymmetric on purpose: **minute rows are kept 21 days**, which is
long enough to look back at the last few weekends, and the **daily peaks are
kept indefinitely** (365 rows a year).

The footer line is the part that matters when something is wrong. It renders
`lastSampleAt` as a relative time, and when that is null or older than five
minutes it says **amostrador parado** instead. A dead sampler and a quiet night
draw the same flat line, and this dashboard's whole rule is that working and
silently-not-working must not look identical.

### How often it reads, and how it says the reading is old

The page polls every **30 seconds**, which is the API's own cache window:
faster re-reads the same payload, slower throws away freshness the API is
already offering. A **hidden tab does not poll at all** (a phone left on this
page in a pocket used to call the API all night for nobody), and returning to
the tab reads immediately, so what an operator sees after unlocking a phone is
current rather than however old the last poll was. The **atualizar** button in
the header forces a read; a read already in flight is never started twice.

Age is stated in two places rather than left as arithmetic: the header says
`lido <stamp> · há N min`, and once the last good read is older than 75
seconds the live chip turns amber (`leitura parada`) and a banner says how old
the numbers on screen are. The numbers themselves stay: they were real, they
are just not now.

### Nothing on this page is illustrative

The page used to boot with a set of plausible seed numbers and swap them for
live ones once `/metrics` answered. Sections with no live source kept them and
were badged "dados representativos". **That is gone.** A plausible number on a
dashboard gets read as a real one, it survives a screenshot, and at a glance it
is indistinguishable from a stale reading.

What happens instead:

- **Before the first read:** skeletons. They draw the shape of the content and
  never a digit.
- **After a successful read:** real numbers only.
- **If the read fails:** an explicit failure box naming the reason, with a retry
  button. The skeletons stay. No figure appears anywhere on the page.
- **If a read fails *after* a good one:** the last real numbers stay on screen
  and the header chip says when they were read.
- **If the API answers without a block this page knows about** — the dashboard
  deploys in seconds and the API restarts every live call, so the two are
  deliberately not released together — that section hides itself and says the
  API is older than the field. It restores itself on the next poll once the
  field arrives; no reload needed.

Empty and off are also kept distinct from broken: "ninguém em chamada agora" is
a result, and a `COMMUNITIES_ENABLED` that is unset gets its own panel
explaining that the zeros mean the feature is off rather than unused.

### Sources

Live, from `GET https://api.pqp.gg/api/admin/metrics` (proxied as `/metrics`):

- **`runtime`**: open WebSockets and the connection pool (`max` / `total` /
  `idle` / `waiting`, plus `busy` and a `pressure` verdict), with peaks for
  sockets, queue and checked-out connections since `peakTrackedSince`. Sampled
  per request, not cached, and it costs nothing: every value is a property
  read, never a query
- users (total, new in 24h, new per hour, new per day over 14 days), servers
- messages in 24h and per hour, last hour, delta against the previous 24h,
  distinct senders, active text channels
- **automated messages in 24h** (webhooks + the house cast), drawn as a share
  of raw traffic beside the human count and never folded into it
- channel composition (text / voice / category / thread), plus the detail
  behind the canais tab: conversations, private channels, never-used channels,
  busiest channels
- user adoption and activity: handle / avatar / banner / age check, active over
  7 days, accounts in the art. 18 deletion window, and a returning-writer share
  over accounts older than 24 hours. **Messages are the only per-user activity
  this schema records**, so somebody who reads without posting counts as
  inactive; the pane says so rather than letting it read as retention
- **`sfu`**: the media server as the media server sees itself. `configured`,
  `host` (hostname only), `reachable`, `ms`, `failure`, and `rooms` /
  `participants` / `largestRoom` when it answered. Its own 10-second cache in
  `server/src/voice/sfu-stats.ts`, not the 30-second one, and concurrent
  callers share one probe: the API asks the SFU at most six times a minute no
  matter how many dashboards are open
- voice: rooms open now (with names, **which media path each is on**, how long
  it has been open, and who is screen-sharing), people in them,
  the largest room now against the practical mesh limit (amber past 6), and the
  largest room today (process-local; it resets on deploy and at São Paulo
  midnight)
- **call quality, last 7 days**: the full 1-to-5 distribution as bars, the
  average, the share that gave 4 or 5, the split by transport (mesh vs the
  LiveKit SFU, both always listed so "no SFU calls yet" is visible), and the
  notes people wrote, which the client only asks for on a 3 or less
- the five most active servers of the last 24h
- first-touch acquisition and landing pages
- **quem fica, por canal**: the same channels, judged on who stayed rather
  than who arrived. A 30-day signup cohort (excluding the last 24h, since
  those have not had a chance to return) against whether they posted in the
  last 7 days. Reading counts as absent here, the same limit the returning-
  writer share carries, so it is a tool for comparing channels and not for
  quoting a retention rate. Cohorts under 10 are greyed as a short sample.
- **game connections**: per provider, how many accounts linked Steam /
  Battle.net / Twitch and how many chose `public`, plus how many accounts linked
  *anything* — which is not the sum of the rows, since one person can link two
  providers. A provider with no credentials on the API is labelled **desligado**,
  because a zero there means nobody could link rather than nobody wanted to.
  Every share is over `connections.ofUsers`, which is `users.total` in the same
  payload: all human accounts that exist, not a window and not actives
- **communities**: totals, per category, and the listed communities with member,
  channel and message counts. Gated on `COMMUNITIES_ENABLED`
- **moderation**: report and feedback queues by status, bans, unexpired
  timeouts, and the last eight feedback bodies (truncated by the API, never
  attributed)
- the deployed API commit (`APP_VERSION`) and the excluded account kinds
- **product**: accepted friendships and open friend requests, claimed
  attachments (total and last 24h), invites created in 24h plus cumulative
  invite uses, and push subscriptions by platform (`web` / `apns`)

Live, from `GET https://api.pqp.gg/api/admin/voice-occupancy` (proxied as
`/occupancy`, same machine token, same 8 s timeout):

- **voice occupancy over time**, which is the one historical block on this
  page. `?days=30` gives one point per reporting day, each the **peak** of that
  day; `?day=YYYY-MM-DD` gives one point per minute of that day, **as sampled**.
  Every point carries `participants` / `mesh` / `livekit`, plus `rooms` and
  `largestRoom`. On daily points the three participant numbers are independent
  maxima and do not sum, and `meshRooms` / `livekitRooms` are always 0 (the
  rollup has no per-path room split), so the card does not draw them
- `lastSampleAt` rides along as proof the sampler is running. Null or older
  than five minutes and the card says the sampler looks stopped rather than
  drawing a flat line that reads as an empty night
- Read on a slower cadence than everything else: **once on load**, then at most
  every five minutes, whichever section is showing. It is read on load rather
  than on first sight of the chart because **agora** states today's peak
  against the last seven days, and that verdict has to be there before anybody
  clicks anything; it is the same endpoint the page already called, at the same
  once-per-five-minutes ceiling. **atualizar** in the header forces it. It is fired and never
  awaited, so a slow occupancy read cannot delay the numbers an incident is
  read from
- Server side: `server/src/services/voice-occupancy.ts`, retention 21 days at
  minute resolution and forever for the daily peaks

Live, from `GET /api/admin/servers` and `GET /api/admin/server-channels`
(proxied as `/operator/servers` and `/operator/channels`, same machine token),
and written back through `PUT /operator/server-live-hls` and
`PUT /operator/channel-transport`:

- **servers**, searched by name (`?q=`, `ILIKE`, 25 at a time): member count,
  watch party channels, the `live_hls_enabled` row, the **effective** answer
  and which of the three inputs produced it, and whether this process is
  running an egress for that server right now
- **a server's voice and watch party channels**: the `voice_transport`
  override, the transport this process has **pinned** for a room that is open,
  and what a room opening now **would** be pinned to plus the reason, computed
  by `resolveVoiceTransport`, the same function the join path calls, so the
  page cannot drift from what actually happens
- Server side: `server/src/services/operator.ts`, the route table in
  `server/src/api/index.ts`, tests in `server/src/api/operator.test.ts`

Live, from this Worker (merged onto `/metrics`, never stored on the API):

- **Android APK button clicks**: `POST /apk-click` from the hosted `/android`
  page, counted in KV, São Paulo day bucket. A click is a click, including
  people who never finish the install. Rate-limited per IP. The path is
  public on purpose; the *read* still needs the password.
- **Android APK downloads**: GitHub `download_count` on `pqp.apk` of the
  rolling `android-beta` prerelease, cached five minutes. That is the file
  leaving GitHub, so it can be lower or higher than clicks.

Live, from `GET https://api.pqp.gg/status.json` (proxied as `/health`): the
component health rows, the headline pill, database latency, and the 24h/7d
uptime behind the infra section.

**A component with no `latencyMs` was not measured, and is never drawn as
`0 ms`.** The row says what is known instead (`respondeu · sem medida própria`,
`no ar · sem sonda recente`), set in the text face rather than the figure face,
because a phrase set like a number reads as a number. `api` cannot time its own round trip from inside itself and never
carries the field; `voice` and `gifs` carry it only once their scheduled
reading has landed. A zero renders as an impossibly fast probe and is
indistinguishable at a glance from a real one, which is the bug this rule
exists to prevent. Say what is actually known instead.

Also on `/metrics`, and only there: **`statusHistory`**, 24 hours of latency per
component in 30-minute buckets plus that component's own p50 and p95. It draws
the sparkline on each health row and decides the latency verdict, and it is
what makes a number readable — 241 ms means nothing beside a database at 7 ms
and everything beside storage's own p50 of 236 ms. Deliberately not on
`/status.json`: a latency curve is a load curve, and the public page is allowed
to say only "up" and "how often".

`/ready` comes from the `ready` block of
`/metrics`: it is the verdict `GET https://api.pqp.gg/ready` gives UptimeRobot
(200 or 503), with the failing check named, the pool's in-use / max / queued
counts, and the SFU host and its probe latency. It can be red while every `/status.json` row is green, because
it also watches the pool over time (queued for more than 10 s, full for more
than 30 s), which is what the 2026-09-05 Postgres outage looked like from the
inside. See `docs/MONITORING.md`.

The page reads in both light and dark (it follows the system setting; every
colour is a token, so only the palette changes), and nothing scrolls the page
sideways on a phone: wide tables and charts scroll inside their own box, and the
tab bar scrolls rather than wrapping.

Webhook pseudo-accounts and character (house cast) accounts are excluded from
every user and message count, the same way the acquisition report excludes
them; their message volume is reported separately as `messages.automated24h`.

## Why it is behind a password

The repo is open source and a `workers.dev` hostname is guessable. The page is
aggregate counts and holds no id, handle or email, but it is not *only* counts:
the "most active" tables carry the **names of private servers and channels**,
and the call-rating notes and feedback entries are **free text people wrote**.
All of that is more than the public status page is ever allowed to say, and
since the **controles** section landed the password also guards two writes. So
the Worker gates the page, `/metrics`, `/occupancy`, `/health` and every
`/operator/*` route behind HTTP Basic Auth, compared in constant time, and
refuses to serve anything at all (503) while the password is unset. The
`/operator/*` routes are an exact (method, path) table in `src/index.ts`, not a
prefix: `POST` and `DELETE` on one of those paths are a 404, and every other
path stays GET-only as it always was. The one public path is
`POST /apk-click`: it increments a counter and cannot read one. Every response is
`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag:
noindex`, and `/robots.txt` disallows everything.

Recommended upgrade: put the Worker behind **Cloudflare Access** (free for up
to 50 users). Add an Access application for the `workers.dev` hostname (or a
custom hostname), allow your own email, and the login page replaces the Basic
prompt with a real identity check, MFA, and an audit log. Nothing in this
directory needs to change for that; keep the Basic Auth on as a second layer
or drop it once Access is in front. This is not configured yet.

## Secrets and variables

Nothing secret lives in this directory, in `wrangler.jsonc`, or in the HTML.

| Where | Name | Kind | What |
|---|---|---|---|
| Worker | `ADMIN_DASH_PASSWORD` | secret | Basic Auth password. Unset: the Worker serves nothing. |
| Worker | `ADMIN_DASH_USER` | var (in `wrangler.jsonc`) | Basic Auth username, default `operador`. |
| Worker | `ADMIN_METRICS_TOKEN` | secret | Bearer token sent to the API on `/metrics`, `/occupancy` and the four `/operator/*` routes. Never reaches the page. Since the controls landed it can WRITE two columns; what it can reach is the table in `server/src/api/index.ts`. |
| Worker | `API_ORIGIN` | var (in `wrangler.jsonc`) | `https://api.pqp.gg` |
| Worker | `APK_CLICKS` | KV | Click counter for `POST /apk-click`. Binding in `wrangler.jsonc`. |
| Worker | `GITHUB_REPO` | var | `rafaelcg/pqp` — release looked up for the APK download count. |
| API (Fly) | `ADMIN_METRICS_TOKEN` | secret | The same value. At least 16 characters or the API treats it as unset. |

Generate the token once (`openssl rand -hex 32`) and set it on both sides:

```bash
# Fly (the API). This restarts the machine.
fly secrets set ADMIN_METRICS_TOKEN=... -a pqp-api

# Worker
cd tools/admin-dashboard
npx wrangler secret put ADMIN_METRICS_TOKEN
npx wrangler secret put ADMIN_DASH_PASSWORD
```

An instance moderator (`INSTANCE_MODERATOR_CLERK_IDS`) can also read the same
endpoint with their own Clerk session; the token exists because the Worker has
no session. Everybody else gets a 404, the same answer as a route that does not
exist. Server side: `server/src/services/metrics.ts`, gate in
`server/src/api/index.ts`, tests in `server/src/api/metrics.test.ts`. The
counts are cached in memory for 30 seconds; the `runtime` block is not, and the
cache is typed as `Omit<AdminMetrics, "runtime">` so it cannot become so by
accident. The live values themselves come from `server/src/lib/runtime.ts`
(tested in `runtime.test.ts`), which nothing queries.

## Further UX work, in priority order

Not done, in the order worth doing. The list is about this page during an
incident, which is the only time it has to be good.

1. **Only voice has any history.** The occupancy card is the one block with a
   memory, and the health table now carries 24 h of latency per component. Two
   things still have none: `runtime` and `sfu`. An operator cannot tell a pool
   queue that has been climbing for ten minutes from one that appeared this
   second, which is exactly the question during the 2026-09-05 Postgres event.
   The page polls every 30 s and could keep its own in-memory ring of the last
   hour of both and draw a sparkline under each, with no API change and no
   storage. It resets on reload, which is honest and still enough.
2. **No alerting anywhere.** Somebody has to be looking at the page. A red
   verdict could at least become the tab title and the favicon (`(!) pqp
   admin`), so a dashboard left open in a background tab is worth something.
3. **The mobile layout still assumes a desk.** The rail collapses to a
   scrolling strip and the health table drops its chart column, but the wide
   tables (busiest channels, communities, acquisition) are still horizontal
   scrollers on a phone, which is a bad way to read a ranking. Under ~620 px
   they should stack into rows instead of scrolling.
4. **Colour is the only channel for state.** Green, amber and red carry every
   verdict on the page, with no icon or shape behind them. Adding a glyph to
   the amber and red states (and checking the palette against a deuteranopia
   simulator) costs nothing and would not need to be revisited.
5. **`aria-live` on nothing.** Numbers change under a screen reader with no
   announcement; the signals strip and the three verdicts are the regions that
   should be polite-live.
6. **The signals strip cannot be scanned in a fixed order.** Pills appear and
   vanish with the data behind them (`elenco da casa` and `apk` hide themselves
   when empty), so the SFU pill is not always in the same place. The three
   verdicts already have fixed slots; the strip above them does not.
7. **No visible tie to the runbook.** `docs/MONITORING.md` says what to do when
   `na fila` is climbing or the SFU is unreachable, and the page that shows
   those states does not link to it.

## Deploy

```bash
cd tools/admin-dashboard
npm install                     # wrangler + types, local only
npm run check                   # tsc over the Worker
npm run dry-run                 # bundles without deploying
npx wrangler deploy             # updates the existing pqp-admin Worker
```

`wrangler deploy` keeps secrets already set on the Worker; only `vars` in
`wrangler.jsonc` are overwritten. To run locally, put the two secrets in a
`.dev.vars` file here (git-ignored) and `npm run dev`.

Test the API side directly, with the token:

```bash
curl -s -H "Authorization: Bearer $ADMIN_METRICS_TOKEN" https://api.pqp.gg/api/admin/metrics | jq .
curl -s -H "Authorization: Bearer $ADMIN_METRICS_TOKEN" "https://api.pqp.gg/api/admin/voice-occupancy?days=30" | jq .
curl -s -H "Authorization: Bearer $ADMIN_METRICS_TOKEN" "https://api.pqp.gg/api/admin/servers?q=cine" | jq .
# without it: 404
```

To run the whole thing locally, including the writes: a local API with
`DEV_AUTH_BYPASS=true` and an `ADMIN_METRICS_TOKEN`, then

```bash
cd tools/admin-dashboard
npx wrangler dev --var API_ORIGIN:http://127.0.0.1:3001
```

with the two secrets in `.dev.vars` (git-ignored).

## Not in the pnpm workspace

Like `tools/ambient`, this directory has its own `package.json` and its own
`npm install`. The repo's root lint covers the TypeScript here; the repo's
typecheck and `pnpm test` do not, which is what `npm run check` is for.

The one exception is `site/insights.js`, whose tests **do** run in CI:

```bash
node --test tools/admin-dashboard/test/*.test.js
```

No dependencies and no runner: the module is a plain IIFE that assigns
`globalThis.PQPInsights`, so the page loads it with a `<script>` tag and the
test imports it for its side effect. Everything else on this page is markup and
rendering, which CI cannot judge; the verdicts are arithmetic that produces a
sentence somebody acts on, which it can.
