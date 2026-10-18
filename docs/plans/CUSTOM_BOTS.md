# Server bots

Server staff create an AI bot for their server. The bot has a name, a persona, a block of knowledge and a list of channels. It answers when a member mentions it or replies to one of its messages. pqp runs the model and pays for it. Members need no API key.

This replaces Caio's old setup: a normal account that an external Grok service woke through an outgoing webhook.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Chat bots: create, edit, delete, mention and reply trigger, caps, settings tab | Ready to merge behind `custom_bots` (off); rollout below |
| 2 | Actions: channels, posts, pins, threads, forum and Baú posts, moderation, with two permission checks and confirmations | Ready to merge behind `custom_bots` (off) |
| 3 | More triggers (unanswered questions, welcome), slash commands, scheduled posts | Welcome, search, catch-up and reminders built; the rest not started |
| 4 | Bring your own key, paid plan | Parked |

## Decisions

- Manage Server creates, edits and deletes bots. Manage Server also reads them, because the persona and knowledge are staff notes.
- One bot per server (`SERVER_BOTS_MAX`, and a unique index on `server_bots.server_id`).
- The bot answers a mention or a reply to its own message. With "Responder pelo nome" on, it also answers its name said as a whole word. After it answers somebody, that person's next message in the same channel within three minutes is a follow-up and needs no mention. A message that mentions someone else or replies to someone else is not a follow-up. On a follow-up the model may answer `SKIP` (a thanks, a message meant for others): nothing is posted and the window closes. Detecting a follow-up costs one indexed query, not a model call.
- The default model is Claude Haiku 5.5 through Anthropic. Thinking is off and effort is `low`.
- Staff pick a model per bot in the settings form. The list comes from `BOTS_MODEL_CHOICES` and shows only choices whose provider key is set.
- Free OpenRouter models are named ones, not the `openrouter/free` router. In testing the router sent a chat turn to a safety classifier, and the bot posted its verdict.
- A free pick falls back to the other free choices (OpenRouter's `models` list), because free models are often rate limited upstream. A paid pick never falls back.
- Free models are for local testing only. Production never offers one, even when `BOTS_MODEL_CHOICES` names it, because their answers were too poor. A bot saved with one uses the default model in production.
- Enabled bots show online, in their own Bots section of the member list.
- The runtime flag `custom_bots` gates the feature. It is per server and off by default.

## How it works

1. A bot is a `users` row with `is_character = TRUE`, plus a `server_bots` row. Being a character gives it the bot mark on every client, blocks DMs, voice and friend requests, and makes outgoing webhooks skip it.
2. The bot's username is the name plus `_bot`, for example `caio_bot`. Creation refuses a username that a member of the server already has, because mentions match the bare username. A rename changes the display name only.
3. `postChannelMessage` calls `maybeQueueBotReply` after the message commits. The call checks, cheapest first: the author is not a character, the channel belongs to a server, the flag is on, the server has an enabled bot, the channel is on the bot's list (a thread counts as its parent), and the message mentions the bot or replies to it. Then it inserts a `server_bot_runs` row and sends a NOTIFY. An error here never fails the send.
4. The worker poller (`startBotRunPoller` in `jobs.ts`) claims runs with `FOR UPDATE SKIP LOCKED` and a 90-second lease.
5. For each run the runner:
   1. Skips a run older than 10 minutes.
   2. Re-reads the flag, the bot's `enabled` and the channel list, so turning a bot off silences queued replies.
   3. Checks that the bot has View Channel and Read Message History there. A private channel the bot cannot read is never sent to the model.
   4. Reserves one reply against the server's daily count.
   5. Reserves the worst-case cost against the deployment's daily dollar ceiling.
   6. Sends a typing indicator.
   7. Calls the model with the system prompt (rules, persona, knowledge) and the last 20 messages.
   8. Settles the cost to the real usage.
   9. Defuses `@everyone`, `@here` and more than three user mentions.
   10. Posts the answer as a reply, with the run id as the nonce.
6. A run that is claimed a second time first looks for its nonce. If the first claim already posted, it stops without calling the model.

## Actions

The bot acts through tools. Each write tool calls the same API route a member's client calls, signed in as the bot (`invokeApiAsUser`). Code: `server/src/services/bot-actions.ts`.

| Tool | Needs (bot and requester) | Confirmation |
|---|---|---|
| `list_channels`, `list_members` | (read) | No |
| `read_channel` | View Channel and Read Message History on that channel | No |
| `catch_up` | As `read_channel`; up to 150 messages over 72 hours, since the requester last read the channel | No |
| `search_messages` | (read); the requester's own search, then only channels the bot can read too | No |
| `create_reminder` | Send Messages there; repeating, announcing or another channel also need Manage Messages | Only past three actions |
| `list_reminders`, `cancel_reminder` | (read); a member cancels their own, staff also cancel announcements | Only past three actions |
| `list_bans` | Ban Members | No |
| `ask_member` | (always offered, no switch) | No |
| `create_channel`, `edit_channel`, `move_channel` | Manage Channels | Only past three actions |
| `delete_channel` | Manage Channels | Always |
| `post_message`, `pin_message`, `create_forum_post` | Manage Messages | Only past three actions |
| `create_thread` | (channel access) | Only past three actions |
| `create_bau_post` | Manage Server, Baú on | Only past three actions |
| `create_invite` | Create Invite | Always without a use limit or an expiry; otherwise only past three actions |
| `list_forum_posts` | (read), forums on | No |
| `read_poll` | (read) | No |
| `create_poll` | Send Messages here; in another channel also Manage Messages there | Only past three actions |
| `vote_poll` | (channel access); votes as the bot, and voting again keeps the vote | Only past three actions |
| `reply_forum_post` | Manage Messages, and Send Messages in the post; forums on; not in a locked post | Only past three actions |
| `delete_message` | Manage Messages | Always |
| `timeout_member`, `kick_member`, `ban_member` | Moderate, Kick or Ban Members, and the requester outranks the target | Always |
| `remove_timeout`, `unban_member` | Moderate Members, Ban Members | Always |

Staff switch each tool on or off per bot in Server settings, Bots, "O que ele pode fazer" (`server_bots.tools`, NULL is the default set). New bots start with moderation off and everything else on. A tool switched off is not offered to the model, cannot be staged, and does not run from a plan staged before it was switched off.

Rules:

1. Two keys. The bot's permission is the route's own check. The requester's permission is checked when the action is staged and again when it runs, in the channel the action touches when it names one (an overwrite there can take Manage Messages away), and server-wide otherwise. A tool is not offered when either key is missing, and the prompt says which. A tool the model was not offered is refused even if it calls it, and a read that needs a permission (`list_bans`) checks both keys like a write.
   A timeout stops an action too: the requester's (a timed-out member cannot confirm a plan by button either) and the bot's (a timed-out bot does not answer at all).
2. Reads show only what both the bot and the requester can see.
3. The model only stages writes. After its last turn, code builds the plan text. Up to three reversible actions run at once. More, or any destructive or moderation action, wait for the requester to reply "sim" within five minutes. "não" cancels. The plan card also has Confirmar and Cancelar buttons, shown only to the requester (`POST /api/bots/plans/:planId/decision`); the first answer wins, and the card then reads Confirmado, Cancelado or Expirou for everybody. Another member's "sim" does nothing.
4. A plan runs once. Claiming it is a conditional `UPDATE`. Each step writes its row in `server_bot_actions` before it runs, and a worker that takes over never repeats a step.
5. A created channel gets a `new:N` ref that later actions in the same request can use.
6. The route's audit row has the bot as the actor and "pedido por @x" as the reason.
7. Messages are named by their `[mN]` number in the conversation, never by id.
8. Never: roles, permissions, making a channel private, events, web search, DMs. The model never touches a role. The bot's own role is made by code when staff save its tools (see below).
9. The reply carries a card (`messages.bot_card`, `botCard` on the message): the plan waiting for "sim", or each step with its outcome. A confirmed plan finishes on its own card: each step's mark lands as it runs, and the card and its text copy end as the result, with no second message. A settled card is drawn as one line, with its steps behind a toggle. Only server code writes it, and the web client draws it only for a bot author. The body keeps a plain-text copy for clients that do not draw cards.
10. While the bot works, its typing frames carry `activity: { tool }`. The web client shows "Julius está criando um canal…" with a shimmer instead of "digitando".

### The bot's role

A bot with no role holds only @everyone's permissions, so its key fails every write. Creating a bot, or saving its tools, makes or adjusts a role for it (`server/src/services/bot-role.ts`, `server_bots.role_id`):

1. The role is named after the handle (`julius_bot`) and sits at the lowest custom rank. The bot outranks nobody.
2. It carries the bits the switched-on tools need, and never a bit the person saving does not hold.
3. A bit a more powerful staff member granted stays while its tool stays on. Turning the tool off removes it.
4. Only somebody with Manage Roles makes or changes it. An existing role changes only when it ranks below the person saving. Otherwise the save still works and the role is left alone.
5. Each change is in the audit log under the person who saved. Deleting the bot deletes its role. If somebody deletes the role, the next save makes a new one.
11. `ask_member` asks the requester one question with two to four answers, instead of guessing. It ends the request: any write staged in the same turn is dropped. The question is posted with an `ask` card that lasts ten minutes. Only the requester gets buttons (`POST /api/bots/asks/:messageId/answer`). A press claims the card with a conditional `UPDATE` and queues a run on the question itself (trigger `answer`), under the same per-member limits and access checks as a typed reply. Nothing is posted for the member: the card shows what they picked, and the transcript gives the model the buttons and the pick. Typing an answer also works.

12. A tool behind a feature that is off is not offered, and the prompt says why: `create_forum_post` and the forum type of `create_channel` need `forum_channels` on for the server, and `create_bau_post` needs Baú on.
13. When a step fails, one short model call (at most 200 output tokens) writes the sentence above the result, knowing what failed and why. A request where everything works costs nothing more. Without a provider, budget or answer, a fixed "Não deu certo: …" line is used. Route error codes are shown in words (`forum_channels_off` reads "os fóruns estão desligados neste servidor").
14. A forum can be ticked in the bot's channels; it then answers a mention or a follow-up inside any post of that forum, in the post. `list_channels` says `youAnswerHere` per channel, so the bot can tell a member where it listens.
15. A poll in the conversation reads `[poll: "question"; read_poll shows the votes]`. Options are numbered from 1 for `read_poll` and `vote_poll`; without a message number both use the newest poll in the conversation.

The model learns the tools from the request itself: each tool goes to the API with a name, a description and a JSON input schema. The system prompt holds only the general rules (ids come from the list tools, writes are staged, ask instead of guessing, never mention the requester).

## Welcome

Staff can turn on a fixed welcome in the bot's settings: a channel and a text, with `{membro}` (an @mention of who joined) and `{servidor}` (the server's name). No model is called, so it costs nothing. `welcomeNewMember` in `server/src/services/bots.ts` runs after the join commits, on the invite, community and SSO paths. Each person is welcomed once per server (`server_bot_welcomes`), so leaving and joining again is not welcomed twice, and a server gets at most 20 welcomes an hour. The text is cleaned like a reply: no `@everyone`.

## Reminders

`create_reminder` stores a reminder in `server_bot_reminders`; the `bot-reminders` job (every 30 seconds, `server/src/services/bot-reminders.ts`) posts it when due, with no model call.

1. Anybody may set a one-off reminder in the channel they ask from. It mentions them when it fires.
2. A repeating reminder (daily or weekly), an announcement that mentions nobody, or a reminder in another channel needs Manage Messages, checked when it is set and again when it fires.
3. Times are São Paulo wall clock. Each request tells the model the current São Paulo time in the user message, not the system prompt, so the cached prefix does not change every minute.
4. At least a minute ahead, at most 30 days. At most 5 open per member and 50 per server.
5. Delivery claims with a lease and `SKIP LOCKED`, and posts with a stored nonce that is checked first, so a retry never posts twice. A repeat moves to its next slot on its own schedule and skips what it missed while the API was down.
6. A reminder whose member left, lost access, is timed out, or whose bot is switched off is cancelled when it comes due.
7. The flag is different: while `custom_bots` is off for its server, a repeating reminder skips its slot without posting and a one-off waits. Once the flag is back, the one-off goes out, unless it is more than six hours late. Any one-off that late is dropped rather than posted, whatever kept it.

## Images and voice notes

Two switches in the "Imagens e voz" group, on by default: `see_images` and `hear_voice_notes`. They are not tools the model calls. Code: `server/src/services/bot-media.ts`.

- Images. At most two per request: those in the message that called the bot, then the message it replies to, then the newest in the conversation. JPEG, PNG, GIF and WebP up to 3.7 MB. The server fetches the bytes and sends them as base64, never as a link to the bucket. A flagged image (scanner filed a report) and a GIF on another host are never sent. The transcript marks each one `[image 1]`, or `[image, not shown]`. Images ride in the first message, which every tool turn sends again, so a cache breakpoint sits after it. The spend estimate counts an image as about width × height / 750 tokens (at most 1,600), not its base64 length.
- Voice notes. The bot reads the transcript the worker already makes, as `[voice note, 12s, transcribed: "…"]`. The text appears only with `voice_note_transcription` on for the server and the sender's consent (`transcribe_allowed`); otherwise it reads "not transcribed". In a server channel nothing transcribes a note until somebody asks, so when a run is called by a voice note (or by a reply to one) the bot asks for the transcript itself, through the same request a member's tap makes: the flag, the sender's consent and the daily speech budget all apply. It then hands the run back to the queue every 2 seconds, without counting an attempt, for up to 20 seconds after the run was created, instead of sleeping in it and holding other bots' replies. A voice note or a photo with no text counts as a follow-up.
- `read_channel` describes the same way: transcripts, and images by name only.

## Limits

| Variable | Default | Meaning |
|---|---|---|
| `CUSTOM_BOTS` | off | Flag default. The dashboard override wins. |
| `BOTS_REPLIES_PER_SERVER_DAY` | 200 | Replies per server per São Paulo day. |
| `BOTS_RUNS_PER_MEMBER_HOUR` | 20 | Questions one member may ask one bot per hour. The server's owner and members with Administrator have no hourly limit. A member has at most two open questions per bot. The second waits until the first is answered, and its transcript includes that answer. A third is not answered. |
| `BOTS_MAX_USD_PER_DAY` | 5 | Model spend for the whole deployment per São Paulo day. |
| `BOTS_ACTIONS_PER_HOUR` | 30 | Actions one bot may run per hour. |
| (code) | 10 | Actions one request may stage. |
| `BOTS_MODEL_CHOICES` | Haiku 5.5, plus Gemma 4 31B and Nemotron 3 Super (free, dev only) | `provider:model=Label;...`. Providers: `anthropic`, `openrouter`. |
| `BOTS_MODEL` / `BOTS_PROVIDER` | unset | Moves a choice to the top. The top choice is the default. |
| `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` | unset | With neither set: a fixture answers outside production, and bots are off in production. |

Every day here is São Paulo's (`botDay` in `server/src/services/bot-stats.ts`), so a limit resets at midnight in Brazil.

Usage is in `server_bot_usage_daily` (per server) and `server_bot_spend_daily` (deployment). Each run also stores its trigger (mention, reply, name, follow_up, decision, answer), model, model calls, tokens and cost.

The operator's history is in three tables with no foreign keys, so a deleted bot or server keeps its past:

- `server_bot_stats_daily`: runs, replies, skips, failures, questions, plans, confirmations, cancellations, actions, tokens and cost, per day, server and bot.
- `server_bot_tools_daily`: plan steps per tool, done and failed.
- `server_bot_people_daily`: who asked, only to count distinct people. Rows older than 90 days are deleted.

When a limit stops an answer, the member gets a `bot-notice` frame on their own sockets: which limit, and when the bot answers again. The web client shows it above the composer, to that member only, until they dismiss it or the bot speaks. A follow-up outside its window gets no notice, because it was not meant for the bot.

## Cost

With Haiku 5.5 ($0.10 input, $0.50 output per million tokens), a chat reply of about 3,000 input and 300 output tokens costs about $0.00045. That is about $0.45 per 1,000 replies, before prompt caching.

## Rollout

The flag is off by default, and off costs nothing: a chat message in a bot's channel never reaches the database for bots, and the run and reminder jobs return before they query.

1. Set `ANTHROPIC_API_KEY` in `/opt/pqp/.env`. The API reads it for the config and the practice chat; the `worker` container reads the same file and runs the replies and reminders. Keep `BOTS_MAX_USD_PER_DAY` at its default of 5 or lower.
2. Turn `custom_bots` on for one server from controles → interruptores (its override). Then `bot_test_chat` for the same server.
3. Watch "bots · beta" on the dashboard: spend against the ceiling, refused calls, failed runs.
4. Before a second server: add a per-server dollar cap. The ceiling is shared by the whole deployment, so one busy server can use another's day.

## Before production

- Test that a reply posted by `pqp-worker` reaches clients with `CLUSTER_BUS=postgres`. Locally one process does everything.
- Test that an action's broadcasts reach clients from `pqp-worker`: `channels-update`, `thread-update`, pin updates and the removal notice after a kick or ban.
- Decide whether every mention should think. Offering tools turns on adaptive thinking, so a plain question went from 119 to 514 output tokens (about $0.0003 a reply on Haiku 5.5, about 5 seconds).
- Add a per-creator daily cap. Today one person who owns many servers gets the per-server cap on each.
- Bot counters: done in the operator dashboard, "bots · beta" (`GET /api/admin/bots`, `server/src/services/bot-admin.ts`). They are a separate read, not part of `/api/admin/metrics`.
- Check the bot mark and reply rendering on iOS and Android, and draw `botCard` there. Today they show the plain-text copy.
- Rebuild Caio on this feature in the QG, then disable the Grok outgoing webhook.

## Test locally

1. Set `CUSTOM_BOTS=true` in the root `.env`. Optionally set `ANTHROPIC_API_KEY`.
2. Run `pnpm dev`.
3. Open server settings, then Bots. Create a bot and tick a channel.
4. In that channel, type `@<name>_bot` and a question.
5. For actions, ask it to create a channel. The bot's role already has Manage Channels when you created the bot with that tool on.
