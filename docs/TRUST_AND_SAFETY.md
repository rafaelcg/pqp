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
| **Terminate an account** | **no endpoint — manual SQL** | See §5. This is the single biggest operational gap |
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

Requests arrive at `{{PRIVACY_EMAIL}}` or `{{DPO_EMAIL}}`. Statutory deadline:
**15 days** for a complete response (art. 19, II).

1. **Verify identity** from the email address on the Clerk account. Do not
   collect an ID document — that is more personal data to hold, for a request
   whose whole point is data minimisation.
2. **Access / portability (art. 18, II and V).** No endpoint exists. Assemble by
   hand from Postgres: `users`, `server_members`, `messages` where
   `author_id = ?`, `message_reactions`, `message_attachments` where
   `uploader_id = ?`, `user_blocks`, `user_preferences`, `channel_reads`,
   `server_invites` created, plus `audit_log` rows where they are the actor.
   Deliver as JSON.
3. **Correction (art. 18, III).** Mostly self-serve in Settings (display name,
   handle, avatar, DM privacy). Note that `users.display_name` can contain an
   email address, because `server/src/auth/clerk.ts` falls back to the primary
   email when Clerk has no name — worth checking on any access request.
4. **Deletion (art. 18, IV and VI).** No endpoint exists. Deleting the `users`
   row cascades to messages, memberships, blocks, preferences, reactions,
   mentions, attachments, invites created, and DM pairs — but **preserves**
   audit-log entries (`actor_id` → NULL), bans they issued (`banned_by` → NULL),
   their pins (`pinned_by` → NULL), and webhooks they created
   (`created_by` → NULL). Also delete the Clerk user. Attachment objects in S3
   are swept hourly once their rows are gone.
   **Write and test this script before launch. Doing it by hand under a 15-day
   clock, in production, is how a wrong `WHERE` clause deletes someone else.**
5. **Record** what was requested, what was done, and when. Retention of that
   record is itself a legal-basis question for counsel.

---

## 6. Compliance gaps — what is NOT built

Ordered by how badly it hurts at launch.

| Gap | Impact | Status |
|---|---|---|
| **Self-serve account deletion** | LGPD art. 18 is a right, not a feature request. Today the only path is an email and a manual SQL delete that has never been run. There is no `DELETE /api/me` | **Not built.** Blocker for a Brazilian launch in anything but the narrowest reading |
| **Personal data export** | Art. 18, V portability. `server/src/services/export.ts` is owner-scoped, exports *everyone's* messages in one server, and is not a data-subject tool | **Not built** |
| **Age verification** | The Terms will say 18+. Nothing collects a date of birth; there is no `age`/`dob` field in `schema.sql` or any Zod schema. Enforcement is self-declaration plus reports. The pages say this plainly — keep it that way | **Not built.** Decide whether self-declaration is the launch position |
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
6. **18+ positioning** — whether self-declared age is defensible for an
   adults-only service in Brazil, and what the Estatuto da Criança e do
   Adolescente requires once a minor is discovered on the platform.
7. **The published SLAs** — once in the Terms they are enforceable promises.
   Counsel and the founder should agree the numbers together.
8. **Deletion obligations** — whether shipping without self-serve deletion is
   acceptable at launch given the manual process described in §5.
9. **pt-BR versions** — and which language governs if the two ever diverge.
