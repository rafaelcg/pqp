# Illegal content risk assessment — pqp.gg

**Record kept under section 23 of the Online Safety Act 2023.**
Assessment carried out under section 9.

> **What this is.** A self-assessment, drafted by reading pqp's own source code
> and documentation. **It has not been reviewed by a lawyer.** The operator of
> pqp.gg is responsible for its accuracy and for acting on it. Where it says a
> control exists, a file path is given so the claim can be checked; where it
> says something does not exist, that is a statement about the code as it stands
> on the date below and nothing more.
>
> This record is not filed with anyone. It is kept, and Ofcom can require it to
> be produced. It is written in plain English because it is meant to be read.

---

## 0. Record header

Ofcom's Risk Assessment Guidance, Table 8, lists what the record of a risk
assessment should contain. This section carries the header fields; the rest of
the document carries the substance, arranged in Ofcom's four steps.

| Field | Entry |
|---|---|
| Service | **pqp.gg** — the hosted instance operated at `pqp.gg` / `pqp-3yr.pages.dev` with its API on Railway. Self-hosted copies of the open-source code are separate services with separate providers; this record does not cover them. |
| Kind of service | Regulated user-to-user service (Part 3, Chapter 2). Not a search service. Not a provider of pornographic content under Part 5. |
| Date completed | **7 August 2026** |
| Date reviewed / updated | Not yet reviewed. This is version 1. |
| Completed by | The operator (one person). Drafted with AI assistance from the codebase; every factual claim about the product is sourced to a file. |
| Approved by | The operator. There is nobody else to approve it. |
| Named person responsible | The operator. **Ofcom expects a named individual.** The public pages deliberately identify him by role rather than name for personal-safety reasons; the operator should write his own name into his own copy of this record, since the record is not published. |
| Ofcom Risk Profiles consulted | Yes — see [Step 1](#step-1--the-kinds-of-illegal-content-to-be-assessed). |
| Next scheduled review | **7 August 2027**, or earlier on any trigger in [Step 4](#step-4--report-review-and-update). |
| Retention | Superseded versions to be kept for at least three years (Record-Keeping and Review Guidance, §2.6). |

### Guidance this record follows

| Document | Version used |
|---|---|
| Ofcom, *Risk Assessment Guidance and Risk Profiles* | V2.0, published **25 June 2026** |
| Ofcom, *Illegal Content Codes of Practice for user-to-user services* | 26 February 2025 |
| Ofcom, *Record-Keeping and Review Guidance* | Updated 25 June 2026 |

V2.0 of the Risk Assessment Guidance replaced "17 kinds of priority illegal
content" with **18**, to reflect new priority offences. This record assesses all
18, plus the three CSEA sub-categories Ofcom requires user-to-user services to
assess separately, plus other (non-priority) illegal content.

### Timing — is this record late?

Stated plainly rather than tidied up.

The first illegal content risk assessment was due **16 March 2025** for services
that were already operating. pqp was not: the repository's first commit is
**11 July 2026**, and the hosted instance became reachable at a public URL
around that date. Public launch is **7 August 2026**, the date of this record.

So the honest position is two-sided:

- Against the 16 March 2025 deadline, this is not late, because the service did
  not exist. The project's own `docs/CONTENT_SAFETY.md` §2 describes the
  assessment as "already overdue" against that date; **that characterisation was
  wrong and this record supersedes it.**
- Against the duty itself, the duty attaches when the service becomes a
  regulated service — when it is reachable by users — not when it is announced.
  The hosted instance has been reachable for roughly four weeks. Ofcom allows a
  new service three months from launch to complete its first assessment, so this
  record is within time, but it should be understood as having been written
  about a service that was already live, not before it went live.

**Nothing here is backdated.** If the operator knows the service was reachable
by users earlier than 11 July 2026, that date belongs in this box and changes
the answer.

### What this record does not cover

Four adjacent duties are **not** discharged by this document. Naming them is
part of being honest about scope.

1. **The children's access assessment**, and — if the service is likely to be
   accessed by children — the **children's risk assessment** and the children's
   safety duties. pqp's position is that it is an adults-only service, but that
   position rests on a self-declared date of birth, which is not a reliable
   basis for concluding children cannot access it. See §1.4.
2. **Highly effective age assurance.** pqp does not have it and does not claim
   it (§2.2, control C7).
3. **The transparency reporting duties**, which apply to categorised services.
   pqp is not categorised.
4. **Data protection.** UK GDPR / LGPD work lives in `docs/TRUST_AND_SAFETY.md`.

### Is pqp in scope of the Act at all?

Yes, on the operator's own assessment.

pqp is a user-to-user service: users generate content that other users
encounter. The Act applies to a service with links to the UK. pqp has them on
more than one reading — **the operator is in the UK**, the service is capable of
being used in the UK, and it is not restricted to non-UK users. The intended
audience is largely Brazilian, which changes nothing: the Act applies regardless
of where the provider is based, and a UK-based provider with UK-accessible
service does not get to opt out.

There is **no size exemption** in the Act. Duties scale by proportionality, not
by switching off. The one genuine size threshold that does apply is Ofcom's fee
regime, which starts at £250m qualifying worldwide revenue; pqp has **no
revenue** and is nowhere near it.

---

## Step 1 — The kinds of illegal content to be assessed

*Ofcom's Step 1: identify the 18 kinds, identify other illegal content, consult
the Risk Profiles, and understand how the service could be used to commit or
facilitate an offence.*

### 1.1 What the service actually is

Every statement below is checkable in the repository. This is the description
the rest of the assessment reasons from, and it is deliberately the product as
built rather than the product as pitched.

**Shape.** Servers → channels (`text` or `voice`) → messages. Plus direct
messages and group DMs, which sit outside any server. Roles are
`owner` / `admin` / `member`. Usernames are `name#1234`.

**Getting in.** Sign-in is via Clerk; an account is required for everything.
There is **no public server directory, no browse, no recommendation feed, no
trending, no algorithmic ranking of any kind.** `GET /api/servers` returns only
the caller's own memberships. Joining a server requires an **invite link**, or —
where a server owner has opted in — a verified email domain match
(`servers.sso_email_domain`, exact match only). This closed-discovery property
is the single most important risk-reducing fact about pqp and it is reasoned
about throughout, not just listed.

**One qualification to "closed".** There *is* an instance-wide user search:
`GET /api/users/search` runs a username prefix match over the whole `users`
table with no relationship scoping (`server/src/services/users.ts:269`). The
code comment at `server/src/api/index.ts:278` calls it "an enumeration surface
over every account on the instance". It returns only public profile fields and
carries the tightest rate-limit budget in the file (15 burst, 0.5/s), but it
means a stranger can find a handle they do not already know. Whether they can
then message it is governed by `users.dm_privacy`, which defaults to
`server_members` — not `everyone`. That default is doing real work and is
treated as a control (§2.2, C5).

**Voice, and what it means for moderation.** Voice channels are full-mesh
WebRTC between participants, or LiveKit SFU where configured. **Media never
passes through the operator's servers, is not recorded, and is not retained.**
Only signalling and presence cross the operator's WebSocket. This is a
structural limit, not a failure to try: there is nothing to scan because nothing
arrives.

**Screen sharing exists, and it is video.** `use-voice.ts:1016` calls
`getDisplayMedia({ video: true })`; one participant per voice channel may share
at a time. It travels the same peer-to-peer or SFU path as audio, and is
therefore **live video that is never recorded, never stored and never
observable by the operator.** For Ofcom's purposes this makes pqp a service with
a livestreaming functionality, which is a risk factor for grooming and for
image-based CSAM. Anyone reasoning about pqp as "audio only" is reasoning about
a different product.

**Attachments.** The browser PUTs bytes straight to Cloudflare R2 with a
presigned URL; the API only signs URLs and issues a `HEAD`. Bytes never enter
the API process. Image scanning runs at **claim time** — before the attachment
is visible to anyone — in `verifyPendingAttachments`
(`server/src/services/attachments.ts:506`).

**Direct messages are unmoderated.** No server owner or admin can see them; the
visibility predicate gives conversations no role escape hatch
(`server/src/services/users.ts:591`). In a DM, **only the author can delete a
message** — there is no moderator to delete it for them. DMs are also excluded
from per-server retention structurally: retention joins through
`channels.server_id`, which is NULL for DMs, so DM history is kept forever.

**Age.** 18+, by self-declared date of birth, asked once, enforced at the HTTP
and WebSocket chokepoints (`server/src/services/age-gate.ts`).

**Who runs it.** **One person.** No company, no revenue, no employees, no
moderation staff, no on-call rotation. This is a risk factor and is treated as
one throughout — it is not something to be argued around.

**How many users.** Effectively zero. The service launches today.

### 1.2 Evidence, and its limits

Ofcom expects a risk assessment to rest on evidence, and expects "core evidence"
— user complaints, moderation outputs, service data — to be consulted at
minimum. **pqp has none of it, because it has no users.**

That is stated here rather than papered over, because the alternative — writing
an assessment that implies operating experience the service has not had — is
worse than an assessment that names its own limits. Ofcom's guidance
specifically contemplates this: a service may need to assess as medium risk
"even though it has not faced any CSEA offences and such an occurrence may
appear unlikely", because perpetrators exploit functionality, not track records.

So the evidence base for this assessment is:

| Input | Used |
|---|---|
| Ofcom's U2U Risk Profiles (Table 9) and Risk Level Tables | Yes — the primary input |
| Ofcom's Register of Risks reasoning, as summarised in the Risk Profiles | Yes |
| The service's own code and schema | Yes — the primary input for what controls exist |
| `docs/CONTENT_SAFETY.md`, `docs/TRUST_AND_SAFETY.md` | Yes |
| User complaints and reports | **None exist** |
| Content moderation outputs | **None exist** |
| Product testing, external audit, expert consultation | **None.** Not proportionate at this size, and honestly: not affordable |
| General knowledge of how comparable services (Discord-shaped chat) are abused | Yes, and flagged as inference rather than evidence wherever relied on |

**Everything in Step 2 is therefore prospective.** It is a judgement about what
the design makes possible, not a report of what has happened. The first real
evidence will arrive as user reports, and the review triggers in Step 4 are
written to catch that.

### 1.3 Ofcom Risk Profiles questionnaire (Figure 1)

Recorded in full, because Ofcom's essential record for Step 1 is confirmation
that the Risk Profiles were consulted and a list of the risk factors found.

| # | Question | Answer | Note |
|---|---|---|---|
| 1a | Social media service | **Yes** | Servers are communities built around common interests |
| 1b | Messaging service | **Yes** | DMs and group DMs |
| 1c | Gaming service | No | |
| 1d | Adult service | **No — but read the note** | Not *primarily* for disseminating adult content, so the risk factor does not apply. But pqp is 18+ and its acceptable-use rules **deliberately do not prohibit adult nudity** (`client/src/pages/terms-page.tsx`). It sits closer to this factor than a plain "no" suggests, and §2.4 categories 7 and 18 turn on that |
| 1e | Discussion forum / chat room | **Yes** | Text channels readable by everyone in a server |
| 1f | Marketplace or listing service | No | No commerce feature of any kind |
| 1g | File-storage / file-sharing service | No | Attachments are incidental to messages; there is no store-and-share-a-link product |
| 2 | Do child users access some or all of the service? | **Cannot be excluded** | Policy says no; the mechanism is a self-declared date of birth, which does not detect lying. Treated as **Yes** wherever treating it as No would lower a risk level |
| 3a | User profiles viewable by others | **Yes** | Handle, display name, avatar. **No age or date of birth is displayed** |
| 3b | Anonymous sharing / no account needed | No | Account always required; handles are pseudonymous |
| 4a | Users can connect with other users | **Partly** | No follow/subscribe. But instance-wide handle search plus DM initiation is functionally connection-forming (§1.1) |
| 4b | Closed groups or group messages | **Yes** | Private channels, group DMs, invite-only servers |
| 5a | Livestreaming | **Yes** | Live voice, and **live video via screen share** |
| 5b | Direct messaging | **Yes** | |
| 5c | Encrypted messaging | **Text: no. Voice and screen share: effectively yes** | Text is stored in Postgres and readable by the operator. Voice/video is peer-to-peer WebRTC, DTLS-SRTP, never recorded — for risk purposes it behaves exactly like encrypted messaging: the operator cannot see it, cannot scan it, cannot retrieve it after the fact |
| 5d | Commenting on content | No | Replies and reactions exist, but they are messages, not comments on published content |
| 5e | Posting or sending images or videos | **Yes** | Images, video files, audio files, PDFs |
| 5f | Posting or sending location information | No | No feature; a user can type an address |
| 5g | Re-posting / forwarding | No | No repost feature; message links exist |
| 6 | Posting goods or services for sale | No | |
| 7a | Searching for user-generated content | **Yes, scoped** | Full-text message search, constrained by the same visibility predicate as reading (`server/src/services/search.ts`). A user can only search what they could already read |
| 7b | Hyperlinking | **Yes** | Links are sendable and are unfurled into embeds |
| 8 | Content or network recommender systems | **No** | Nothing recommends anything to anyone |

### 1.4 Risk factors identified

From the answers above, these Risk Profile factors apply to pqp:

**Social media services · Messaging services · Discussion forums and chat rooms
· User profiles · User groups · Group messaging · Direct messaging ·
Livestreaming · Posting images or videos · User-generated content searching ·
Hyperlinking.**

And, treated as applying because it cannot be ruled out: **child users**.

Ofcom maps these to harms. Two of them are broad: *social media services*
carries an increased risk of **all** kinds of illegal harm, and *messaging
services* carries increased risk of **nearly all** kinds except intimate image
abuse and extreme pornography. That is why very few categories below land at
negligible.

Factors that **do not** apply, and which matter because their absence is the
main thing holding several risk levels down: content and network recommender
systems, anonymous posting without an account, marketplace/listing, goods for
sale, re-posting and forwarding, file-storage and file-sharing, and any public
discovery surface.

### 1.5 Additional characteristics not covered by the Risk Profiles

Ofcom asks for these separately. They are the characteristics that make pqp
different from a generic service with the same feature list.

| Characteristic | Effect on risk |
|---|---|
| **One operator, no staff, no revenue** | **Raises risk.** There is no moderation capacity beyond one person's spare attention. Every "report leads to review" claim in this document is a claim about one person's inbox. Ofcom's Codes recommend resourcing and performance targets for multi-risk services; there is no resource to allocate |
| **Zero users at assessment** | Lowers *current* likelihood across the board; changes nothing about design-driven risk. Also means no evidence exists (§1.2) |
| **Closed discovery** | **Materially lowers risk** for the harms that need an audience or a stranger-matching mechanism — drugs, weapons, trafficking, sexual exploitation of adults, foreign interference. A dealer cannot reach a buyer who cannot find them. This is the single biggest structural mitigation pqp has |
| **Voice and screen share never touch the operator's servers** | **Raises undetectability, not incidence.** Anything said or shown in voice is beyond every control in this document except a user report. Genuinely structural |
| **DMs and group DMs are unmoderated and never expire** | **Raises risk**, particularly for grooming, harassment, coercive control, intimate image abuse and cyberflashing. There is no moderator in a DM, and history is kept forever |
| **Adult nudity is permitted by the terms** | **Raises risk** for extreme pornography, intimate image abuse and cyberflashing — the automated classifier is deliberately configured to ignore adult sexual content, so the signal that would catch these on a general-audience service is switched off here by design |
| **Open source** | Neutral for this record. A self-hoster is a separate provider of a separate service with their own duties |
| **No revenue, no ads, no monetisation** | Lowers risk. No incentive to maximise engagement, no ad-fraud surface, no payments to launder |
| **Users predominantly non-UK (Brazil intended)** | Does not reduce duties. UK users are not excluded and the operator is UK-based |

### 1.6 How the service could be used to commit or facilitate an offence

Ofcom requires U2U services to consider this separately from users
*encountering* content. For pqp the realistic mechanisms are:

- **A private channel or a group DM as a coordination space.** Invite-only,
  no discovery, no retention limit unless an owner sets one, one moderator who
  cannot see DMs at all. This is the shape used for coordinating almost any
  offence, and it is a shape pqp provides well.
- **A DM as a one-to-one approach.** Grooming, coercive control, harassment,
  sextortion, fraud. The DM privacy default limits who can open one; it does not
  limit what happens once opened.
- **Voice or screen share as an unobservable channel.** Anything at all.
- **An invite link as a distribution mechanism.** Invite links default to
  **unlimited uses and no expiry** (`packages/shared/src/api.ts:488` — both
  fields optional and nullable). A link posted elsewhere is a durable open door
  into a private space.
- **The service as a staging post.** Perpetrators commonly move targets from a
  service where they met to a more private one. pqp works in both directions:
  it can be the private destination, and its DMs can be used to move someone
  onward to a service with no controls at all.

---

## Step 2 — Assess the risk of harm

*Ofcom's Step 2: assess likelihood and impact for each kind, consider how the
service is used including unintended uses, consider the effectiveness of
existing controls, and assign a risk level using the Risk Level Tables.*

### 2.1 How risk levels were assigned

Using Ofcom's General Risk Level Table (Table 13) and, for CSEA, the three
specific tables (13.1 image-based CSAM, 13.2 CSAM URLs, 13.3 grooming).

Two rules from the guidance shaped the answers:

- **Where evidence is inconclusive, err on the side of caution and pick the
  higher level** (Risk Assessment Guidance §3.3). With zero users, the evidence
  is inconclusive everywhere.
- **Severity can drive the level on its own.** "If the severity of the harm were
  high, then even a small number of instances would mean your service was not
  low risk."

The result is a document with more Mediums than an operator would like. That is
the honest output of applying Ofcom's own tables to a service with messaging,
private groups, direct messages, image sharing, livestreaming and one part-time
moderator. **An assessment that concluded everything was low risk would not be
credible and would not be useful.**

### 2.2 Existing controls, and how much credit each deserves

Ofcom asks for controls to be recorded with what they mitigate, how, and what
effect they had on the assigned risk level. Every row below is code that exists.

| # | Control | Where | What it mitigates | Honest weight |
|---|---|---|---|---|
| C1 | **In-app reporting** of a message or a user, with a **content snapshot captured at report time** | `server/src/services/reports.ts`, `server/src/schema.sql:876` | Everything. It is the only detection mechanism for most categories | **High value, single point of failure.** Every FK is `ON DELETE SET NULL`, never CASCADE, so a report survives the deletion of what it points at — deleting the evidence does not delete the report. Its weakness is not the code, it is that one person reads the output |
| C2 | **DM reports route to an instance-level queue**, structurally separated from server queues by a DB CHECK | `reports.ts`, `schema.sql` | Ensures a server admin can never read a DM report, and that DM reports reach the operator | Correct by construction. **But see G1: there is no UI for that queue and it is gated on an env var** |
| C3 | **Kick and ban**, with rejoin prevention and voice/SFU ejection | `server/src/services/moderation.ts`, `server/src/voice/admin.ts`, `server/src/services/invites.ts:88` | Removing an offender from a community | Solid. Ban is checked inside the invite-redemption transaction, and SFU ejection re-sweeps every 5s for the token TTL because self-hosted LiveKit ignores token revocation. Bans are permanent (no expiry column) |
| C4 | **Message deletion** | `DELETE /api/messages/:messageId` | Removing illegal content | Works in server channels. **Does not exist as a moderation tool in DMs** — only the author can delete |
| C5 | **Blocking, and DM privacy defaulting to `server_members`** | `server/src/services/blocks.ts`, `server/src/services/dms.ts:76` | Harassment, cyberflashing, unsolicited approach by strangers | Genuinely effective, and enforced server-side at every point. The default matters more than the feature: a stranger found by handle search cannot open a DM unless they share a server |
| C6 | **Closed discovery** | Absence of code, verified | Drugs, weapons, trafficking, sexual exploitation, fraud reach, foreign interference | The strongest mitigation pqp has, and the cheapest to lose |
| C7 | **18+ age gate**, one attempt, refusals recorded and permanent | `server/src/services/age-gate.ts`, `schema.sql:60` | Children on an adult service | **Real but limited, and must never be described as more.** It is self-declaration. It is **not highly effective age assurance** within the meaning of the Act, it checks no document, and it does not detect lying. It makes the declaration meaningful and final; it does not make it true. Wherever a lower risk level would depend on children being absent, this control was given **no** credit |
| C8 | **Claim-time image scanning** (OpenAI omni-moderation, Sightengine, or an operator webhook), fail-closed | `server/src/services/content-scan.ts`, `attachments.ts:506` | Images depicting apparent minors, gore, and — via the webhook adapter — anything the operator wires in | Real, and well placed: it runs **before** the image is visible to anyone, so the exposure window is zero. Three hard limits: it scans **only five raster image types**; **video, audio and PDF are recorded `skipped` and never examined**; and with the default OpenAI provider the `sexual/minors` category is **text-only and scores zero on image input**, so it gives **no CSAM coverage at all**. Also: whether it is switched on in production is an environment variable, not a code fact — `CONTENT_SCAN_PROVIDER` is empty by default and an unconfigured provider records `unscanned` and lets the image through |
| C9 | **Quarantine and evidence preservation** | `attachments.ts:836` | Destroying evidence of a hit before a human sees it | Rows labelled `illegal` or `csam_suspected` are **never auto-deleted at any age**, and are excluded from the hourly orphan sweeper. This is the one technical control that serves the s.66 reporting duty |
| C10 | **Per-server audit log**, 21 action types, 90-day retention | `server/src/services/audit.ts` | Accountability for moderator action; evidence for later | Good within a server. Records nothing platform-level, and nothing about DMs |
| C11 | **Per-server message retention**, owner-set, pinned messages exempt | `server/src/services/retention.ts` | Data minimisation | Not a moderation tool. **Never touches DMs**, by construction |
| C12 | **Private channels and invite-only servers** | `server/src/services/users.ts:591` | Unwanted access to a community | Effective. Cuts both ways — the same property that keeps strangers out keeps moderators out |
| C13 | **Layered rate limiting** | `server/src/lib/rate-limit.ts` | Spam, enumeration, flooding, automated abuse | Sound design. **In-memory and single-process** — the file says so — so N replicas multiply every limit by N. Only the reports flood cap (10/hour) is counted in SQL and therefore durable |
| C14 | **Invite expiry and max-uses** | `server/src/services/invites.ts` | Uncontrolled spread of access | Implemented, checked transactionally — but **off by default**. An invite created without options never expires and has unlimited uses |
| C15 | **Terms of service** prohibiting the relevant conduct, with CSAM named as the one rule with no warning step | `client/src/pages/terms-page.tsx` | All categories, as the basis for enforcement | Present and clear. Deliberately does **not** prohibit adult nudity |
| C16 | **Account deletion and personal data export** | `server/src/services/account.ts` | Data-subject rights, not illegal content | Listed for completeness. **Deletion cascades away bans against the departing user, so it is a documented ban-evasion route** |

### 2.3 Gaps that materially affect these judgements

These are the reasons several categories could not be argued down. Each is a
verified absence, not a suspicion.

| # | Gap | Consequence |
|---|---|---|
| G1 | **No UI for the instance moderation queue.** The endpoint `GET /api/reports/instance` exists; nothing in `client/src` calls it. Access is gated on `INSTANCE_MODERATOR_CLERK_IDS` — **if that env var is unset, nobody can read the queue at all** | Every DM report — grooming, harassment, cyberflashing, CSAM in a DM — lands somewhere only reachable by `curl`, and only if an env var was set. **This is the highest-priority fix in this document** |
| G2 | **No CSAM hash matching.** No PhotoDNA, no IWF, no Arachnid, no Cloudflare CSAM Scanning. The `webhook` adapter is a wired extension point with nothing on the other end | The CSAM control on this service is a user report, the operator's own eyes, and a classifier that scores zero on the category that matters |
| G3 | **Video, audio and PDF are never scanned** | An entire class of attachment is unexamined. Recorded `skipped`, which the code correctly refuses to treat as `pass` |
| G4 | **Voice and screen share cannot be moderated at all** | Structural. Only a user report can surface anything |
| G5 | **No timeouts, mutes or slowmode.** The enforcement ladder goes from "delete the message" straight to "ban" | No graduated response. A borderline case gets nothing or everything |
| G6 | **No platform-level moderation tooling.** No admin console. Terminating an account is manual SQL | Every platform-level action is slow, manual and error-prone, at exactly the moments speed matters |
| G7 | **No URL or link reputation checking of any kind** | CSAM URLs, phishing and malware links pass unexamined. Links are actively unfurled into embeds |
| G8 | **No text moderation whatsoever.** Nothing scans message bodies | Hate, threats, suicide encouragement, drug sales and fraud are all text-first harms |
| G9 | **The terms page still says in-app reporting has not shipped** (`terms-page.tsx:195`) | Users are actively told to email instead of using the button that exists. Directly undermines C1 |
| G10 | **`contato@pqp.gg` bounces**, per `docs/MONITORING.md` — Cloudflare Email Routing has DNS records but no verified destination | The published contact address for abuse, safety and legal notices does not receive mail. Combined with G9, the reporting surface a user is told to use does not work |
| G11 | **No user-report entry point in group DMs**, and no way to file a user report outside a server context | A group DM is exactly where an unmoderated harm happens, and it has the thinnest reporting path |
| G12 | **No process for removing accounts of proscribed organisations** | Ofcom Code measure **ICU H1 applies to all services**. Nothing implements or documents it |
| G13 | **No appeal path for an automatically blocked attachment.** The sender is told the file did not attach and is not told why | Ofcom Code measure **ICU D11** (complaints about proactive technology) applies to all services. Content scanning is proactive technology |
| G14 | **No NCA CSEA-IRP registration.** Pending | s.66 is a statutory duty that applies regardless of size. See §5 |

### 2.4 Risk level for each kind of illegal content

Summary table first; reasoning follows. Sub-categories 2A/2B(i)/2B(ii) are
assessed separately as Ofcom requires of U2U services.

| # | Kind of priority illegal content | Risk level |
|---|---|---|
| 1 | Terrorism | **Medium** |
| 2 | Child sexual exploitation and abuse (overall) | **High** |
| 2A | — Grooming | **Medium** |
| 2B(i) | — Image-based CSAM | **Medium** |
| 2B(ii) | — CSAM URLs | **Medium** |
| 3 | Hate | **Medium** |
| 4 | Harassment, stalking, threats and abuse | **Medium** |
| 5 | Controlling or coercive behaviour | **Low** |
| 6 | Intimate image abuse | **Medium** |
| 7 | Extreme pornography | **Medium** |
| 8 | Sexual exploitation of adults | **Low** |
| 9 | Human trafficking | **Low** |
| 10 | Unlawful immigration | **Low** |
| 11 | Fraud and financial services offences | **Medium** |
| 12 | Proceeds of crime | **Low** |
| 13 | Drugs and psychoactive substances | **Low** |
| 14 | Firearms, knives and other weapons | **Low** |
| 15 | Encouraging or assisting suicide and serious self-harm | **Medium** |
| 16 | Foreign interference | **Low** |
| 17 | Animal welfare | **Low** |
| 18 | Cyberflashing | **Medium** |
| — | Other (non-priority) illegal content | **Low–Medium**, see §2.5 |

**Consequence, stated up front:** pqp is at medium or high risk of more than two
kinds of illegal harm (excluding the CSAM sub-rows, as the Codes require). Under
paragraph 5.6 of the Illegal Content Codes of Practice, **pqp is a multi-risk
service.** That pulls in roughly ten additional recommended measures. Step 3
works through them.

---

#### 1. Terrorism — Medium

**What could happen here.** A private channel or group DM used to share
propaganda, coordinate, or recruit. Not a broadcast problem — pqp has no
audience to broadcast to — but a coordination-space problem, which is the shape
pqp provides best: invite-only, no discovery, no retention limit unless set,
no moderator inside a DM.

**Likelihood.** Low in absolute terms with no users, but the risk factors are
present: messaging service, discussion forums and chat rooms, group messaging,
direct messaging, hyperlinking, image posting. Ofcom associates every one of
those with terrorism.

**What reduces it.** No discovery, no recommender, no virality, no way to reach
strangers with content. Terrorist content on a platform like this cannot find
an audience; it can only find a room it was already invited to.

**What does not.** Nothing scans text. Nothing scans links. Voice and screen
share are unobservable. There is no proscribed-organisations process (G12).

**Level.** Ofcom's medium row: several risk factors, some systems in place but
no ability to demonstrate they are effective. That is exactly pqp's position.
Severity is high enough that low would not be defensible.

**Planned.** Write the ICU H1 proscribed-organisations process (§Step 3).

---

#### 2. Child sexual exploitation and abuse — High

**Level: High**, driven by severity rather than by likelihood, and by the
combination of three sub-risks each at medium with no hash matching underneath
any of them.

The reasoning is Ofcom's own: where the severity of a harm is high, even a small
number of instances means the service is not low risk; and where evidence is
inconclusive, err upward. pqp has image sharing, video sharing that is never
scanned, unmoderated direct messages, unobservable livestreaming, an age gate
that cannot detect a lying child, one moderator, and **no hash matching**. There
is no honest way to write this down as anything else.

##### 2A. Grooming — Medium

**What could happen.** An adult uses a DM, a group DM, or a voice/screen-share
session to build a relationship with a user who is under 18 despite the age
gate.

**The gating question is whether children can access the service.** For grooming
purposes Ofcom asks whether it is *possible*, not whether it is *permitted*. A
self-declared date of birth entered once does not make it impossible. So: yes,
possible. And pqp's functionalities enable one-to-one communication with such a
user.

**Risk factors from Ofcom's grooming table** present here: social media service,
messaging service, livestreaming. Gaming, encrypted messaging and commenting are
absent. That is "several".

**What keeps it out of High.** Ofcom's high-risk conditions for grooming are
network expansion prompts, visible connection lists, and profiles or groups that
let a user work out whether someone is likely to be a child. **pqp has none of
these.** There is no recommender, no follower list, no age or birthday on a
profile, no "people you may know". A perpetrator on pqp has no mechanism for
finding a child — they would have to be handed one by an invite link.

**What keeps it out of Low.** The instance-wide handle search is a
stranger-discovery surface, however thin. DMs are entirely unmoderated. Voice
and screen share are unobservable. And DM reports currently land in a queue with
no interface (G1).

**Level: Medium.** Ofcom: "we would normally expect such services to be assessed
as at least medium risk".

##### 2B(i). Image-based CSAM — Medium

**What could happen.** CSAM uploaded as an attachment into a channel or a DM; or
shown over screen share, where nothing can see it.

**Applying Ofcom's Table 13.1.** pqp enables images and videos to be uploaded
and shared, and has **four** of the nine listed risk factors: messaging service,
discussion forums and chat rooms, group messaging, direct messaging. Ofcom
treats that as "several", and expects at least medium.

**Not High**, because pqp is not a file-storage and file-sharing service, not an
online adult service, has no evidence of image-based CSAM, does not permit child
users, requires an account to share anything, and has no video livestreaming
from a camera. Ofcom's high row needs the file-storage/adult shape or "a lot of"
the factors.

**Not Low**, and this is the important half. Ofcom's low row requires either no
evidence *and* few risk factors — pqp has several — or **"comprehensive systems
and processes… a combination of hash matching and automated content classifiers…
used to review all images and videos"**. pqp has a classifier over five image
types with a CSAM category that returns zero on image input, and **no hash
matching at all**. It does not scan video. It cannot claim the low row and this
record does not try.

**What reduces it.** Scanning at claim time means the exposure window for a
rejected image is genuinely zero, which is better than most services manage.
Quarantined `illegal` rows are never auto-deleted, so evidence survives. Bans
and account termination work.

**What does not.** G2, G3, G4.

**Planned.** IWF Image Intercept and/or Project Arachnid, wired through the
existing `webhook` adapter. §5.

##### 2B(ii). CSAM URLs — Medium

**What could happen.** A link to CSAM pasted into a channel or a DM. pqp
actively unfurls links into embeds.

**Applying Ofcom's Table 13.2.** pqp enables users to share text and hyperlinks,
and has **five** of the seven listed factors: social media service, messaging
service, discussion forums and chat rooms, user groups, direct messaging. That
is "several" → at least medium.

**Not High**, because the high row turns on allowing text or hyperlink sharing
*without an account*. pqp always requires one.

**Not Low**, because the low row requires either no evidence *and* few factors,
or comprehensive URL checking. pqp has **no link checking whatsoever** (G7).

**Planned.** Cloudflare CSAM Scanning covers URLs Cloudflare serves, not links
posted in chat; it is not a fix for this. A URL blocklist check on link unfurl
is the honest fix and is **not planned or scoped**.

---

#### 3. Hate — Medium

**What could happen.** Racist, homophobic or religiously hateful content posted
in a server channel or sent in a DM. Small closed communities are where this
concentrates, not where it is absent.

**Likelihood.** Risk factors present: social media service, messaging service,
direct messaging, image posting, livestreaming. Real-time chat with no text
moderation and one moderator.

**What reduces it.** No amplification, no recommender, no reach beyond a server.
Server owners can delete and ban within their own communities, which is where
most of this is caught in practice. The terms prohibit it explicitly.

**What does not.** Nothing scans text (G8). Voice is unobservable (G4). DMs have
no moderator. There is no timeout, so the response to a first offence is
disproportionate in one direction or the other (G5).

**Level: Medium** — several factors, systems present but unproven.

---

#### 4. Harassment, stalking, threats and abuse — Medium

**Probably the category most likely to actually occur first**, on any comparable
service.

**What could happen.** Sustained abuse in a channel; a pile-on organised in a
private channel; a stalker locating a target's handle through user search and
following them across servers; threats in a DM.

**What reduces it.** This is the category pqp is best equipped for. Blocking is
real, server-side and symmetric for contact. DM privacy defaults to
`server_members`, so a handle found by search cannot be messaged by a stranger.
Kick and ban work, with rejoin prevention. Reporting captures a snapshot that
survives deletion — which is exactly the evidence problem in harassment cases,
where the abuser deletes and denies.

**What does not.** The instance-wide handle search is a genuine stalking aid,
and it is the one part of "closed discovery" that is not closed. No timeouts
(G5). No text scanning. Ban evasion via account deletion is documented and open.
And DM harassment reports go to the queue with no UI (G1).

**Level: Medium.** High would require evidence of substantial harm, which does
not exist; low is not available given the number of risk factors and the
absence of proven-effective systems.

---

#### 5. Controlling or coercive behaviour — Low

**What could happen.** A perpetrator uses DMs to monitor and control a partner
or family member — demanding replies, tracking presence, isolating them.

**Why low, and it is a genuine structural argument rather than optimism.** The
offence requires an existing intimate or family relationship. pqp offers no
mechanism for bringing one onto the platform: no contact import, no phone
numbers, no real names, no address book matching, no "find your friends". The
relationship has to arrive with the users. Combined with a user base of
effectively zero and no discovery, the pathway is thin.

**What does not reduce it.** Nothing detects it — coercion is invisible in text
to any classifier and to any moderator who cannot see DMs. Presence and typing
indicators are exactly the surveillance affordances this offence uses. Impact
where it occurs is severe.

**Level: Low, honestly held but fragile.** It rests on the absence of a
relationship-import mechanism. **It becomes Medium** if pqp ever adds contact
discovery, friend suggestions, or any feature that helps people find someone
they already know offline.

---

#### 6. Intimate image abuse — Medium

**What could happen.** Someone posts or sends an intimate image of another
person without consent, or threatens to. On a service that permits adult nudity,
such an image does not look anomalous.

**Why this is one of the strongest Medium calls in the document.** Ofcom
associates intimate image abuse with discussion forums and chat rooms, group
messaging, direct messaging and image posting — pqp has all four. And the
mitigation that would normally apply does not exist: **consent is not visible in
pixels.** No classifier detects non-consensual intimate imagery, and `pqp`'s
scanner is additionally configured to ignore adult sexual content entirely,
because the service does not prohibit it. So the automated signal is not weak
here — it is deliberately absent.

**What reduces it.** The terms prohibit it explicitly. Reporting works, with a
snapshot that survives deletion, and the triage runbook puts it in the top tier.
Blocking and ban work. Attachments in a deleted message are swept from storage.

**What does not.** Detection, entirely. This is a report-only harm.

**Level: Medium.** Severity is high and pqp cannot see it coming.

---

#### 7. Extreme pornography — Medium

**What could happen.** Content within CJIA 2008 s.63 — pornography depicting
serious injury, bestiality, necrophilia — posted as an attachment or shown over
screen share.

**Why medium rather than low, and this is where a deliberate policy choice shows
up in a risk level.** pqp is 18+ and its acceptable-use rules **do not prohibit
adult nudity**. The content scanner therefore treats adult sexual content as
`pass` by design, because flagging it would enforce a rule the service does not
have and would flood a queue one person reads. The consequence is that content
adjacent to a criminal category has no automated signal attached to it. The gore
classifier catches part of the overlap — extreme pornography involving serious
injury would plausibly score on it — but that is partial and incidental.

**What reduces it.** The gore flag. Reporting. Ban. The absence of any discovery
mechanism, which matters more here than for most categories: this material
spreads through search and directories, and pqp has neither.

**What does not.** The service's own content policy, which is a reasoned choice
and is not being second-guessed here — but it must be recorded as raising this
category rather than quietly omitted.

**Level: Medium.**

---

#### 8. Sexual exploitation of adults — Low

**What could happen.** Advertising or arranging commercial sexual services, or
controlling someone doing so, via a server or DMs.

**Why low.** Ofcom associates this most strongly with marketplace and listing
services, posting goods or services for sale, and user connections. pqp has
**none** of those. There is no commerce feature, no listing, no discovery, no
way for a customer to find a provider. The pathway needs a market, and pqp has
not built one.

**What does not reduce it.** DMs are private and unmoderated. Voice is
unobservable. Nothing scans text.

**Level: Low.** **Goes to Medium** if a public server directory ships, or if
adult-content communities become a significant part of the user base — the 18+
positioning makes that a plausible growth direction and it should be watched.

---

#### 9. Human trafficking — Low
#### 10. Unlawful immigration — Low

Taken together because the reasoning is the same.

**What could happen.** Recruitment, coordination or advertising via private
channels or DMs.

**Why low.** Ofcom associates both with marketplace and listing services, goods
for sale, and encrypted messaging. pqp has no marketplace and no listings. It
has no location sharing. Most importantly it has **no way for a recruiter to
reach a stranger** — no discovery, no search for content, no recommender. These
harms depend on reach into a vulnerable population, and pqp provides none.

**What does not reduce it.** Private channels and DMs are a fine coordination
space for people who already know each other. Voice is unobservable.

**Level: Low** for both. Directly dependent on closed discovery remaining true.

---

#### 11. Fraud and financial services offences — Medium

**Along with harassment, the most likely thing to actually happen.**

**What could happen.** The abuse patterns of every Discord-shaped service:
invite links to fake "giveaway" or "airdrop" servers; crypto and gift-card
scams; phishing links in DMs; impersonation of a server admin; malware
disguised as a file. pqp unfurls links into rich embeds, which makes a phishing
link look more legitimate, not less.

**Likelihood.** Risk factors: social media service, messaging service, user
profiles, direct messaging, group messaging, hyperlinking. Fraud follows users;
it does not need a marketplace.

**What reduces it.** No commerce, no payments, no wallet, nothing of value held
on the platform — so pqp is a vector, not a target. Closed discovery limits
mass-spam reach: a scammer cannot broadcast to strangers. Rate limiting exists.
Blocking and DM privacy limit cold approaches.

**What does not.** **No link or domain reputation checking of any kind** (G7).
No text scanning. No impersonation detection — display names are free text and
can duplicate. Rate limits are in-memory and per-process (C13).

**Level: Medium.**

---

#### 12. Proceeds of crime — Low

Associated by Ofcom with marketplaces, goods for sale and user profiles. pqp has
no commerce, no payments, no transfer of value, and nothing to launder through.
Discussion of it in a private channel is possible and undetectable; that is
true of every private communication service. **Low.** Revisit immediately if
payments, tipping or any monetisation ships.

---

#### 13. Drugs and psychoactive substances — Low
#### 14. Firearms, knives and other weapons — Low

**What could happen.** A server used as a dealing space; sales arranged in DMs.

**Why low, and it is the clearest illustration of what closed discovery buys.**
Ofcom associates both with marketplaces, goods for sale, user-generated content
searching and — for drugs — user connections and anonymous posting. pqp has no
marketplace, no listings, no public search, no anonymous posting, and **no way
for a buyer to find a seller they do not already know**. A dealing server on pqp
can only be reached by invite. That does not make it impossible; it makes it a
closed group of people who already knew each other, which is a materially
different and smaller risk.

**What does not reduce it.** Nothing scans text or images for this. Voice is
unobservable. DMs are unmoderated.

**Level: Low** for both. **Both go to Medium the day a public directory or
cross-server content search ships.** This is the clearest example of why that
change is a review trigger and not a feature decision.

---

#### 15. Encouraging or assisting suicide and serious self-harm — Medium

**Assessed higher than an operator might expect, on Ofcom's own evidence.**

Ofcom's Risk Profile for *discussion forums and chat rooms* names this harm
specifically: "our evidence shows that discussion forums and chat room services
can act as spaces where suicide is assisted or encouraged". pqp is precisely
that shape — small, closed, high-affinity communities where a norm can form
without anyone outside seeing it, and where the moderator is a member rather
than a professional.

**Risk factors present.** Discussion forums and chat rooms, direct messaging,
group messaging, image posting, livestreaming, hyperlinking — Ofcom associates
this harm with all of them.

**What reduces it.** The terms prohibit inciting self-harm. Reporting exists and
a peer in the same channel is often the person best placed to notice.

**What does not.** Nothing scans text (G8) — and this is a text-first harm.
There is no crisis-resource intervention, no keyword prompt, no signposting to
support anywhere in the product. Voice and screen share are unobservable. DMs
are unmoderated. Impact is as severe as it gets.

**Level: Medium**, and this record flags it as the category most likely to be
under-weighted by an operator building a chat app.

**Planned.** Nothing is currently planned. Signposting to crisis resources on a
report of this type would be a cheap, proportionate first measure.

---

#### 16. Foreign interference — Low

Requires reach, an audience, and amplification. pqp has no recommender, no
public content, no virality mechanism, no advertising, and effectively no users.
A state actor gains nothing from a service nobody can find. Risk factors present
(social media, discussion forums, hyperlinking) are outweighed by the complete
absence of distribution. **Low.** Revisit if discovery or any recommender ships.

---

#### 17. Animal welfare — Low

Ofcom associates this with image and video posting, group messaging and
livestreaming — all present. Against that: no discovery, no audience, no
amplification, and a gore classifier that would flag a meaningful share of it
where it appears as a still image. **Video is unscanned** (G3), which is the
weak point, since this harm is video-first. **Low**, with that caveat recorded.

---

#### 18. Cyberflashing — Medium

**One of the most plausible offences on this specific product, and worth
spelling out.**

**What could happen.** A user sends an unsolicited image of genitals to another
user in a DM or a group DM — the s.66A Sexual Offences Act 2003 offence.

**Why medium.** pqp has direct messaging, group messaging and image sharing. It
is 18+. And the classifier is **deliberately configured not to flag adult sexual
content**, because the service permits it — so the one automated signal that
would catch this on a general-audience service is switched off here by design.
An unsolicited genital image and a consensual one are pixel-identical; the
offence is in the sending, not the content, and no scanner can see the
difference.

**What reduces it.** DM privacy defaults to `server_members`, which is the
single most effective control against the classic stranger-cyberflashing
pattern, and it is on by default rather than buried in settings. Blocking works.
Reporting captures a snapshot that survives deletion — important, because the
sender deleting the image is part of the pattern. Attachment objects for a
deleted message are swept from storage within the hour, which is good for
privacy and bad for evidence; the report snapshot is what bridges that.

**What does not.** Detection. And group DMs have the weakest reporting path in
the product (G11).

**Level: Medium.**

---

### 2.5 Other illegal content (non-priority)

Ofcom requires an assessment of whether other illegal content is likely. On pqp
the realistic categories are:

- **Computer misuse** — malware and phishing links, credential-stealing files.
  Prohibited by the terms; **no link or file reputation checking exists** (G7).
  Treated as **Medium**, alongside fraud, since they share a delivery mechanism.
- **Intellectual property infringement** — pirated files and links. Attachments
  and links make it possible; the absence of discovery makes it small.
  **Low.**
- **Defamation, obscene publications, and offences committed by ordinary
  conversation.** Possible on any chat service; undetectable; report-driven.
  **Low.**

**Overall: Low–Medium**, driven by the malware/phishing vector.

---

## Step 3 — Measures: what is implemented, planned, and not addressed

*Ofcom's Step 3: consult the Codes of Practice, record which recommended
measures are implemented, which are planned, which are not, and any alternative
measures taken instead.*

### 3.1 Which measures apply to pqp

Two determinations drive this:

- **pqp is not a large service.** "Large" means more than 7 million monthly
  active UK users. pqp has effectively none.
- **pqp *is* a multi-risk service.** Paragraph 5.6 of the Codes: a service is
  multi-risk if it is at medium or high risk of two or more kinds of illegal
  harm (excluding the CSAM sub-rows). pqp is at medium or high risk of nine.

The second finding is the practically important output of this whole document.
It pulls in every measure marked "large **or multi-risk** services" — roughly
ten additional recommendations for a service run by one person. It also means
**ICU D9 does not apply** (that measure is for services that are *neither* large
nor multi-risk) and **ICU D8 does apply** in its place.

### 3.2 Measure-by-measure record

Status is one of **Implemented**, **Partial**, **Planned**, **Not addressed**,
or **Not applicable**. "Partial" means something real exists and does not meet
the measure as written.

#### Governance and accountability

| Measure | Applies? | Status | Note |
|---|---|---|---|
| **ICU A1** Annual review of risk management activities | Large only | Not applicable | |
| **ICU A2** Individual accountable for illegal content safety duties and reporting/complaints duties | **All services** | **Implemented** | The operator, by necessity. Recorded here and in §0. There is nobody to delegate to and nobody to be accountable *to*, which is a real weakness of this measure at this size — but the measure is met |
| **ICU A3** Written statements of responsibilities | **Multi-risk → yes** | **Partial** | `docs/TRUST_AND_SAFETY.md` §3–§5 are functionally the operator's statement of responsibilities. **Alternative measure claimed:** for a one-person service, that runbook plus §0 of this record is the proportionate equivalent of a statement of senior-manager responsibilities |
| **ICU A4** Internal monitoring and assurance | Large + multi-risk | Not applicable | Not large |
| **ICU A5** Tracking evidence of new and increasing illegal harm | **Multi-risk → yes** | **Not addressed** | Nothing tracks trends. There is no volume metric, no report-rate dashboard, nothing. **Proportionate fix:** review the reports queue and the quarantine query in `docs/CONTENT_SAFETY.md` on a fixed cadence and write down what was seen. That is achievable by one person and is currently not being done |
| **ICU A6** Code of conduct on protecting users from illegal harm | **Multi-risk → yes** | **Partial** | The acceptable-use section of the terms is a user-facing code of conduct. The measure contemplates an internal one. **Alternative measure claimed:** the terms plus the triage tiers in `TRUST_AND_SAFETY.md` §3.2 |
| **ICU A7** Compliance training | **Multi-risk → yes** | **Not addressed, and honestly hard to meet** | There is nobody to train. The proportionate reading is that the operator must actually read Ofcom's Illegal Content Judgements Guidance before deciding whether something is illegal content, and record that he has. Not yet done |

#### Content moderation

| Measure | Applies? | Status | Note |
|---|---|---|---|
| **ICU C1** Moderation function to review and assess suspected illegal content | **All services** | **Partial** | The function is one person plus a reports queue. **The gap is G1**: DM reports have no interface and are gated on an env var. Until that is fixed the moderation function does not reach a whole class of content |
| **ICU C2** Moderation function allowing swift takedown | **All services** | **Partial** | Deletion, kick, ban and SFU ejection all work and are fast. **In a DM there is no takedown mechanism at all** — only the author can delete. Account termination is manual SQL (G6) |
| **ICU C3** Setting internal content policies | **Multi-risk → yes** | **Partial** | `TRUST_AND_SAFETY.md` §3.2 (triage tiers) and the scan policy table in `CONTENT_SAFETY.md` are internal content policy. Not written as one document, and not mapped to the 18 kinds |
| **ICU C4** Performance targets | **Multi-risk → yes** | **Not addressed, deliberately** | `TRUST_AND_SAFETY.md` §2 records a reasoned decision not to publish an SLA one person cannot keep. **That reasoning is about the *public* promise and does not extend to internal targets.** An internal target the operator measures himself against — even "CSAM on sight, everything else within a week" — is what this measure asks for and is achievable. Currently absent |
| **ICU C5** Prioritisation | **Multi-risk → yes** | **Implemented, as an alternative measure** | The Tier 0/1/2 triage in `TRUST_AND_SAFETY.md` §3.2 is exactly this: CSAM, imminent danger and non-consensual intimate images jump the queue. Automated reports are deduplicated per uploader per server so a flood cannot bury a human report |
| **ICU C6** Resourcing | **Multi-risk → yes** | **Not addressed — cannot be** | The resource is one person's spare time. There is no honest way to record this as met. It is recorded as an accepted, disclosed limitation, and it is the single strongest argument for keeping the service small |
| **ICU C7** Training for moderation staff | **Multi-risk → yes** | **Not applicable in form, partial in substance** | No staff. Server owners moderate their own communities and receive no guidance. **Proportionate fix, currently absent:** a short "running a server" page telling owners what to escalate and how |
| **ICU C8** Materials for volunteers | **Multi-risk → yes** | **Not addressed** | Server owners and admins *are* the volunteer moderators of this platform and there is nothing written for them. Same fix as C7 |
| **ICU C9** Hash matching to detect and remove CSAM | **No** — needs large + medium/high image CSAM risk, or high image CSAM risk plus >700k UK MAU or file-storage shape | **Not applicable under the Code — and being done anyway** | Recorded deliberately. Ofcom's Code does **not** recommend hash matching for a service pqp's size and risk level. This record nevertheless treats its absence as the **largest single gap** (G2), because the s.66 NCA reporting duty applies regardless of size and because a hash match is the only CSAM signal with legal weight. Planned: IWF Image Intercept / Project Arachnid via the existing `webhook` adapter |
| **ICU C10** Detecting content matching listed CSAM URLs | **No** — needs large, or >700k UK MAU + high CSAM URL risk | **Not applicable under the Code** | Also not implemented (G7). Worth doing if a free list becomes available |

#### Reporting and complaints

| Measure | Applies? | Status | Note |
|---|---|---|---|
| **ICU D1** Enabling complaints | **All services** | **Implemented** | `POST /api/reports`, message and user targets, with a durable evidence snapshot |
| **ICU D2** Easy to find, access and use complaints systems | **All services** | **Partial — and this is a live defect** | The report action is on the message and on the member list. But **the terms page still tells users the button does not exist and to email instead** (G9), and **that email address bounces** (G10). Group DMs have no user-report entry point (G11). The mechanism is better than the product says it is, and the product's own text is misdirecting users away from it |
| **ICU D3** Information before submitting a complaint | Children-likely + large/medium-high | Not applicable *on current assessment* | Depends on the children's access assessment, which has not been done. **Flagged as conditional** |
| **ICU D4** Indicative timeframes | **Medium/high risk of any kind → yes** | **Not addressed, deliberately, and this needs revisiting** | `TRUST_AND_SAFETY.md` §2 decided against published timeframes. The Code asks for *indicative* timeframes, which is weaker than an SLA — "usually within a few days" is arguably already that. **The operator should decide consciously whether the current wording satisfies D4 rather than inheriting the no-SLA decision by default** |
| **ICU D5** Further information on handling | Children-likely + large/medium-high | Not applicable, conditional as D3 | |
| **ICU D6** Opt-out from follow-up communications | **Medium/high risk of any kind → yes** | **Not addressed** | There is no follow-up communication mechanism at all, so nothing to opt out of. Becomes relevant if report-outcome notifications ship |
| **ICU D7** Appropriate action on complaints about suspected illegal content | **All services** | **Partial** | Actions exist (delete, kick, ban, terminate). The runbook exists. What is missing is the ability to *see* a DM complaint (G1) and any tooling for platform-level action (G6) |
| **ICU D8** Appeals — determination (large or multi-risk) | **Multi-risk → yes** | **Partial** | An appeals process exists in `TRUST_AND_SAFETY.md` §4 with a 30-day window. It is explicitly **not** reviewed by an independent person, because there is no second person, and the terms say so rather than hedging. Recorded as an accepted limitation |
| **ICU D9** Appeals — determination (neither large nor multi-risk) | **No** — pqp is multi-risk | Not applicable | Superseded by D8 |
| **ICU D10** Action following determination | **All services** | **Implemented** | Reversal routes exist — `DELETE /api/servers/:id/bans/:userId`; a refused age check can be reversed by hand |
| **ICU D11** Complaints about proactive technology | **All services** | **Not addressed — concrete gap** | Content scanning **is** proactive technology. A user whose image is rejected is told the file did not attach and **is not told why, and has no route to contest it** (G13, and `CONTENT_SAFETY.md` residual risk 6). **Fix:** tell the sender the image was blocked by an automated check and give them the contact address. Small change, clear Code obligation |
| **ICU D12** Action on all other relevant complaints | **All services** | **Partial** | One inbox, one person, no tracking system beyond the reports table |
| **ICU D13** Exception for manifestly unfounded complaints | **All services** | **Implemented in substance** | `resolveReport` supports dismissal; the 10/hour flood cap in SQL is the anti-abuse half |
| **ICU D14** Trusted flagger channel for fraud | Large + medium/high fraud | Not applicable | |

#### Recommender systems, child safety, terms, user access, user controls

| Measure | Applies? | Status | Note |
|---|---|---|---|
| **ICU E1** Safety metrics in recommender testing | **No** | Not applicable | pqp has no recommender of any kind. Recorded because losing this "not applicable" would be a significant change |
| **ICU F1** Safety defaults for child users | **No** — needs high grooming risk (or large + medium) | Not applicable | pqp is medium for grooming and not large. **But note:** pqp does have "an existing means of determining age" in the loose sense (the declared DOB), so if grooming risk ever moves to high, F1 and F2 both bite immediately |
| **ICU F2** Support for child users | **No**, as F1 | Not applicable | Same trigger |
| **ICU G1** Terms of service: substance | **All services** | **Implemented — verify against the measure** | `client/src/pages/terms-page.tsx` covers prohibited content, moderation powers, enforcement and appeals. **The operator should read ICU G1 line by line against the page**; this record has not done that comparison clause by clause |
| **ICU G2** Terms of service: substance (Category 1) | **No** | Not applicable | |
| **ICU G3** Terms of service: clarity and accessibility | **All services** | **Partial** | The pages are clear, short and plain — genuinely good on this measure. **They are English-only**, for a user base intended to be largely Brazilian. `TRUST_AND_SAFETY.md` §6 records the missing pt-BR translation as a known gap; it is an accessibility gap for this measure too |
| **ICU H1** Removing accounts of proscribed organisations | **All services** | **Not addressed** (G12) | Nothing checks against the Home Office proscribed-organisations list and no process exists. **Cheapest open Code gap in this document to close: write down the process, know where the list is, and be able to act on it.** No code required |
| **ICU J1** User blocking and muting | Large only | **Not applicable — implemented anyway** | Blocking is real and server-side; DM privacy is arguably stronger than the measure asks. Recorded as a credited control (C5) |
| **ICU J2** Disabling comments | Large only | Not applicable | No comment functionality |
| **ICU J3** Notable-user / monetised labelling | Large only | Not applicable | No such schemes |

### 3.3 Measures taken that no Code recommends

Recorded because Ofcom asks for additional measures, and because they are part
of why several risk levels are not higher.

- **Closed discovery**, maintained as a deliberate design property rather than a
  missing feature.
- **Claim-time attachment scanning with a zero visibility window** — the image
  is scanned before it is ever readable, rather than after publication.
- **Fail-closed scanning**: a broken scanner drops the attachment rather than
  publishing it unchecked.
- **Evidence preservation by default**: reports keep a content snapshot that
  survives deletion of the message; quarantined `illegal` rows are never
  auto-deleted at any age.
- **Structural separation of DM reports from server admins**, enforced by a
  database constraint rather than by application logic.
- **DM privacy defaulting to `server_members`** rather than `everyone`.

### 3.4 The shortlist, in the order it should be done

Not a commitment on the operator's behalf — a priority ordering that falls out
of the analysis above.

1. **Make DM reports readable** (G1). Set `INSTANCE_MODERATOR_CLERK_IDS`
   *today*; build the queue UI after. Right now a CSAM report in a DM may be
   arriving somewhere nobody can look.
2. **Make `contato@pqp.gg` receive mail** (G10), and **fix the terms page text
   that says in-app reporting does not exist** (G9). Two small changes that
   repair the whole reporting surface.
3. **Register with the NCA CSEA-IRP** (§5). Statutory, free, and must be done
   *before* there is something to report.
4. **Tell users when an attachment was blocked by an automated check, and how to
   contest it** (ICU D11, G13).
5. **Write the ICU H1 proscribed-organisations process** (G12). Prose, not code.
6. **Apply for IWF Image Intercept** (G2). Free, aimed at exactly this size, and
   the plumbing to receive it already exists.
7. **Set an internal moderation target and a review cadence** (ICU C4, ICU A5).
8. **Write something for server owners** about what to escalate (ICU C7/C8).

---

## Step 4 — Report, review and update

*Ofcom's Step 4: report findings through governance channels, monitor
effectiveness and residual risk, and review.*

### 4.1 Governance

There is one person. The findings of this assessment have been recorded by, and
reported to, the operator — which is the whole of the governance channel and is
recorded honestly rather than dressed up as a process. Ofcom's expectation of
reporting "through appropriate governance channels" is met by this document
existing, being dated, being kept, and being read by the person who can act on
it.

If a second person ever takes on moderation, this section must be rewritten
first.

### 4.2 Residual risk after measures

**The residual risk on this service is meaningful and is concentrated in four
places.** None is closed by anything in Step 3.

1. **CSAM detection.** With no hash matching and a classifier that scores zero
   on the relevant category for images, the CSAM control is a user report, the
   operator's own eyes, and nothing else. **This is the largest residual risk in
   the document** and it is closed by an application, not by code.
2. **Direct and group messages.** Unmoderated, retained forever, invisible to
   every control except a report — and reports from there currently have no
   interface (G1). Every harm that happens one-to-one lands here.
3. **Voice and screen share.** Structurally unobservable. Live video that is
   never recorded and never scanned. Nothing will change this, and nothing
   should be claimed about it.
4. **Capacity.** One person, no staff, no rota, no cover. Every control that
   ends in "a human reviews it" ends in the same human. This is the risk factor
   that scales worst with growth, and the one the operator has least ability to
   fix.

### 4.3 Review triggers

A new or updated assessment is required before any significant change. These are
the triggers that matter for **this** service, grounded in the reasoning above.
Each is a change that would move at least one risk level in this document.

**Must trigger a new assessment before the change ships:**

| Trigger | Why, in one line |
|---|---|
| **Enabling any public discovery** — a server directory, a browse page, cross-server content search, joining without an invite | Closed discovery is holding drugs, weapons, trafficking, sexual exploitation, proceeds of crime and foreign interference at Low. Removing it moves several categories at once |
| **Adding any recommender system**, including "servers you might like" or "people you may know" | ICU E1 becomes applicable; network recommendations move grooming toward High under Ofcom's own table |
| **Adding camera video, or recording/storing voice or screen share** | Changes livestreaming from unobservable to observable-and-retained, and creates a stored-media surface with no scanning behind it |
| **Adding contact import, friend suggestions, or any way to find people you already know offline** | The Low for controlling or coercive behaviour rests entirely on the absence of this |
| **Taking payment, adding tipping, subscriptions, ads or any monetisation** | Proceeds of crime and fraud both move; business model is an element the Act requires to be assessed |
| **Adding a marketplace, listings, or selling of any kind** | Moves drugs, weapons, trafficking, sexual exploitation and proceeds of crime together |
| **End-to-end encrypting text** | Removes the operator's only content-visible surface |
| **Changing the age gate** — in either direction, including adopting real age assurance | Changes the "can children access this" answer that gates grooming and CSEA |
| **Turning content scanning on or off, or changing provider or fail mode** | Directly changes the credit given to control C8 |
| **A second person joining moderation, or the service being transferred to anyone else** | Changes governance, capacity, and §4.1 |

**Must trigger a review, if not a full new assessment:**

| Trigger | Why |
|---|---|
| **The first real user population.** Suggested checkpoint: the first time the service has more than a handful of active servers with people who do not know the operator | Every likelihood judgement here assumes zero users. The first genuine community invalidates that |
| **The first Tier 0 report** — CSAM, credible threat, non-consensual intimate imagery, or a suspected minor | Evidence of a harm occurring is, in Ofcom's terms, a strong indicator of at least medium risk for that kind, and may indicate more |
| **Any pattern in reports** — repeated reports of the same kind | The first real evidence this document has ever had |
| **Ofcom updating the Risk Profiles or the Codes** | An express duty: the assessment must be kept up to date when Ofcom makes a significant change to a relevant Risk Profile |
| **Hash matching going live** (IWF or Arachnid) | Would allow image-based CSAM to be reconsidered — the Low row explicitly contemplates hash matching plus classifiers |
| **Growth toward Ofcom's own thresholds** — 700,000 UK monthly active users (medium-impact indicator), 7 million (large service) | Both change which Code measures apply |

**Otherwise: annually. Next review due 7 August 2027.**

### 4.4 Version history

| Version | Date | Change |
|---|---|---|
| 1 | 2026-08-07 | First assessment. Written at public launch, against Risk Assessment Guidance V2.0 (25 June 2026). |

Superseded versions are to be retained for at least three years.

---

## 5. What the operator must do, that this document cannot do for him

Four items. This record can identify them; only he can complete them.

### 5.1 Register with the NCA CSEA Industry Reporting Portal

**Status: pending. Legally required. Do it first.**

Section 66 of the Online Safety Act, commenced 7 April 2026, creates a duty on
UK providers of regulated user-to-user services to report detected CSEA content
to the National Crime Agency. **The duty applies regardless of the size of the
service or its assessed risk level.** There is no small-operator exemption. "It
is a hobby project" is not a defence, and neither is this risk assessment.

The duty does **not** require detection. It requires reporting what is detected
— by any means, including a user report or the operator's own eyes. It is
therefore live from launch even with no scanning of any kind.

**Registration must happen before a report can be made.** Do it now, not while
holding something that needs reporting. Providing false information in purported
compliance is an offence under s.69, carrying up to two years on indictment.

<https://www.nationalcrimeagency.gov.uk/what-we-do/crime-threats/child-sexual-abuse-and-exploitation/the-child-sexual-exploitation-abuse-industry-reporting-portal>

### 5.2 Apply for IWF Image Intercept

**Status: not applied. Not required by Ofcom's Code. The highest-value thing on
this list anyway.**

Be precise about the legal position, because it is easy to get backwards:
**Ofcom's Code measure ICU C9 does not recommend hash matching for a service of
pqp's size and risk level** (§3.2). Nobody is requiring this.

It is still the largest gap in the document (G2), because Code compliance is not
the same as risk being managed, and because the s.66 reporting duty in §5.1
applies whether or not anything is detected. Image Intercept is Home Office
funded, uses PhotoDNA and cryptographic hashing against the IWF list, is **free
under one million checks per month**, and is aimed explicitly at smaller
companies and startups. It requires an eligibility form and IWF review, not a
purchase.

Once approved, the integration is small: implement the call inside a webhook
provider and return `{"verdict":"reject","illegal":true,…}` on a match. Block,
quarantine, never-auto-delete, the escalation log and the automated report all
already exist behind that. Details in `docs/CONTENT_SAFETY.md`.

<https://www.iwf.org.uk/our-technology/image-intercept>

### 5.3 Enable Cloudflare's CSAM Scanning Tool — with its uncertainty stated

**Status: not enabled. Free. Not required by anyone. Do it, but do not count on
it.**

Free on all Cloudflare plans; since February 2025 it needs only a verified email
address rather than the operator's own NCMEC credentials. It compares content
Cloudflare serves for a zone against NCMEC and other child-safety hash lists,
emails on a match, and blocks the matched URL with a 451.

**Two caveats, and the second is genuinely unresolved:**

- It is a **serving-path** control, not an upload-path one. It cannot stop bytes
  landing in R2 — only stop them being served once matched. It is not a
  substitute for §5.2.
- The setting is **zone-scoped** and Cloudflare's documentation describes it as
  scanning content served through the cache. An R2 bucket behind a **proxied
  custom domain on a zone in the operator's account** is the configuration that
  can plausibly be in scope; `r2.dev` explicitly is not. **There is no official
  Cloudflare statement confirming that R2-via-custom-domain is covered.** Open a
  support ticket rather than assuming it, and do not let it be the only line.

If enabling it: serve attachments through a proxied custom domain, add a
cache-everything rule for the attachment path, and disable `r2.dev` public
access so nothing bypasses it.

<https://developers.cloudflare.com/cache/reference/csam-scanning/>

### 5.4 Review this assessment himself before relying on it

**This document was drafted by reading the code. It is not legal advice and it
has not been reviewed by a lawyer.**

Three specific things the operator must do himself, because they cannot be done
for him:

1. **Read it and disagree with it where he disagrees.** The risk levels in §2.4
   are judgements applying Ofcom's tables to facts about the product. They are
   defensible, but they are not the only defensible answers, and it is the
   operator who has to defend them. A level he does not actually believe is
   worse than a level he argued for.
2. **Check the facts that depend on the live environment, not the repository.**
   Whether `CONTENT_SCAN_PROVIDER` is set in production; whether
   `INSTANCE_MODERATOR_CLERK_IDS` is set; whether `contato@pqp.gg` actually
   receives mail; which host and which storage bucket are live. **This document
   could not verify any of them** and has assumed the least favourable answer
   where it mattered.
3. **Decide the two questions this record deliberately leaves open**: whether
   the terms page satisfies ICU G1 clause by clause, and whether the children's
   access assessment has been done — because if the service is likely to be
   accessed by children, a further set of duties applies that this document does
   not touch, and a self-declared date of birth is a weak basis for concluding
   otherwise.

Then **date it, keep it, and keep the superseded versions.** An assessment that
exists, is honest, and is dated is worth considerably more than a better one
that was never written down.

---

## Sources

Ofcom guidance relied on, as at 7 August 2026:

- *Risk Assessment Guidance and Risk Profiles*, V2.0, 25 June 2026 — the four-step
  methodology (Part 2), Table 8 (what to record), Table 9 (U2U Risk Profile) and
  Figure 1 (risk factor questionnaire), Table 13 (General Risk Level Table),
  Tables 13.1–13.3 (image-based CSAM, CSAM URLs, grooming), Table 14
  (significant change), Table 15 (the 18 kinds of priority illegal content).
- *Illegal Content Codes of Practice for user-to-user services*, 26 February 2025
  — the index of recommended measures, paragraph 5.6 (multi-risk services) and
  the "large service" definition (more than 7 million monthly active UK users).
- *Record-Keeping and Review Guidance*, updated 25 June 2026 — §2 (durable,
  accessible, easy to understand, up to date), §2.6 (three-year retention of
  superseded records), §3 (what the record of a risk assessment must contain).
- Ofcom, *Illegal content duties under the Online Safety Act*, and the
  *Check how to comply with the illegal content rules* tool — first assessment
  deadline of 16 March 2025, three months for newly launched services, and the
  record-keeping template.
- Online Safety Act 2023 — s.9 (risk assessment duties), s.10 (safety duties),
  s.21 (complaints), s.23 (record-keeping), s.59 (illegal content), s.66 and
  s.69 (CSEA reporting), Schedules 5 and 6.

Product facts are sourced inline to files in this repository. Companion
documents: `docs/CONTENT_SAFETY.md` (image scanning, what is and is not
detected, the illegal-content runbook) and `docs/TRUST_AND_SAFETY.md` (intake,
triage, appeals, data-subject requests, and the gap list).
