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
   to things nobody asked it about. There is no code path that posts without an
   explicit mention or a reply.

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
| `src/bot.js` | The only file that touches the network, the clock or the disk. |
| `scripts/provision.mjs` | Mint / rotate / revoke the one character account. **Not yet run.** |

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
npm test          # 104 tests, no network, no key, no database
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
`SUPPORT_MAX_*`, `ANTHROPIC_API_KEY`, and two kill switches:
**`SUPPORT_BOT_KILL_SWITCH=1`** stops this bot, **`AMBIENT_KILL_SWITCH=1`** stops
every automated account in the product including this one.

## Before it is switched on

1. `CHARACTER_ACCOUNTS_ENABLED=true` on the API, or every token is refused.
2. `node scripts/provision.mjs` against the database, once. **Not yet done.**
3. Invite the account to the QG. It does not join or create servers by itself.
4. Put it in `#ajuda`'s topic and the pinned welcome. This is the whole
   discoverability plan, and it is the room's job, not the bot's.
5. Read `facts.md` end to end and correct anything wrong. It is the only thing
   standing between this bot and the failure it was built to avoid.
