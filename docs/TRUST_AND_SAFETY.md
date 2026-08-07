# Trust & Safety — pqp.gg

Operational companion to the three public legal pages:

- `client/src/pages/terms-page.tsx`
- `client/src/pages/privacy-page.tsx`
- `client/src/pages/cookies-page.tsx`

> **STATUS: DRAFT. NOT CLEARED FOR LAUNCH.**
> The pages are written to be factually true about the product as built, but they
> contain unfilled placeholders and have **not** been reviewed by a Brazilian
> lawyer. Do not publish them until the checklist below is empty and counsel has
> signed off. See [What a lawyer must review](#what-a-lawyer-must-review).

---

## 1. Placeholder checklist

Every token below appears literally as `{{TOKEN}}` in the page source. Grep to
find them:

```bash
grep -rn "{{" client/src/pages/terms-page.tsx client/src/pages/privacy-page.tsx client/src/pages/cookies-page.tsx
```

There is no build-time substitution — these are literal strings that will render
to users as `{{LIKE_THIS}}` if shipped. That is deliberate: an unfinished legal
page should look unfinished.

### Legal entity — **founder / accountant**

| Token | What it is | Pages |
|---|---|---|
| `{{LEGAL_ENTITY_NAME}}` | Registered company name (razão social) operating pqp.gg | terms, privacy |
| `{{LEGAL_ENTITY_CNPJ}}` | CNPJ | terms, privacy |
| `{{LEGAL_ENTITY_ADDRESS}}` | Registered address (endereço da sede) | terms, privacy |

### Contact addresses — **founder / ops**

These render as plain text, not `mailto:` links, precisely so an unfilled one
cannot become a broken link. Turn them into `mailto:` anchors when filled.

| Token | What it is | Pages |
|---|---|---|
| `{{SUPPORT_EMAIL}}` | General user support | terms |
| `{{LEGAL_EMAIL}}` | Legal notices, copyright/IP takedowns, service of process | terms |
| `{{ABUSE_EMAIL}}` | Abuse, safety, underage-account reports. **The one that matters most** — it is the reporting channel until the in-app report flow ships | terms, privacy |
| `{{PRIVACY_EMAIL}}` | LGPD data-subject requests, account deletion requests | terms, privacy, cookies |
| `{{SECURITY_EMAIL}}` | Vulnerability disclosure | privacy |
| `{{APPEAL_EMAIL}}` | Moderation appeals. May be the same mailbox as `{{ABUSE_EMAIL}}`, but a separate alias makes the queue separable later | terms |

### LGPD roles — **founder + counsel**

| Token | What it is | Pages |
|---|---|---|
| `{{DPO_NAME}}` | Name of the *encarregado* (LGPD art. 41). Can be a natural person or a named role at a firm; must be publicly identified | privacy |
| `{{DPO_EMAIL}}` | Encarregado's contact address. Must be a real, monitored mailbox — the ANPD uses it | privacy |

### Jurisdiction — **Brazilian counsel**

| Token | What it is | Pages |
|---|---|---|
| `{{GOVERNING_LAW}}` | Governing law (expected: the laws of the Federative Republic of Brazil — confirm) | terms |
| `{{FORUM_CITY_STATE}}` | Elected forum (foro de eleição), city and state | terms |
| `{{MARCO_CIVIL_NOTICE_PROCEDURE}}` | How judicial removal orders and out-of-court notices under Lei nº 12.965/2014 are received and actioned, and the address for service. **Counsel must draft this text — do not write it from the codebase** | terms |

### Dates — **founder**

| Token | What it is | Pages |
|---|---|---|
| `{{EFFECTIVE_DATE}}` | The "Last updated" date. Set it to the date counsel signs off, not the date the draft was written | all three |
| `{{BR_MIGRATION_TARGET}}` | Target date/quarter for the São Paulo migration named in the privacy policy. If there is no committed date, rewrite that sentence rather than inventing one | privacy |

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
| `{{TRANSFER_SAFEGUARD}}` | The LGPD art. 33 basis for international transfers — e.g. ANPD standard contractual clauses, or contractual safeguards in each provider's DPA | Requires actually having the DPAs. **Counsel + founder** | privacy |

### SLAs — **founder, see §2**

| Token | Pages |
|---|---|
| `{{URGENT_REPORT_SLA_HOURS}}` | terms |
| `{{STANDARD_REPORT_SLA_HOURS}}` | terms |
| `{{TAKEDOWN_SLA_HOURS}}` | terms |
| `{{APPEAL_SLA_DAYS}}` | terms |

---

## 2. Proposed SLAs — **PROPOSAL ONLY, NOT YET COMMITTED**

> Nothing in this table is a commitment. These are industry-typical numbers
> offered as a starting point for a one-person-on-call operation. **Pick numbers
> you can actually hit at 3am on a Sunday**, because the moment they go on the
> Terms page they are a public promise, and missing them is worse than never
> having published them. Halving these to look responsive is the classic
> mistake.

| Token | Applies to | Proposed | Reasoning |
|---|---|---|---|
| `{{URGENT_REPORT_SLA_HOURS}}` | CSAM, sexualisation of minors, credible threat of violence, non-consensual intimate images, active self-harm | **4 hours** to first action | These cannot wait for business hours. 4h is achievable for a solo operator with phone alerts on the abuse mailbox; 1h implies a rota that does not exist |
| `{{STANDARD_REPORT_SLA_HOURS}}` | Acknowledgement of any other report | **48 hours** | An acknowledgement is cheap; promise it and keep it |
| `{{TAKEDOWN_SLA_HOURS}}` | Decision on a standard report (harassment, spam, IP claim) | **72 hours** | Leaves room for a weekend. Note this is a *decision*, which may be "no violation" |
| `{{APPEAL_SLA_DAYS}}` | Response to a moderation appeal | **10 days** | Appeals are rare and low-urgency; a longer, kept promise beats a short, missed one |

LGPD-driven timelines are **statutory, not chosen**:

| Obligation | Deadline | Source |
|---|---|---|
| Complete response to a data-subject request | 15 days | LGPD art. 19, II |
| Breach notification to ANPD and affected people | "reasonable time" as set by ANPD | LGPD art. 48 |

Route alerts so that a message to `{{ABUSE_EMAIL}}` reaches a phone, not an
inbox somebody reads on weekdays. Without that, the 4-hour number is fiction.

---

## 3. Report intake and triage runbook

### 3.1 Intake channels

| Channel | Status |
|---|---|
| `{{ABUSE_EMAIL}}` | **The only channel today.** Must be live before launch |
| In-app report button | **In progress** — being built now by a separate work stream. Update the Terms page ("We are building an in-app report button…") when it ships |
| Server owner / admin escalation | Informal. Owners moderate their own servers with kick/ban/delete; there is no route from a server owner to us except email |

### 3.2 Triage tiers

**Tier 0 — immediate, no warning step.**
CSAM or any sexualisation of a minor; credible, specific threat of violence;
non-consensual intimate imagery; a user who is or appears to be under 18.

1. Preserve evidence **before** deleting anything (see §3.4).
2. Terminate the account. Ban from the server(s) involved.
3. For CSAM: preserve and report to the competent authorities. **Get counsel's
   written instruction on the reporting path in Brazil before you need it** —
   this is a mandatory-reporting question, not an engineering one, and the wrong
   handling of the material is itself an offence.
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
| Change a role | `PATCH /api/servers/:id/members/:userId` | Owner only |
| Delete a channel or a whole server | server routes | Owner/admin |
| **Terminate an account** | **still no operator endpoint** | `DELETE /api/me` (§5.4) is a *self-serve* route: it authenticates as the account being deleted and there is no way to aim it at somebody else. Terminating a Tier 0 account is therefore still manual SQL — but `deleteAccount` in `server/src/services/account.ts` is now a tested, correctly-ordered implementation of exactly that sequence (Clerk first, then the row, plus the S3 sweep). Wrapping it in an operator route is a small job; nobody has done it |
| **Timeout / mute / suspend** | **does not exist** | There is no temporary sanction of any kind. The ladder jumps from "delete the message" to "ban". Do not write a warning-then-timeout policy the product cannot execute |

`servers.message_retention_days` (owner-set, daily sweep, pinned messages exempt)
is a retention feature, not a moderation tool, and never touches DMs.

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

1. Appeals arrive at `{{APPEAL_EMAIL}}`, within 30 days of the action.
2. Confirm the appellant controls the account.
3. Where practical, route to someone who did not make the original call. With a
   one-person team this is not possible — say so honestly rather than claiming a
   separation of duties that does not exist. The Terms already hedge this
   ("where practical").
4. Outcome: uphold, reverse, or reduce. Reversing a server ban is
   `DELETE /api/servers/:id/bans/:userId`.
5. Child-safety terminations are final — stated in the Terms.
6. **Server-owner actions are not appealable to us.** A kick or ban inside
   someone's server is their decision. We only intervene when the server itself
   breaks the Terms.

---

## 5. LGPD data-subject request runbook

**Access/portability and deletion are now self-serve.** Both live in Settings →
*Your data*, and both are the *first* answer to a request that arrives by
email: point the requester at the buttons rather than running anything by hand.
Doing it manually in production, under a 15-day clock, is how a wrong `WHERE`
clause deletes somebody else.

Requests that still arrive at `{{PRIVACY_EMAIL}}` or `{{DPO_EMAIL}}`. Statutory
deadline: **15 days** for a complete response (art. 19, II).

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
   court order, a harassment case — that is an encarregado decision, made by
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
   user refuses to do either and complains, that is an encarregado judgement
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
   new retention decision for counsel, not a code change.

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
   its own small disclosure. Retention of the encarregado's own record is a
   legal-basis question for counsel.

---

## 6. Compliance gaps — what is NOT built

Ordered by how badly it hurts at launch.

| Gap | Impact | Status |
|---|---|---|
| **Self-serve account deletion** | LGPD art. 18, IV and VI | **Built** — `DELETE /api/me`, §5.4. Confirmed by typing the handle, refuses while the caller owns a server other people are in, deletes the Clerk identity, and self-heals an interrupted deletion. Remaining gaps are named in §5.4: no cross-replica socket eviction, and deletion is a ban-evasion route |
| **Personal data export** | Art. 18, II and V | **Built** — `GET /api/me/export`, §5.2. Note this is *not* `server/src/services/export.ts`, which is the owner-scoped server tool and exports everyone's messages; the two must stay separate |
| **The other half of a DM in an export** | A subject who needs the other participant's messages (a court order, a harassment case) has no self-serve route, by design | **Deliberately not built.** Per-request encarregado decision. See §5.2 |
| **Deletion is not disclosed as final to the other party** | Somebody mid-conversation with a deleted account sees their messages vanish with no explanation. Discord shows "Deleted User"; pqp shows a gap | **Known.** A consequence of deleting rather than anonymising (§5.4), and a UX gap rather than a compliance one |
| **Age verification** | Deliberately not built, and the Terms must keep saying so. What ships is a **self-declared 18+ gate** (§3.6): a date of birth, entered once, enforced server-side. No document or ID check — that is disproportionate for this product and would mean holding far more personal data than the 18+ rule needs | **Self-declaration is the launch position.** The gate is built; identity verification is not, and is not planned |
| **In-app reporting** | No report/flag action on messages or users; a user's only self-serve recourse is blocking. Email is the whole reporting surface | **In progress** — another work stream is building it now. Update terms-page.tsx when it lands |
| **Temporary sanctions (timeout/mute)** | The ladder jumps from message deletion straight to ban. No graduated enforcement is possible | **Not built** |
| **Platform-level moderation tooling** | No admin console. Every platform-level action is manual SQL or borrowing a server owner's permissions | **Not built** |
| **pt-BR translation of these three pages** | A privacy policy in English for a Brazilian audience is bad practice and arguably defeats informed consent. Only Clerk's sign-in modal is translated (`client/src/lib/locale.ts`); the app's own strings, including these pages, are English-only | **Not built** |
| **Link-preview cache never purged** | `link_embeds` rows are overwritten on refresh but never deleted. Contains third-party page metadata keyed by URL hash, not tied to a user — low risk, but it is unbounded | **Known** |
| **DMs have no retention and no moderation** | `message_retention_days` joins through `channels.server_id`, which is NULL for DMs, so DM history is kept forever. In a DM only the author can delete a message | **By design; disclosed in the privacy policy** |
| **`DELETE /api/dms/:channelId` hides, it does not delete** | Users may reasonably read "remove conversation" as deletion. Disclosed in the privacy policy; consider relabelling the UI | **Known** |

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

## 7. What a lawyer must review

**A Brazilian lawyer must review all three pages before launch.** These drafts
are written to be *factually accurate about the product*; they are not written to
be *legally sufficient*. Specific items to put in front of counsel:

1. **Marco Civil da Internet (Lei nº 12.965/2014)** — arts. 18–21 set when a
   platform is liable for user content, the general rule that removal follows a
   court order, and the narrower notice-based rule for non-consensual intimate
   content. The Terms carry a factual placeholder
   (`{{MARCO_CIVIL_NOTICE_PROCEDURE}}`) and deliberately do **not** attempt to
   restate the statute. Counsel drafts that clause, and confirms the retention of
   application logs the statute contemplates (art. 15) against the fact that this
   application currently keeps no access logs and stores no IP addresses — that
   is a genuine tension worth a considered answer.
2. **LGPD legal bases** — the art. 7 mapping in the privacy policy is a
   good-faith engineering reading, not legal advice. Confirm especially the
   legitimate-interest basis for moderation and anti-abuse (art. 7, IX, which
   requires a balancing test that has not been documented), and whether a
   legitimate-interest impact assessment is expected.
3. **International transfers (art. 33)** — which basis actually applies, and
   whether the DPAs with Clerk, Cloudflare, the hosting provider and object
   storage support it. `{{TRANSFER_SAFEGUARD}}` cannot be filled without those
   agreements in hand.
4. **The encarregado** — must be appointed and publicly named (art. 41).
5. **CDC (Lei nº 8.078/1990)** — the limitation-of-liability and indemnity
   clauses are standard SaaS language and may be partly unenforceable against
   consumers. The draft carries an explicit carve-out for mandatory law; counsel
   should confirm it is enough, and check the foro de eleição against consumer
   rules.
6. **18+ positioning** — the gate in §3.6 is built and enforced, but the
   question is unchanged: whether self-declared age is defensible for an
   adults-only service in Brazil, and what the Estatuto da Criança e do
   Adolescente requires once a minor is discovered on the platform.
7. **The published SLAs** — once in the Terms they are enforceable promises.
   Counsel and the founder should agree the numbers together.
8. **Deletion and export as built** — self-serve deletion and export now exist
   (§5.2, §5.4), so the question for counsel is no longer whether to ship
   without them but whether these two are *sufficient*. Specifically:
   (a) whether excluding the other participant's DM messages from an export is
   the right reading of art. 18, II and V, or whether the balancing test lands
   the other way; (b) whether the art. 16 bases claimed for each retained
   record — audit entries, bans issued, reports — hold up, since they are an
   engineering reading and not advice; (c) whether refusing deletion until an
   owned server is transferred or deleted is defensible against the 15-day
   clock in art. 19, II when the user simply does not act; and (d) whether
   deleting message bodies outright (rather than anonymising the author) is
   required, given that art. 5, III arguably makes anonymisation unavailable
   for free-text content anyway.
9. **pt-BR versions** — and which language governs if the two ever diverge.
