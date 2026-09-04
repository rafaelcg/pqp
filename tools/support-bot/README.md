# `tools/support-bot` — the QG support bot

Answers product questions in the **QG do pqp**, from `facts.md` and from nothing
else, **only when somebody explicitly addresses it**, and says it does not know
the rest of the time.

**Nothing here has been deployed, provisioned or run against production.**

## The one thing to understand first

This is **not** an ambient persona and must never become one. The owner's
ruling is that the QG does not get AI residents, and `server/scripts/qg.config.mjs`
records the reasoning. A support bot is a different thing **only if it is built
as a different thing**, which here means three properties that are structural
rather than configured:

1. **It is permanently disclosed.** The account is minted with
   `disclosureLabel("bot")`, so it is called `manual [bot]`, reachable as `@manual_bot`. There is no flag
   to turn that off. `scripts/provision.mjs` has no argument for it.
2. **It answers "é um bot?" plainly**, from a sentence a person wrote, never
   from the model. See the disclosure seam below.
3. **It never speaks unprompted.** No schedule, no ambient chatter, no reacting
   to things nobody asked it about. Every post is a reply to a message somebody
   sent: an explicit mention, a reply to one of its own messages, or (the one
   case that is not a question) a newcomer's hello in the greeting channel,
   answered with a line a human wrote. See "Answering a newcomer's hello"
   below; it is the only thing the bot does that nobody typed its name for,
   and it is still a reply, never an announcement.

## Layout

| Path | What it is |
|---|---|
| `facts.md` | **The whole content surface.** Everything the bot may assert. A human maintains it; editing it changes the answers with no deploy. |
| `src/facts.js` | Loads it, refuses a broken one at boot, and harvests the measurement vocabulary the screen grounds against. |
| `src/trigger.js` | Should it answer at all: addressed, allowed channel, not a loop, inside the rate caps. Pure. |
| `src/answer.js` | The prompt, the `NAO_SEI` sentinel, and the three sentences that are never generated. Pure. |
| `src/screen.js` | The outbound screen. The last thing between a generated answer and a public channel. Pure. |
| `src/budget.js` | The daily ceiling, on disk, so a crash loop cannot reset it. |
| `src/generate.js` | One question, one model call. Or a fixture under `--canned`. |
| `src/socket.js` | The reconnect. The one place this bot's socket policy differs from the ambient cast's, and why. |
| `src/heartbeat.js` | One line every five minutes saying whether it is actually connected. |
| `src/greetings.js` | Answering a newcomer's hello: the greeting matcher, the member roster on disk, the once-per-person and flood rules. Pure. |
| `src/greetings-pool.js` | **Copy, not logic.** The lines the bot answers a hello with. A human edits it; the bot picks one. |
| `src/bot.js` | The only file that touches the network, the clock or the disk. |
| `scripts/provision.mjs` | Mint / rotate / revoke the one character account. **Not yet run.** |
| `scripts/fake-pqp.mjs` | A fixture pqp server that can drop a socket on demand. Reproduces the 2026-08-23 outage. |

## Why a sibling of `tools/ambient` and not a mode inside it

They share plumbing and share nothing else. The full argument is at the top of
`src/bot.js`; the short version:

- `qg.config.mjs` says in writing that keeping the QG out of `personas.yaml` is
  the safest way to stop somebody adding a cast to it by editing the wrong
  block. A mode inside the ambient runner puts the QG back in that file's blast
  radius.
- The ambient runner's core loop is a **scheduler for speaking unprompted**.
  This bot must never speak unprompted, so sharing one would mean maintaining
  "this cadence must never apply to that account" forever.
- Their defaults are opposites: the cast never discloses and improvises
  everything; this account always discloses and improvises nothing.
- They need separate kill switches. "Stop the personas" and "stop support" are
  different operational decisions.

Everything that touches the wire **is** reused, by import and unchanged:
`pqp-client.js`, `identity.js`, `log.js`, `RateCap`, and the identity screens in
`guardrails.js`.

## The disclosure seam

`tools/ambient/src/guardrails.js` treats an identity probe as a reason to refuse
to reply, and bans claiming to be a bot. That is correct for the personas and
exactly wrong here. Rather than deleting it or copying it, the rule was **split
along the line that was always implicit in it**:

- `HUMANITY_CLAIM_PATTERNS` — claiming to be a person. Forbidden to every
  account at every disclosure setting, forever. This is the floor.
- `SOFTWARE_CLAIM_PATTERNS` — saying you are software. Forbidden unless
  `disclosure` is `bot`.

Only one of those two is a lie. `screenInbound(..., { disclosure: "bot" })`
returns `{ reply: true, reason: "identity-probe", disclose: true }`, and
`disclose` means "post your fixed sentence, do not call a model".

**The invariant, and it is what the tests pin: disclosure can only ever ADD
truth.** No setting lets any account claim to be a person; no setting lets any
account deny being software. The default is `undisclosed`, so the personas are
untouched, and `screenHumanReply` in the ambient runner treats a `disclose`
verdict as a refusal, because a runner whose only output is generated dialogue
has no fixed sentence to post.

## The four decisions

**Trigger: explicit mention only** (or a reply to one of its own messages), in
an allowlisted channel, default `#ajuda`. Not "any question in `#ajuda`". In
that room two humans helping each other is the *best* outcome and the channel's
whole premise; question detection misfires constantly in chat ("alguém aí?");
and a mention is consent, which is the ethical basis of the account. The cost is
discoverability, and the mitigation is deliberately not a bot behaviour: the
channel topic and the pinned welcome say it exists. **The room announces the
bot. The bot never announces itself.**

**Loops and flooding:** five independent gates, in `trigger.js`. Its own user id
is refused first, before anything else runs. Webhooks and any `[bot]`-suffixed
author are refused. `SUPPORT_IGNORE_USER_IDS` covers the rest. Then per-user and
per-channel hourly caps, an 8s global cooldown, and message-id dedupe for
redelivery across a reconnect.

**Escalation:** the bot @-mentions Rafael in the channel, publicly, in the same
message that admits it is stuck, capped at 4/hour. A log file loses because an
escalation nobody reads is the silent death this is meant to prevent; a DM loses
because character accounts cannot DM, enforced server-side. A public mention
also lets the person *see* that a human was pulled in. Past the cap it still
admits it does not know, without the ping. Every unanswered question is written
to `state/escalations.jsonl` either way, which is the maintenance signal: that
file is the list of what to add to `facts.md`.

**Cost.** See below.

## Cost, and the ceiling

Per call: ~2.4k input tokens (the system prompt plus the whole of `facts.md`)
and ~80 output.

| Model | Per answer | 30/day | 100/day |
|---|---|---|---|
| `claude-haiku-4-5` (default) | ~$0.0028 | **~$2.50/mo** | ~$8.40/mo |
| `claude-sonnet-4-5` | ~$0.0084 | ~$7.60/mo | ~$25/mo |

Haiku is the default because correctness here does not come from the model being
clever. It comes from `facts.md` being the only source, the `NAO_SEI` sentinel
making ignorance a control-flow decision, and `screenAnswer` refusing an
ungrounded claim deterministically whatever the model produced. `SUPPORT_MODEL`
moves it up a tier with no code change if the answers read badly.

**The hard ceiling is `SUPPORT_MAX_CALLS_PER_DAY=150` and
`SUPPORT_MAX_USD_PER_DAY=1.00`, whichever binds first.** That is a worst case of
**$30/month** and an expected **$2.50**. The ledger is on disk, so a crash loop
cannot reset it. Past the ceiling the bot still answers the fixed questions,
which cost nothing, and escalates the rest.

## Install and test

Outside the pnpm workspace, like `tools/ambient` and for the same reason.

```bash
cd tools/support-bot
npm test          # 190 tests, no network, no key, no database
```

## Run it locally

`--ask` is the whole answering path with no socket and no channel. This is how
it is developed, and it needs nothing running.

```bash
# Fixture answers, no API key, costs nothing
node src/bot.js --ask "tem como aumentar a qualidade da resolução?" --canned --dry-run
node src/bot.js --ask "é um bot?" --canned --dry-run
node src/bot.js --ask "as mensagens são criptografadas?" --canned --dry-run

# The real model against the real fact file
ANTHROPIC_API_KEY=sk-ant-… node src/bot.js --ask "o app de desktop compartilha tela?"
```

Connected, against a local stack (**a separate one — do not point this at a dev
server you are using**):

```bash
DEV_AUTH_BYPASS=true node src/bot.js --watch --canned --dry-run
```

| Flag | Effect |
|---|---|
| `--ask "<pergunta>"` | One question, printed, nothing posted. No network. |
| `--watch` | Connect and answer. |
| `--canned` | Fixture answers instead of a model call. |
| `--dry-run` | Print what it would post; post nothing; keep no ledger. |
| `--channels ajuda,caca-bugs` | Which channels to watch. Default `ajuda`. |
| `--facts <path>` | A different fact file. |
| `--tokens <path>` | The character secret. Also `SUPPORT_TOKENS_FILE`. |

Env: `PQP_API_URL`, `SUPPORT_TOKENS_FILE`, `SUPPORT_STATE_DIR`, `SUPPORT_MODEL`,
`SUPPORT_OWNER_HANDLE`, `SUPPORT_CHANNELS`, `SUPPORT_IGNORE_USER_IDS`,
`SUPPORT_MAX_*`, `SUPPORT_HEARTBEAT_MS` (default 300000 — read the cadence note
in `src/heartbeat.js` before lowering it), `ANTHROPIC_API_KEY`, the hello knobs
(`SUPPORT_GREETING_CHANNEL`, `SUPPORT_NEWCOMER_WINDOW_MS`,
`SUPPORT_GREETING_MAX_PER_10MIN`, `SUPPORT_MEMBER_POLL_MS`, see the section
below), and three switches:
**`SUPPORT_BOT_KILL_SWITCH=1`** stops this bot, **`AMBIENT_KILL_SWITCH=1`** stops
every automated account in the product including this one, and
**`SUPPORT_BOT_GREETINGS=false`** stops only the newcomer hellos and leaves the
answers running.

## Answering a newcomer's hello

Somebody joins the QG, opens the channel where people talk, types "oi", and
nothing happens. That silence is the moment a new person decides the room is
dead. So the bot answers it, once, with one line a human wrote.

**Trigger: two conditions, both checked deterministically.** A message posted in
the greeting channel (`SUPPORT_GREETING_CHANNEL`, default `geral`, a channel
*name* on the same server as the answer channels) by a member who joined **less
than fifteen minutes ago** (`SUPPORT_NEWCOMER_WINDOW_MS`), whose message **reads
as a greeting** by word list (`isGreeting` in `src/greetings.js`: oi, olá, eaí,
salve, bom dia, cheguei, opa, fala galera, hello, hey, with repeated letters,
punctuation and emoji tolerated). Somebody who joined an hour ago and says "oi"
gets nothing. Somebody who joined three minutes ago and asks a question gets
nothing from this path; the ordinary support path still applies to them,
unchanged. "oi, como faço pra entrar na call?" is a greeting and a question, gets
the hello, and the question goes wherever it would have gone anyway.

**The reply** is one line from `src/greetings-pool.js`, `{name}` filled with
`@username` (or the display name when there is none), posted as a *reply* to the
person's own message (`replyToId` on `message-create`) so it threads under their
"oi" instead of landing three messages later as noise. No model is involved: the
same no-improvisation rule as the answers, applied to the one moment the bot
speaks to somebody who did not ask it anything. The pool never repeats the line
it just used, and the file is deliberately copy with no logic in it so a human
can edit the jokes without reading code. Rules for a new line are in its header.

**How it knows somebody is new.** It does not, exactly, and this is written down
because it is the one place the feature can be wrong in an embarrassing
direction. The server keeps `server_members.joined_at` but, as of this writing,
neither exposes it on `GET /api/servers/:id/members` nor sends any `/ws` frame
when a membership is created (`redeemInvite` only invalidates an audience
cache). Changing that restarts `pqp-api` and is a separate decision. So the bot
works from what it can observe: it fetches the member roster at boot and every
`SUPPORT_MEMBER_POLL_MS` (default 60000), plus once more when somebody the
roster has never seen posts in the greeting channel, and diffs it against the
roster it persisted in `state/greetings.json`. An id that appears between two
fetches is new, and that fetch is the estimate of when they joined. The estimate
is trusted **only when the two fetches are less than the window apart**: after a
restart or an outage, whoever appeared during the gap is *not* new, on purpose.
A missed hello costs nothing; greeting somebody as a newcomer three hours after
they arrived reads as a bot that does not know what is going on. The first
roster the bot ever sees (no ledger on disk) seeds everybody as not-new, so
switching the feature on never greets the existing membership. If the members
endpoint ever returns a `joinedAt`, `Roster.observe` prefers it with no other
change.

**Limits.** One hello per person, ever, persisted across restarts and
reconnects. At most `SUPPORT_GREETING_MAX_PER_10MIN` (default 3) hellos in any
ten minutes; a newcomer refused by the cap is still marked greeted, because a
hello that arrives ten minutes late under a conversation that has moved on is
worse than none. Its own messages, webhooks, any `[bot]`-suffixed author and any
`isCharacter` member are skipped. Watching the greeting channel does not make
the bot answer questions there: those frames still go through `screenTrigger`,
which refuses them unless the room is also in `SUPPORT_CHANNELS`.

**Switches.** `SUPPORT_BOT_GREETINGS=false` turns the hellos off and nothing
else (default on). `SUPPORT_BOT_KILL_SWITCH` and `AMBIENT_KILL_SWITCH` stop
these too, checked right before every write like every other post. A greeting
channel that does not exist logs `greetings.disabled channel-missing` at boot
and the answers carry on; it is not a boot failure.

**Editing the pool.** Open `src/greetings-pool.js`, add or change a line with
exactly one `{name}`, no em dash, nothing about looks, gender or origin, no
inside jokes, no claims about the product. `npm test` checks the mechanical
rules. Redeploy the bot; nothing else moves.

## The socket, and why it now reconnects

`manual [bot]` connects once at boot and then waits to be mentioned. That makes
its WebSocket the service, not a per-task resource, and on **2026-08-23** the
consequence arrived: it logged `bot.ready` and `bot.start` at 17:33:32Z and then
nothing at all, for hours, in a 114-member community. The Fly machine said
`started`, the log trail ended cleanly on a start, and in the app the account sat
in the member list under **OFFLINE** — because `server/src/ws/status.ts` defines
`online` as "there is a live socket" and there was no live socket.

Three separately correct decisions composed into it:

1. `tools/ambient/src/pqp-client.js` has no reconnect, on purpose. A persona
   whose socket drops should go quiet and be re-cast on the next scene. **That
   is still true and still the cast's behaviour.**
2. `socket.onerror = () => {}` swallowed the reason.
3. The process never exited, so `[[restart]] policy = "always"` never fired.

The fix keeps (1) for the cast and gives this bot the opposite policy, in
`src/socket.js`, because reconnect is a policy and the two consumers want
opposite ones. `PqpSocket` gained only the ability to be *observed* — `onClose`,
an error path that no longer swallows, `isOpen`. `ResilientSocket` wraps it with
backoff, a fresh token per attempt, an application-level ping/pong keepalive that
catches the half-open socket, and a re-join of the channel after every recovery.
It follows `client/src/lib/realtime.ts`, which had already been through this
(pitfall #9 in `CLAUDE.md`).

Every transition is logged — `socket.closed`, `socket.reconnect`,
`socket.reconnect.failed`, `socket.reconnected`, `socket.stale` — because
silence is what made the outage invisible in the first place.

### The heartbeat

`src/heartbeat.js` prints one `bot.heartbeat` line every five minutes whether or
not anybody asked anything:

```
bot.heartbeat connected=1 expected=1 reconnects=0 closes=0 downForS=0 idleForS=12 uptimeS=3600
```

It exists so that "the bot is deaf" stops looking like "the channel is quiet".
`scripts/monitor/bot-heartbeat.mjs` reads it and imports the event name and
cadence from this package, so the two cannot drift. Cadence is a trade against
history: Fly's free retention is the ~100-line `fly logs --no-tail` buffer, and
12 lines an hour still leaves it covering roughly eight hours.

### Reproducing a dropped socket

`scripts/fake-pqp.mjs` is a fixture pqp API and WebSocket server with a control
plane that can drop a socket the way a proxy reap does — a TCP reset with no
close frame, which neither production nor a local dev stack will produce on
request. The exact commands are in its header. `test/socket.test.js` covers the
same failures against a fake WebSocket, including the half-open case and an
`error` with no `close` behind it.

## Before it is switched on

1. `CHARACTER_ACCOUNTS_ENABLED=true` on the API, or every token is refused.
2. `node scripts/provision.mjs` against the database, once. **Not yet done.**
3. Invite the account to the QG. It does not join or create servers by itself.
4. Run `server/scripts/seed-qg.mjs` to publish the copy that tells people the
   bot exists. It is already written into `server/scripts/qg.config.mjs`: the
   `#ajuda` topic, and a block in the welcome that names `@manual_bot`, says it
   only speaks when called, and says **the rest of the QG is people**. This is
   the whole discoverability plan, and it is the room's job, not the bot's.
   Note that re-seeding posts a *new* welcome message and unpins the old one
   (it never deletes), so the change is visible in `#chegou-agora`.
5. Read `facts.md` end to end and correct anything wrong. It is the only thing
   standing between this bot and the failure it was built to avoid.
