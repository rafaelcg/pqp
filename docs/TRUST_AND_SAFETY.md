# Trust & Safety — pqp.gg

Operational companion to the three public legal pages:

- `client/src/pages/terms-page.tsx`
- `client/src/pages/privacy-page.tsx`
- `client/src/pages/cookies-page.tsx`

> **STATUS: not reviewed by a lawyer, and at this size probably never will be.**
> pqp.gg is run by **one person as a personal project** — no company, no counsel,
> no funding, no revenue. The pages are written to be factually true about the
> product as built and honest about what a one-person project can and cannot
> promise. Eight placeholders still need real values before the pages go live;
> the list is §1. Publish when that list is empty. §7 records what *would* need a
> lawyer if the project ever grows into something that can afford one — it is a
> deferred list, not a launch blocker.
>
> The legal pages ship in English and pt-BR (`client/src/pages/legal/`). App
> chrome uses i18next; see [`I18N.md`](./I18N.md).

---

## 1. Placeholder checklist

Every token below appears literally as `{{TOKEN}}` in the page source. Grep to
find them:

```bash
grep -rno "{{[A-Z_]*}}" client/src/pages/
```

There is no build-time substitution — these are literal strings that will render
to users as `{{LIKE_THIS}}` if shipped. That is deliberate: an unfinished legal
page should look unfinished.

**Eight tokens remain.** The rest were **deleted rather than filled**, because
filling them would have meant asserting things that are not true:
`{{LEGAL_ENTITY_NAME}}` / `{{LEGAL_ENTITY_CNPJ}}` / `{{LEGAL_ENTITY_ADDRESS}}`
(there is no company, a CNPJ cannot be invented, and the only address available
is a home address that must never appear on a public page for an 18+ service);
the six separate contact addresses (one person cannot staff six inboxes);
`{{DPO_NAME}}` / `{{DPO_EMAIL}}` (a solo project appointing a formal
*encarregado* is theatre — the pages now say the operator handles it
personally); `{{MARCO_CIVIL_NOTICE_PROCEDURE}}` (it assumed a Brazilian entity);
`{{TRANSFER_SAFEGUARD}}` (there are no negotiated DPAs — the pages now say so);
`{{BR_MIGRATION_TARGET}}` (no committed date exists); and the four SLA numbers
(§2).

### Identity — **founder decides, one edit**

| Token | What it is | Pages |
|---|---|---|
| `{{OPERATOR_NAME}}` | The name of the person who runs pqp.gg. **This is a judgement call, not a compliance box.** UK and EU practice expects a controller to be identifiable, and a name is the normal answer. Against that: naming an individual who single-handedly runs an 18+ chat service is a real personal-safety exposure, and the pqp.gg WHOIS is deliberately redacted. A working middle option is a consistent pseudonym or project handle plus a live contact address, upgraded to a legal name if and when there is an entity to stand behind it. Whatever is chosen, it is one greppable token in two places | terms, privacy |

### Contact — **founder / ops. This is the launch blocker.**

| Token | What it is | Pages |
|---|---|---|
| `{{CONTACT_EMAIL}}` | **The single address for everything**: support, abuse and safety, underage-account reports, privacy requests, security disclosure, legal notices, appeals. It replaced six separate tokens deliberately — six addresses that bounce are worse than one that works, and until the in-app report flow ships this is the *entire* reporting surface | all three |

> **It must actually receive mail before the pages go live.** `pqp.gg` has no MX
> record today, so anything sent to it bounces. Set up **Cloudflare Email
> Routing** on the zone (free, catch-all or single alias, forwards to a real
> mailbox) and send yourself a test message from an unrelated provider before
> publishing. Route it somewhere that reaches a phone: the pages promise no
> response time, but a report about a minor still needs to be seen the same day.

These render as plain text, not `mailto:` links, precisely so an unfilled one
cannot become a broken link. Turn it into a `mailto:` anchor when filled.

### Jurisdiction — **resolved, no tokens**

The operator is in the UK. The terms name **the laws of England and Wales** and
the courts of England and Wales, with an explicit carve-out that consumers may
sue where they live and that Brazilian users keep their rights under the CDC
(Lei nº 8.078/1990) and the LGPD regardless. The privacy policy states that
**UK GDPR / DPA 2018 and the LGPD both apply**, and that the rights it lists are
honoured for everyone whichever law grants them — one list, not two.

### Dates — **founder**

| Token | What it is | Pages |
|---|---|---|
| `{{EFFECTIVE_DATE}}` | The "Last updated" date. Set it to the day the pages actually go live | all three |

### Infrastructure facts — **ops, verified against live env vars**

These are placeholders and not hardcoded because the repository contains
configuration for two different deployments and the code cannot tell which is
live. **Check the actual production environment, not the repo.**

| Token | What it is | How to confirm | Pages |
|---|---|---|---|
| `{{HOSTING_PROVIDER}}` | Who runs the API and Postgres | `docs/DEPLOY.md` says Railway; `fly.toml` targets Fly.io. Confirm which is serving `api` today | privacy |
| `{{HOSTING_REGION}}` | The region it runs in | Railway US East (Virginia) vs Fly `gru` (São Paulo). `fly.toml:36` sets `primary_region = "gru"` | privacy |
| `{{OBJECT_STORAGE_PROVIDER}}` | Attachment storage vendor and region | Whatever `S3_ENDPOINT` points at (Cloudflare R2 in the hosted plan) | privacy |
| `{{ATTACHMENTS_STATUS}}` | Literally "enabled" or "disabled" | Attachments are off entirely unless `S3_*` is set — `docs/ATTACHMENTS.md`. Per `MEMORY`, they were merged but not switched on in production | privacy |
| `{{TURN_PROVIDER}}` | The STUN/TURN vendor(s) actually configured | `server/src/services/ice.ts` resolves in order: static `TURN_*` → Cloudflare Realtime → Metered/Open Relay. Name the one in use | privacy, cookies |

International transfers no longer carry a token. The privacy policy states the
truth instead: these are ordinary commercial services used on their published
terms, and **no bespoke transfer agreement has been negotiated for pqp**,
because there is no company to sign one and no lawyer to draft it. If an entity
ever exists, revisit — see §7.

---

## 2. Response times — **no SLA is published, deliberately**

There are no SLA tokens any more, and the Terms page no longer contains a
number. A published SLA is a public promise; one person with a day job cannot
keep a 4-hour urgent target at 3am on a Sunday, and a missed promise is worse
than an honest absence of one.

**What the Terms now say** — keep this wording and this operating posture in
sync:

| Area | Published position |
|---|---|
| Reports generally | One person reads them; acted on as fast as one person reasonably can, *usually within a few days*; no guarantee, and longer when the operator is away |
| Priority | Reports involving minors, imminent physical danger, or non-consensual intimate images go to the front of the queue |
| **CSAM / sexualisation of a minor** | **Removed on sight, account terminated, reported to the competent authorities. No queue, no timeline caveat, no appeal.** This is the one commitment with no proportionality argument attached to it |
| Appeals | Read and answered when possible; no promised turnaround; explicitly *not* reviewed by an independent person, because there is no second person |

"Usually within a few days" is a description, not a target. If it stops being
true, change the sentence rather than quietly missing it.

Statutory timelines are **not chosen and not negotiable**:

| Obligation | Deadline | Source |
|---|---|---|
| Complete response to a data-subject request | 15 days (LGPD) / 1 month (UK GDPR) — work to the shorter | LGPD art. 19, II; UK GDPR art. 12(3) |
| Breach notification to the regulator | LGPD: "reasonable time" as set by ANPD. UK: 72 hours to the ICO | LGPD art. 48; UK GDPR arts. 33–34 |

Route `{{CONTACT_EMAIL}}` so it reaches a **phone**, not an inbox read on
weekdays. Nothing above promises a response time, but a report about a minor
still needs to be seen the day it arrives.

---

## 3. Report intake and triage runbook

### 3.1 Intake channels

| Channel | Status |
|---|---|
| `{{CONTACT_EMAIL}}` | **The only channel today.** Must be live before launch — see §1, it has no MX record yet |
| In-app report button | **In progress** — being built now by a separate work stream. Update the Terms page ("We are building an in-app report button…") when it ships |
| Server owner / admin escalation | Informal. Owners moderate their own servers with kick/ban/delete; there is no route from a server owner to us except email |

### 3.2 Triage tiers

**Tier 0 — immediate, no warning step.**
CSAM or any sexualisation of a minor; credible, specific threat of violence;
non-consensual intimate imagery; a user who is or appears to be under 18.

1. Preserve evidence **before** deleting anything (see §3.4).
2. Terminate the account. Ban from the server(s) involved.
3. For CSAM: preserve and report to the competent authorities. **Work out the
   reporting route before you need it and write it down here.** This is the one
   place where "we're a small project" is not a defence: the operator is in the
   UK and most users are in Brazil, so the route involves the authorities in
   both, and mishandling the material is itself an offence. Do not open, copy,
   forward or store it beyond what preservation requires, and do not sit on it
   waiting for advice — reporting it is the advice.
4. No appeal (stated in the Terms).

**Tier 1 — same-day.**
Coordinated harassment, doxxing, malware or phishing links, an account or server
whose apparent purpose is abuse.

**Tier 2 — standard queue.**
Spam, isolated rudeness, IP/copyright claims, disputes between members, ban
appeals.

### 3.3 What we can actually do — enforcement ladder

Every action below maps to code that exists. Do not promise anything else.

| Action | Mechanism | Notes |
|---|---|---|
| Delete a single message | `DELETE /api/messages/:messageId` | Author, or owner/admin of that server. **In a DM there are no moderators — only the author can delete.** No bulk delete exists |
| Kick from a server | `DELETE /api/servers/:id/members/:userId` | Owner/admin, subject to rank |
| Ban from a server | same route with `ban:true`, or `POST /api/servers/:id/bans` | Can be pre-emptive; the target need not be a member. Stores a free-text reason |
| **Time a member out** | `POST /api/servers/:id/timeouts` | **The middle of the ladder.** Owner/admin, subject to the same rank rule as kick. 1 minute to 28 days. Lift early with `DELETE /api/servers/:id/timeouts/:userId`; list the live ones with `GET`. See §3.7 |
| Change a role | `PATCH /api/servers/:id/members/:userId` | Owner only. A demotion from admin to member also **evicts** them from the private channels they held on rank alone — live view and voice room, not just the next query |
| Delete a channel or a whole server | server routes | Owner/admin |
| **Terminate an account** | `DELETE /api/admin/users/:userId` | **Built.** Gated on `INSTANCE_MODERATOR_CLERK_IDS` — operator configuration, not a server role, the same predicate the instance report queue uses. Runs `deleteAccount` (Clerk identity first, then the row, then the S3 sweep) and closes the account's live sockets. **Refuses with 409 when the target owns a server other people are in**, naming the servers: `servers.owner_id` cascades, so overriding that would destroy every message every other member of that server ever wrote. Transfer or delete those servers first. Answers 404 to anyone who is not an instance moderator. Not audit-logged — `audit_log` is server-scoped and this action belongs to no server; it goes to stderr instead |

`servers.message_retention_days` (owner-set, daily sweep, pinned messages exempt)
is a retention feature, not a moderation tool, and never touches DMs.

**Applying a sanction while closing a report.** `PATCH /api/reports/:id` takes an
optional `timeoutMinutes`. It closes the report *and* times the reported member
out in one action, using the resolution note as the timeout's reason. Only valid
on an `actioned` report that has a server behind it — a report about a
conversation has no server to be timed out in, and the route answers 400 rather
than closing the report and silently skipping the sanction. Everything that can
refuse the sanction is checked **before** the report is closed, so a moderator
never ends up with a cleared queue and nobody sanctioned.

### 3.7 Timeouts — what they are and what they are not

Shipped. This is the sanction to reach for when the honest answer to a report is
"stop doing that for an hour". Before it existed the ladder went from deleting
one message straight to banning the account, so every proportionate response was
either an overreaction or nothing at all.

**Scope: one server, the whole server.** Not per-channel. A timeout is about a
person's conduct, not a room — somebody told to stop in #general who carries the
same behaviour into #off-topic has not been stopped. Per-channel would also mean
guessing where they will go next, and N rows and a channel picker per decision.

**What it blocks.** Sending messages, reactions, typing indicators, editing
their own messages, joining voice, and every other write into that server.

**What it does not touch.**

- **Reading.** They stay a member, keep their roles and their history, and can
  read every channel they could read before. That is the entire difference
  between a timeout and a kick, and it is what makes this usable for a first
  offence: getting it wrong costs an hour of silence, not an ejection.
- **Their direct messages.** A server's moderators have no authority there. The
  lookup reaches a server only through `channels.server_id`, which is NULL for a
  conversation, so this is structural rather than a check somebody remembered.
- **Other servers.** A server timeout is not a platform ban and must never
  quietly become one.
- **Leaving, marking a channel read, and filing a report.** All stay open.
  Reporting especially: the person timed out in a fight is sometimes the one
  with the legitimate complaint, and taking away their escalation route would be
  the most harmful thing this feature could do.

**Voice is a refused join, not a server mute.** A mute is the more surgical
sanction and it is the one this product cannot deliver: in mesh mode the audio
never touches the server, so "muted" would mean asking the sanctioned client to
please stop sending — a suggestion, not enforcement, defeated by any modified
client. The join is refused instead, and anybody already in a room is evicted
when the sanction lands.

**Rank.** Exactly the kick/ban rule: owners may act on anyone below them, admins
only on plain members. An admin who could silence a peer for 28 days would have
routed around "an admin cannot kick an admin". Unlike a ban, a timeout cannot be
pre-emptive — there is nothing to silence about somebody who is not in the
server.

**Expiry needs nothing to be running.** `member_timeouts.expires_at` is compared
against Postgres's `NOW()` on every read, so a sentence ends when it says it
ends whether or not any sweeper, timer or replica is healthy. The daily prune is
disk hygiene only; deleting it would change nothing about who may speak. The
alternative — an `active` flag flipped by a cron — fails in the one direction
that matters, keeping somebody silenced past their time while looking exactly
like the feature working.

**Where it is enforced.** Two chokepoints and one guard, never per-route:

| Surface | Where | Why there |
|---|---|---|
| HTTP | `handleApi`, right after the age gate, write methods only | Same argument as the age gate: 100+ handlers, so a per-route check is a check somebody forgets. It resolves `/api/servers/:id`, `/api/channels/:id` and `/api/messages/:id` from the pathname, so a route nobody has written yet is covered the day it appears |
| WebSocket | top of `handleChatMessage` | **Not** connection-time auth, where the age gate's socket half lives. A socket authenticates once and lives for hours, so a connection-time check would bind nobody who was already online — which is everybody a moderator is reacting to |
| Voice | `join-voice-room` | The only way into a room |

**The sanctioned person is told.** The HTTP surface answers 403 with a sentence
naming the exact end time. The socket sends a `sanction-notice` frame carrying
the same sentence, because a dropped WebSocket frame renders as a red bubble
indistinguishable from the network being down. **Known gap:** the web client does
not render that frame yet — `client/src/App.tsx` routes inbound frames through
an explicit allowlist of chat types and passes everything else to the voice
handler, which drops it. Two lines fix it (add `sanction-notice` to that
allowlist, and a case in `use-chat.ts`); until then a timed-out web user sees
their message fail without being told why, and learns the reason from the
members panel, which shows the timeout on their row.

**Visibility.** `GET /api/servers/:id/timeouts` returns every live timeout with
who issued it, when, why and when it ends, and the members panel renders that on
the member's row. Issuing, extending and lifting are all in the audit log
(`member.timeout`, `member.timeout_lift`); expiry is not, because it is not a
moderator action and noticing it would need the sweeper this design exists
without. The audit entry carries the duration, which matters because the row
itself is deleted when the sanction ends.

### 3.4 Evidence preservation

Before deleting anything in a Tier 0/1 case:

- Screenshot the content and capture message ids and the user's `clerk_id`.
- If the server owner cooperates, `GET /api/servers/:id/export` produces a JSON
  export of the whole server (owner-only, capped at 50,000 messages, and itself
  logged to the audit log as `server.data_export`).
- Note that **deleting a message is irreversible** and cascades to its mentions
  and reactions, and that attachment objects are swept from storage within the
  hour.
- Audit-log rows are pruned at **90 days**. Anything you need beyond 90 days must
  be copied out.

### 3.6 The 18+ age gate

Shipped. The Terms state a hard 18 minimum; this is the mechanism behind that
sentence. It is **self-declaration, enforced** — not verification. Nothing checks
a document, and the public pages must keep saying so.

**What the user does.** On the first authenticated request after signing in, the
app stops on a non-dismissible dialog
(`client/src/components/user/age-gate-dialog.tsx`) asking for a date of birth as
a date — day, named month, year. It says, before the field, that the answer can
be given only once and what happens if it is under 18.

**What is stored** (`users`, three columns, see the comment in `schema.sql`):

| Column | Adult | Under 18 |
|---|---|---|
| `age_checked_at` | set | set |
| `age_check_passed` | `TRUE` | `FALSE` |
| `age_check_dob` | **NULL** | the declared date |

The date is kept only for a refusal, because that is the only case where it is
still needed — it is the evidence an appeal has to be decided on. For an adult
the answer is reduced to the boolean plus the moment of the check, which is what
demonstrates the check ran. All three are on `users`, so account deletion takes
them with the row.

**One attempt, ever.** The declaration is written with
`WHERE age_checked_at IS NULL`, so a second answer is refused by the database
(409) rather than by a code path that could be raced. There is no self-serve way
out of a refusal and no admin UI for one — reversing a block is a manual
`UPDATE` on the row, done only through the appeals process in §4. A malformed or
future date is a 400 and does *not* consume the attempt.

**Enforcement is server-side, in two places, both of them chokepoints.**

| Surface | Where | Behaviour |
|---|---|---|
| HTTP | `handleApi`, before `router.match` (`server/src/api/index.ts`) | 403 on every path, including ones that do not exist |
| WebSocket | `resolveAuthUser` (`server/src/auth/clerk.ts`) | returns null, so the socket closes 4401 exactly as it would for a bad token |

Four routes stay open to a refused account, and the list is in
`AGE_GATE_EXEMPT` (`server/src/services/age-gate.ts`): `GET /api/me` and
`POST /api/me/age-check`, because otherwise the question cannot be answered at
all; and `DELETE /api/me` and `GET /api/me/export`, because **a blocked account
is still a data subject** — LGPD art. 18 rights do not depend on being welcome.
Anything added to that list should have to survive that sentence.

**Existing accounts are prompted, not grandfathered.** Every row that predates
the migration reads NULL, which is `pending`. An account created before the gate
is precisely an account whose age was never asked.

**The date arithmetic is deliberately generous by up to one day.** "Today" is
the latest calendar date in use anywhere on Earth (UTC+14), because refusing is
permanent and admitting somebody a few hours early is not: the alternative
blocks an eighteen-year-old in Kiribati, forever, over a timezone. A 29 February
birthday reaches 18 on 1 March in a non-leap year, matching CC art. 132 §3. All
of it is pinned in `server/src/services/age-gate.test.ts`.

**Operationally**, an account that answered under 18 is already terminated by
the gate — Tier 0 in §3.2 still applies to a *suspected* minor who declared an
adult date, and that case is unchanged: the gate does not detect lying, it only
makes the declaration meaningful and final.

### 3.5 Closing the loop

Tell the reporter the outcome, without disclosing another user's personal data
(no "we banned <name>, here is their email"). Log the decision somewhere durable
— the audit log only records in-server actions taken through the API, not
platform-level decisions or the reasoning behind them.

---

## 4. Appeals runbook

1. Appeals arrive at `{{CONTACT_EMAIL}}`, within 30 days of the action.
2. Confirm the appellant controls the account.
3. There is no independent reviewer, and the Terms now say so outright rather
   than hedging with "where practical". The same person looks at it again with
   whatever the appellant has added. If that ever stops being true — a second
   moderator, a trusted volunteer — change the Terms wording first.
4. Outcome: uphold, reverse, or reduce. Reversing a server ban is
   `DELETE /api/servers/:id/bans/:userId`.
5. Child-safety terminations are final — stated in the Terms.
6. **Server-owner actions are not appealable to us.** A kick or ban inside
   someone's server is their decision. We only intervene when the server itself
   breaks the Terms.

---

## 5. Data-subject request runbook (LGPD + UK GDPR)

**Access/portability and deletion are now self-serve.** Both live in Settings →
*Your data*, and both are the *first* answer to a request that arrives by
email: point the requester at the buttons rather than running anything by hand.
Doing it manually in production, under a 15-day clock, is how a wrong `WHERE`
clause deletes somebody else.

Requests that still arrive at `{{CONTACT_EMAIL}}`. Statutory deadline:
**15 days** for a complete response under LGPD art. 19, II; UK GDPR art. 12(3)
allows a month. Work to the shorter one — the pages say we do.

1. **Verify identity** from the email address on the Clerk account. Do not
   collect an ID document — that is more personal data to hold, for a request
   whose whole point is data minimisation.

2. **Access / portability (art. 18, II and V)** — `GET /api/me/export`,
   *Download my data*. Returns one JSON file
   (`format: "pqp.personal-data-export.v1"`) built by
   `server/src/services/account.ts`: profile, the 18+ declaration, preferences,
   every message the requester wrote with its channel and server context and its
   attachments, servers and roles, conversation participation, blocks, reports
   they filed, and audit entries where they were the actor. Capped at 50,000
   messages with a `truncated` flag, keyset-paginated so a large account cannot
   exhaust server memory, and rate limited to two per ten minutes.

   **It deliberately excludes other people's message bodies, including the other
   half of every DM.** Art. 18, II covers data *concerning the subject*; a
   message somebody else wrote is that person's own expression, and packaging it
   into a forwardable file is a disclosure the requester does not need — they can
   already read it in the app. What they get instead is every conversation they
   were in, who was in it, and how many of the messages were theirs. The
   exclusion is stated in plain language inside the export file itself
   (`notes`), and the full reasoning is in the `EXPORT_NOTES` comment in
   `services/account.ts`. **If a requester genuinely needs the other side — a
   court order, a harassment case — that is an operator decision, made by
   hand, per request. There is no self-serve route to it and there should not
   be.** Reported-content snapshots are excluded on the same grounds.

3. **Correction (art. 18, III).** Mostly self-serve in Settings (display name,
   handle, avatar, DM privacy). Note that `users.display_name` can contain an
   email address, because `server/src/auth/clerk.ts` falls back to the primary
   email when Clerk has no name — worth checking on any access request.

4. **Deletion (art. 18, IV and VI)** — `DELETE /api/me`, *Delete my account*.
   Real deletion; there is no soft-delete flag anywhere on this path. The user
   must type their own handle to confirm.

   **Blocked by owned servers.** If the account owns any server that other
   people are in, the delete answers `409` with `code: "owned_servers"` and the
   servers named, and the UI offers the two remedies inline: transfer ownership,
   or delete the server. It does **not** auto-transfer (ownership carries
   obligations nobody absent has agreed to) and does **not** cascade-delete the
   server (that destroys other members' data to serve one person's right). A
   server the user owns *alone* is not blocking and goes with the account. If a
   user refuses to do either and complains, that is an operator judgement
   call — there is no code path for it.

   **Deleted:** profile, preferences, every message body they wrote, reactions,
   mentions, read cursors, memberships, conversation participation, blocks,
   invites they created, uploaded attachments (rows *and* the S3 objects, which
   are deleted explicitly — the hourly orphan sweeper never sees them, because
   the rows naming them cascade away), and the Clerk identity.

   **Retained**, each on an art. 16 basis rather than on convenience:

   | Record | What happens | Basis |
   |---|---|---|
   | `audit_log` entries where they acted | Row survives, `actor_id` → NULL | Art. 16, I and II. The only record that a moderator deleted a message or banned a member in somebody else's server. If deleting an account erased it, abuse in a server would be one click from being laundered. Already pseudonymised by the NULL, and pruned at 90 days |
   | Bans they issued against others | Row survives, `banned_by` → NULL | Art. 16, II. The row is a fact about the *banned* person and about the server. Cascading it would readmit everybody they ever banned |
   | Reports filed about them | Row and `content_snapshot` survive, `reported_user_id` → NULL | Art. 16, II. The `reports` schema comment already argues it: the report must outlive what it points at, or deleting your account is a way to erase the record of your own conduct. Resolved reports prune at 90 days |
   | Reports they filed | Row survives, `reporter_id` → NULL | A report is a record of somebody else's conduct. An open queue must not empty itself when a reporter leaves |

   **Messages are deleted, not anonymised.** Repointing `author_id` at a shared
   "Deleted User" row is expressible and is the wrong answer: message bodies are
   free text in which people put addresses, phone numbers and health details,
   and art. 5, III only calls data anonymised when it *cannot* be reverted by
   reasonable technical means. Stripping a name off "my flight lands at 6, I'm at
   Rua X 40" does not do that, and everybody who read it live knows who wrote it.
   The honest cost is gaps in other people's threads; replies survive, because
   `messages.reply_to_id` is `ON DELETE SET NULL`.

   **Known abuse gap: deletion is a ban-evasion route.** Bans *against* the
   departing user cascade away with them. Keeping the row would protect nothing
   (it is keyed on `users.id`, and a re-registration gets a fresh uuid), and the
   only durable defence — retaining a hash of the Clerk id after erasure — is a
   new retention decision for counsel, not a code change. **Assessed in full in
   §6.1**, including the three candidate fixes and what each would cost; the
   conclusion is that none may be implemented before the privacy policy
   describes it.

   **Ordering and partial failure.** The sequence is: stamp
   `users.deletion_started_at` → delete the Clerk user → delete the local row.
   Clerk first is the direction that fails safe. If Clerk refuses, the stamp is
   rolled back, nothing is destroyed, and the API answers `502` telling the user
   to retry. The reverse order has no safe state: with the local row gone and
   the Clerk identity alive, the user signs back in and `upsertUser` mints them a
   brand-new empty account while the product reports success. If the process
   dies *after* the Clerk call, the stamped row is picked up by
   `sweepPendingAccountDeletions` (every five minutes, from `server/src/index.ts`)
   which re-runs the Clerk delete — a 404 there counts as success — and then the
   local one. **Nothing here needs a human.** A row that stays stamped across
   several sweeps means Clerk is persistently failing for that account; that one
   does.

   **Live sessions.** The request closes the deleted user's WebSockets and drops
   them from voice on **the instance that served it only**. On a multi-replica
   deploy a socket held elsewhere survives until it drops on its own. Closing
   that gap needs a cluster-bus eviction frame in `server/src/ws/chat.ts`; it is
   not built.

5. **Record** what was requested, what was done, and when. Note that neither
   self-serve route writes an audit entry: `audit_log.server_id` is `NOT NULL`
   and these actions belong to no server, and logging that a named person
   exercised a privacy right — in a log that server admins can read — would be
   its own small disclosure. Keep the record somewhere durable and personal (not
   in the product), and keep it minimal.

---

## 6. Compliance gaps — what is NOT built

Ordered by how badly it hurts at launch.

| Gap | Impact | Status |
|---|---|---|
| **Self-serve account deletion** | LGPD art. 18, IV and VI | **Built** — `DELETE /api/me`, §5.4. Confirmed by typing the handle, refuses while the caller owns a server other people are in, deletes the Clerk identity, and self-heals an interrupted deletion. Remaining gaps are named in §5.4: no cross-replica socket eviction, and deletion is a ban-evasion route |
| **Personal data export** | Art. 18, II and V | **Built** — `GET /api/me/export`, §5.2. Note this is *not* `server/src/services/export.ts`, which is the owner-scoped server tool and exports everyone's messages; the two must stay separate |
| **The other half of a DM in an export** | A subject who needs the other participant's messages (a court order, a harassment case) has no self-serve route, by design | **Deliberately not built.** Per-request operator decision. See §5.2 |
| **Deletion is not disclosed as final to the other party** | Somebody mid-conversation with a deleted account sees their messages vanish with no explanation. Discord shows "Deleted User"; pqp shows a gap | **Known.** A consequence of deleting rather than anonymising (§5.4), and a UX gap rather than a compliance one |
| **Age verification** | Deliberately not built, and the Terms must keep saying so. What ships is a **self-declared 18+ gate** (§3.6): a date of birth, entered once, enforced server-side. No document or ID check — that is disproportionate for this product and would mean holding far more personal data than the 18+ rule needs | **Self-declaration is the launch position.** The gate is built; identity verification is not, and is not planned |
| **In-app reporting** | No report/flag action on messages or users; a user's only self-serve recourse is blocking. Email is the whole reporting surface | **In progress** — another work stream is building it now. Update terms-page.tsx when it lands |
| **Temporary sanctions (timeout/mute)** | The ladder jumped from message deletion straight to ban. No graduated enforcement was possible | **Built** — server-scoped timeouts, §3.7. Enforced at two chokepoints plus the voice join; expiry needs no sweeper. Remaining gap: the web client does not yet render the `sanction-notice` frame (two lines in `App.tsx` and `use-chat.ts`) |
| **Account deletion is a ban-evasion route** | A banned user deletes their account, signs up again, and walks back in. Bans are keyed on `users.id`, which is regenerated on re-registration, and `server_bans.user_id` is `ON DELETE CASCADE` — so the ban rows are gone before the new account even exists | **Deliberately not closed. Needs a retention decision, not a code change.** See §6.1 |
| **Platform-level moderation tooling** | No admin console. Platform-level actions are still mostly manual SQL or borrowing a server owner's permissions | **Partly built** — account termination now has an operator route (`DELETE /api/admin/users/:userId`, §3.3), gated on `INSTANCE_MODERATOR_CLERK_IDS`. There is still no UI, no instance-level audit log, and no operator route for anything else |
| **pt-BR translation of these three pages** | Legal pages have `pages/legal/*.{en,pt-BR}.tsx`. App chrome uses i18next (`docs/I18N.md`) | **Built** |
| **Link-preview cache never purged** | `link_embeds` rows are overwritten on refresh but never deleted. Contains third-party page metadata keyed by URL hash, not tied to a user — low risk, but it is unbounded | **Known** |
| **DMs have no retention and no moderation** | `message_retention_days` joins through `channels.server_id`, which is NULL for DMs, so DM history is kept forever. In a DM only the author can delete a message | **By design; disclosed in the privacy policy** |
| **`DELETE /api/dms/:channelId` hides, it does not delete** | Users may reasonably read "remove conversation" as deletion. Disclosed in the privacy policy; consider relabelling the UI | **Known** |

### 6.1 Ban evasion by account deletion — assessed, deliberately not closed

**The hole is real.** Ban → `DELETE /api/me` → sign up again → rejoin by invite.
`server_bans.user_id` is `ON DELETE CASCADE`, so the ban rows vanish with the
account; even if they did not, they are keyed on `users.id`, and re-registering
mints a fresh uuid that matches nothing. Deleting an account is currently the
cheapest ban-evasion route in the product, and it takes about thirty seconds.

**Every fix requires keeping an identifier after erasure, and that is a
retention decision the owner has to make — not one a code change may make
quietly.** The three candidates, and what each would cost:

1. **Retain a hash of the Clerk id on the ban row.** The narrow, standard
   answer: `server_bans` keeps `sha256(clerk_id)` after the user row goes, and
   `upsertUser` checks it. It works, and it means **pqp retains a
   pseudonymous identifier of a person who exercised their art. 18, IV right to
   erasure**, indefinitely, for the purpose of refusing them service. That is
   arguable under art. 16, II and under legitimate interest, and it is exactly
   the kind of argument that needs the encarregado to sign it, a line in the
   privacy policy describing it, and a retention period attached to it. A hash
   is not anonymisation: it is reversible by anyone holding the Clerk id, which
   is us.
2. **Retain the email hash instead.** Stronger (it survives a new Clerk
   account), and worse: it retains an identifier of a person across identity
   providers, and email is the thing they will most reasonably expect to have
   been erased.
3. **Do nothing durable; make re-entry slower.** Invite-only servers, invite
   expiry, and the report queue already catch the common case, because an
   evader has to be re-invited and their behaviour usually recurs. This is what
   is in place today and it is the honest description of the product's current
   defence.

**Decision: not implemented here.** What is written and enforced instead:
`deleteAccount` states the gap in its own comment rather than hiding it, this
section says it out loud, and §5.4 lists it among the known limits of self-serve
deletion. If the owner decides option 1 is acceptable, it is a small change —
one column, one check in `upsertUser`, one paragraph in the privacy policy — and
the privacy policy paragraph is the part that must land first.

**Note this cuts the other way too.** The operator termination route in §3.3 has
the same property from the other side: terminating a Tier 0 account removes it,
and nothing stops that person signing up again either. For Tier 0 the answer is
not a hash, it is that re-registration is a new account whose conduct is watched
by the same report queue.

### App Store guideline 1.2

Apple's **App Review Guideline 1.2 (User-Generated Content)** requires an app
with UGC to ship, at minimum:

- a method for filtering objectionable material,
- **a mechanism for users to flag objectionable content**,
- **a mechanism for users to block abusive users**,
- published contact information so users can reach the developer,
- and the ability to act on reports by removing content and ejecting offenders.

pqp has **blocking** (`server/src/services/blocks.ts`) and **ejection**
(kick/ban). It does **not** have in-app flagging, which is the item most likely
to draw a rejection — Apple generally wants the report action reachable from the
content itself, not an email address in a policy page. The in-progress reporting
work covers this; treat it as a submission blocker for the iOS app, and make sure
the published contact address is reachable from inside the app too.

---

## 7. Deferred — what would need a lawyer, if this ever gets serious

**Nothing in this section blocks launch.** pqp.gg is one person's project with
no company, no counsel and no revenue, and hiring a lawyer to review a hobby
project's terms is not a proportionate use of money that does not exist. The
pages are written to be *factually accurate about the product* and honest about
what one person can promise; they are not written to be *legally bulletproof*,
and they do not claim to be.

The right trigger for this list is a change in what pqp *is*: taking money,
incorporating, hiring anyone, or growing to a size where a regulator or a
claimant would plausibly bother. Until then, keep the list; do not act on it.

1. **Where the operator sits.** The terms name England and Wales, which is where
   the operator lives. If an entity is ever formed — UK or Brazilian — the
   governing-law clause, the controller identity and `{{OPERATOR_NAME}}` all
   change together, and `{{LEGAL_ENTITY_*}}` comes back with real values.
2. **Marco Civil da Internet (Lei nº 12.965/2014)** — arts. 18–21 set when a
   platform is liable for user content, the general rule that removal follows a
   court order, and the narrower notice-based rule for non-consensual intimate
   content. The Terms deliberately do **not** restate the statute; they say
   where to send a notice and that the operator is an individual in the UK.
   Worth a considered answer eventually: art. 15 contemplates retention of
   application logs, and this application keeps no access logs and stores no IP
   addresses at all. That is a real tension, and the current answer is that not
   collecting is the safer failure.
3. **Legal bases** — the LGPD art. 7 mapping in the privacy policy (and its UK
   GDPR art. 6 equivalents) is a good-faith engineering reading, not advice.
   The weakest link is legitimate interests for moderation and anti-abuse: it
   requires a balancing test that has not been written down.
4. **International transfers** — LGPD art. 33 and UK GDPR chapter V. The pages
   now say plainly that there is no bespoke transfer agreement, only the
   published terms of Clerk, Cloudflare, the host and object storage. That is
   the truth; whether it is *sufficient* is the question for counsel, and it
   cannot be improved without an entity able to sign agreements.
5. **A formal encarregado (LGPD art. 41)** — deliberately not appointed. The
   pages say the operator handles data-protection questions personally and give
   one address. Appointing a titled DPO for a solo project would be theatre; if
   the project ever has staff or scale, revisit.
6. **CDC (Lei nº 8.078/1990) and UK consumer law** — the limitation-of-liability
   and indemnity clauses are standard SaaS language and may be partly
   unenforceable against consumers in either country. The pages carry an
   explicit carve-out for mandatory law and an explicit statement that Brazilian
   users keep their CDC and LGPD rights whatever the governing-law clause says,
   which is the cheapest defence against the clause simply being struck out.
7. **18+ positioning** — the gate in §3.6 is built and enforced, but the
   question is unchanged: whether self-declared age is defensible for an
   adults-only service, and what the Estatuto da Criança e do Adolescente
   requires once a minor is discovered on the platform. Note that the UK Online
   Safety Act's age-assurance duties are aimed at services larger and more
   commercial than this one, but "aimed at" is not "exempt from" — this is the
   item most likely to *become* urgent without the project changing at all.
8. **Deletion and export as built** — self-serve deletion and export exist
   (§5.2, §5.4), so the question is not whether to ship without them but whether
   they are *sufficient*. Specifically: (a) whether excluding the other
   participant's DM messages from an export is the right reading of the access
   right, or whether the balancing test lands the other way; (b) whether the
   art. 16 bases claimed for each retained record — audit entries, bans issued,
   reports — hold up, since they are an engineering reading and not advice;
   (c) whether refusing deletion until an owned server is transferred or deleted
   is defensible against the 15-day clock when the user simply does not act; and
   (d) whether deleting message bodies outright (rather than anonymising the
   author) is required, given that art. 5, III arguably makes anonymisation
   unavailable for free-text content anyway.
9. **pt-BR versions** — still outstanding (§6), and when they exist, which
   language governs if the two ever diverge.

**Not on this list, on purpose:** an SLA (§2), a DPO, a registered address, six
contact aliases, and a negotiated DPA. Those were removed rather than deferred,
because a hobby project cosplaying as a company invites expectations it cannot
meet, and every unmet promise is a liability the wording itself created.
