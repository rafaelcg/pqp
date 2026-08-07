# Content safety: image scanning

pqp.gg accepts user-uploaded images. This document says what is checked, what is
not, what happens on a hit, and what the operator has to obtain to close the
gaps that code alone cannot.

It is deliberately blunt about the residual risk. A safety document that reads
like a feature announcement is worse than none, because it makes the untouched
parts invisible.

> **Status as shipped: `CONTENT_SCAN_PROVIDER` is empty, so nothing is scanned.**
> Every attachment row records `scan_status = 'unscanned'`. That is the honest
> state, not a pass. Turning it on is a Railway variable and a restart —
> [Turning it on](#turning-it-on).

---

## Two problems, two answers

These get conflated constantly and they have almost nothing in common.

|  | CSAM | Everything else |
|---|---|---|
| The technique | Perceptual **hash matching** against a curated list of known material | **Classifier** scoring a novel image |
| What it answers | "Is this a file investigators have already seen" | "Does this look like nudity / gore" |
| False positives | Near zero. A match is a match. | Routine. |
| Availability | Every list is behind vetting and a signed agreement | Self-serve, minutes |
| Legal weight | A reporting duty attaches to a hit | A policy decision |

A classifier is **not** a CSAM control. It is trained on adult content and will
neither reliably find novel abuse material nor produce a signal anyone can act
on legally. Anybody who tells you an NSFW model covers this is selling
something.

The corollary matters more: **the part of this that is genuinely dangerous is
the part that needs an application**, and no amount of code closes it. What the
code does is make the hookup a config change and make the current state
explicit.

---

## What is prohibited here, which is not what you would assume

Read `client/src/pages/terms-page.tsx` before tuning a threshold. pqp.gg is an
18+ service and its acceptable-use list **does not prohibit adult nudity**. It
prohibits:

- sexualising minors, and CSAM — "the one rule with no warning step"
- intimate images shared without the subject's consent
- harassment, incitement to violence or self-harm, hate speech
- illegal activity generally

So a stock moderation configuration is actively wrong for this deployment. A
scanner that blocked explicit images would enforce a rule this service does not
have, and would fill the moderation queue with reports no moderator can action —
which trains whoever reads that queue to clear it without reading, which is how
the one report that mattered gets missed.

The policy in `content-scan.ts` follows from that:

| Signal | Verdict | Why |
|---|---|---|
| Sexual content involving an apparent minor | **reject** | The one hard block |
| Provider says "known illegal material" | **reject** | A hash match is not a probability |
| An apparent minor present at all | flag | No version of this service is for minors |
| Graphic violence / gore | flag | Adjacent to the incitement rule; a human decides |
| Adult sexual content | ignored | Not against the rules |
| Non-consensual intimate imagery | **undetectable** | Consent is not visible in pixels |

That last row is not an oversight. It is against the rules, it is one of the
most damaging things that happens on platforms like this, and no classifier in
existence detects it. It stays a human-report problem.

---

## Where the scan runs, and why there

The attachment design has one rule above all others: **object bytes never pass
through the API**. The browser PUTs straight to R2 with a presigned URL and the
server only signs URLs and `HEAD`s the object. Pulling 10 MiB into a Railway
container to post at a classifier would undo the whole point.

So nothing here reads an image. Every provider is handed a **presigned GET valid
for 120 seconds** and fetches the object itself. The API moves a URL and a
verdict.

The scan happens in `verifyPendingAttachments`, on the send path, concurrently
with the `HEAD` that already runs there. Three properties come out of that, and
no other placement has all three:

1. **No transaction is open.** `createMessage` documents the rule: nothing
   between `BEGIN` and `COMMIT` may touch the network, because a bucket that
   blackholes packets would park pooled connections idle-in-transaction and turn
   a storage outage into an API outage. Verification is already outside the
   transaction for exactly this reason.
2. **The image has never been visible.** An attachment is invisible until a
   message claims it — unclaimed rows are hidden even from their uploader.
   Scanning before the claim makes the window in which unsafe content is
   readable **zero**.
3. **Failure is already defined.** An attachment that fails verification is
   dropped from the message and left for the sweeper. "The scan said no" is the
   same event as "the HEAD said no" and needs no new semantics.

The alternatives, and what each gives up:

| Design | Visibility window | Why not |
|---|---|---|
| **At claim time (chosen)** | zero | Costs latency on sends that carry a new image |
| Async after claim | seconds to minutes | The image is live in the channel while it is checked. On a small platform that window *is* the incident. |
| R2 event notification → Worker | seconds to minutes | Same window, plus a queue and a second deployment to keep alive |
| At the edge on read | zero for cached, unbounded otherwise | Cannot stop the bytes being stored, and re-checks the same object forever |

The cost is latency, bounded by `CONTENT_SCAN_TIMEOUT_MS` (default 6s) and paid
only by messages carrying a freshly uploaded image. That bound is the "never
block on a slow third party" rule: a provider that hangs is a provider that
answered `error` six seconds ago.

---

## Fail closed

There are two different unconfigured-looking states and conflating them is how
this kind of code ends up lying.

**No provider configured** — the feature is off, exactly like S3 with no `S3_*`.
Attachments go through, recorded `unscanned`. Not a pass; the truthful statement
that nobody looked. This is the default because a scanner nobody can enable is
worse than an honest gap. A provider *named* without its credentials also reads
as unconfigured, so a half-typed environment does not brick every upload.

**A provider configured that cannot answer** — down, timing out, refusing the
credentials, or returning something that is not a verdict. This is `error`, and
under the default `CONTENT_SCAN_FAIL_MODE=closed` **the attachment is dropped**.
The sender keeps their message and loses the file.

That is the deliberate choice. An operator who turned scanning on asked for
images to be checked; silently publishing unchecked ones the moment the checker
breaks is the single failure this whole feature exists to prevent — and it is
the state that lasts longest and gets noticed least.

`CONTENT_SCAN_FAIL_MODE=open` exists so that trade can be made out loud. It
changes what happens to the image and never what the row says happened: the
verdict is still recorded as `error`, so the gap is auditable afterwards.

Specifically, all of these are `error` and therefore a drop:

- DNS failure, connection refused, TLS failure
- HTTP 4xx (including a revoked or mistyped API key) and 5xx
- a timeout
- a 200 carrying HTML, an empty body, or JSON in an unexpected shape
- a response whose every score field is missing or is not a number in 0..1

That last one is the dangerous shape and the one most likely to be wrong in a
naive implementation. If a provider renames a field, every score reads
`undefined`, nothing crosses a threshold, and the image looks spotless. The
adapters therefore fail when they understand **nothing** in a response, and
`content-scan.test.ts` pins that specific case for all three providers.

---

## What happens on a hit

### Rejected

1. The attachment is **never claimed**, so it never appears in any channel. The
   message still sends, without it.
2. The row records `scan_status='rejected'`, the provider, the top score, the
   labels, and `scanned_at`.
3. `quarantined_at` is stamped, which takes the row **out of the orphan
   sweeper's reach**. Without it, row and object would be deleted within the
   hour — destroying the only evidence the upload ever happened, at the exact
   moment a human is being asked to look at it.
4. A report is filed into the existing moderation queue (`reports`), with
   `reporter_id` NULL. It reaches the same place a human report would: the
   server's owner and admins for a server channel, the instance queue for a
   conversation.

### Flagged

The image **is** posted. A flag means "a human should look at this", not "this
is prohibited". A report is filed exactly as above.

### Illegal

A verdict a provider marks `illegal` — which is what a CSAM hash-match adapter
returns — additionally:

- logs `[content-safety] ILLEGAL-CONTENT MATCH` with the attachment id, the
  uploader id and the provider,
- and the object is **never auto-deleted, at any age**. See
  [the runbook](#runbook-an-illegal-content-hit).

### The queue does not flood

One open automated report per uploader per server, deduplicated in SQL. Without
that, a script uploading in a loop is a way to bury every report a real person
ever filed. Per-object evidence lives on the `message_attachments.scan_*`
columns; the queue entry points a moderator at them:

```sql
SELECT id, uploader_id, channel_id, scan_status, scan_provider,
       scan_score, scan_labels, scanned_at, quarantined_at
FROM message_attachments
WHERE quarantined_at IS NOT NULL
ORDER BY quarantined_at DESC;
```

### Retention

| Row | Held for |
|---|---|
| Ordinary rejection (e.g. gore) | `CONTENT_SCAN_QUARANTINE_DAYS`, default 30 |
| Labelled `illegal` or `csam_suspected` | **Forever, until deleted by hand** |

Thirty days is long enough to answer an appeal and short enough that the bucket
does not become a private archive of everything the scanner ever disliked. The
second row is a deliberate refusal to automate, and it means an unattended
deployment accumulates these rows indefinitely. That is intended: it is the one
place in this codebase where a growing number is the correct alarm.

---

## What the operator must obtain

Ordered by ratio of risk closed to effort.

### 1. Register with the NCA CSEA Industry Reporting Portal — legally required

Online Safety Act 2023 **s.66**, commenced **7 April 2026** by SI 2026/268,
creates a duty for UK providers of regulated user-to-user services to report
detected CSEA content to the National Crime Agency. Ofcom's guidance is explicit
that **the duty applies regardless of service size or assessed risk** — there is
no small-operator exemption, and "it's a hobby project" is not a defence.

The duty does *not* require you to detect anything. It requires you to report
what you do detect, by any means, including a user report or your own eyes.

You must be registered on the portal **before** you can report. Do that now
rather than while holding something you need to report.
<https://www.nationalcrimeagency.gov.uk/what-we-do/crime-threats/child-sexual-abuse-and-exploitation/the-child-sexual-exploitation-abuse-industry-reporting-portal>

Providing false information in purported compliance is an offence under s.69,
up to two years on indictment.

### 2. Write the illegal content risk assessment — legally required, already overdue

Ofcom's illegal harms codes came into force **17 March 2025** and the "suitable
and sufficient" illegal content risk assessment was due **16 March 2025**. The
OSA has no size exemption; duties scale by proportionality, not by switching
off. s.23 requires a written record of the assessment and of the measures taken.

This is the cheapest compliance gap in the list to close and it is currently
open. Write it, date it honestly, keep it.

### 3. Enable Cloudflare's CSAM Scanning Tool — free, zero approval, do it today

Free on all plans including Free. Since February 2025 it **no longer requires
your own NCMEC credentials** — a verified email address is the whole onboarding.
It compares content Cloudflare serves for your zone against NCMEC and other
child-safety hash lists using fuzzy hashing, emails you on a match, and blocks
the matched URL with a 451.

<https://developers.cloudflare.com/cache/reference/csam-scanning/>

Two caveats, and neither is small:

- It is a **serving-path** control, not an upload-path one. It cannot stop bytes
  landing in R2, only stop them being served once matched.
- The setting is **zone-scoped** and the docs describe it as scanning content
  served through the Cloudflare cache. An R2 bucket behind a **proxied custom
  domain on a zone in your account** is the configuration that can be in scope;
  `r2.dev` is explicitly not (no caching, no WAF, no access control). **There is
  no official Cloudflare statement confirming R2-via-custom-domain coverage** —
  open a support ticket rather than assuming it, and do not let it be your only
  line.

If you do this: serve attachments through a proxied custom domain, add a
cache-everything rule for the attachment path, and **disable `r2.dev` public
access** so nothing bypasses it.

### 4. Apply for IWF Image Intercept — free, and the highest-value item on this list

Launched April 2025, Home Office funded, PhotoDNA plus cryptographic hashing
against the IWF hash list, and **free under 1,000,000 checks per month**. It is
aimed explicitly at smaller companies and startups — this deployment is exactly
its target. It requires an eligibility form and IWF review, not a purchase.

<https://www.iwf.org.uk/our-technology/image-intercept>

This is the one that gives real **upload-path** hash matching, which is what
Cloudflare's serving-path tool cannot provide. Once approved, wire it through
the `webhook` provider — see [Wiring a hash matcher](#wiring-a-hash-matcher).

### 5. Apply for Project Arachnid Shield — free, good redundancy

Canadian Centre for Child Protection. Free REST API, PhotoDNA plus perceptual
hashing, detects known CSAM and a broader "harmful-abusive imagery of children"
class. Official SDKs. Sign-up and an API key request rather than a procurement.

<https://projectarachnid.ca/>

### Not worth pursuing at this scale

| | Why |
|---|---|
| Thorn Safer | ~$27,000–$118,000/year |
| Hive CSAM detection | Enterprise sales only |
| IWF full membership | £5,000–£100,000+/year — Image Intercept is the free path to the same list |
| PhotoDNA Cloud Service | Still open, but case-by-case vetting with no SLA; Image Intercept is PhotoDNA anyway |
| Google Child Safety Toolkit | Selective; applications from small operators are declined |
| Ofcom fee registration | Threshold is £250M qualifying worldwide revenue. Not applicable. |

### There is no zero-approval hash list

Meta's PDQ algorithm is open source and free — and ships with **no hash list**,
which detects nothing. Every meaningful corpus (NCMEC's, IWF's, Thorn's) sits
behind vetting and a binding agreement, by design: a publicly downloadable CSAM
hash list would be an evasion-testing tool. So the honest answer to "can I hash
match today with no application" is **no**. The applications above are free and
their bar is low; that is the path.

---

## Turning it on

Set on Railway, then restart. Off is the default and unconfigured is harmless.

### `openai` — free, self-serve, the recommended first step

```
CONTENT_SCAN_PROVIDER=openai
OPENAI_API_KEY=sk-…
```

`omni-moderation-latest` is not billed and does not count against usage limits,
at any volume this service will reach. It accepts an `image_url`, so OpenAI
fetches the object from the bucket and the bytes never touch Railway. It returns
calibrated per-category floats.

**Its limit is the one that matters:** `sexual/minors` is a **text-only**
category. Image input scores it zero regardless of content. So this gives real
coverage of graphic violence, real coverage of adult sexual content (which is
not against the rules here), and **no coverage of the thing that matters most**.
The adapter reads the field anyway, so the day it becomes multimodal this starts
working with no code change.

Cost: **$0** at 1,000 images/month and **$0** at 100,000. Free-tier rate limits
(~250 requests/minute, 5,000/day) cap you around 150k images/month.

### `sightengine` — best taxonomy for an adult platform

```
CONTENT_SCAN_PROVIDER=sightengine
SIGHTENGINE_API_USER=…
SIGHTENGINE_API_SECRET=…
SIGHTENGINE_MODELS=nudity-2.1,gore,face-attributes
```

Self-serve, no sales call. Free tier is **2,000 operations/month, max 500/day**;
models in different groups count as separate operations, so a
nudity+gore+faces call is ~3 ops per image and 1,000 images/month lands at
about 3,000 ops — just over the free tier, i.e. **$29/month** on Starter.
Nudity-only stays free. At 100,000 images/month it is **$209–609/month**, which
is where it stops being viable here.

It is the only provider on the list that separates *minor* from *sexual* as
independent signals, which is why the adapter multiplies them: it takes real
confidence in **both** to reach the reject threshold. That is the right bar for
an automated block a human may never revisit.

### `webhook` — anything you control

```
CONTENT_SCAN_PROVIDER=webhook
CONTENT_SCAN_URL=https://scan.your-worker.workers.dev/
CONTENT_SCAN_TOKEN=<a long random string>
```

Request:

```json
{ "imageUrl": "https://…presigned…", "contentType": "image/png" }
```

with `Authorization: Bearer <CONTENT_SCAN_TOKEN>`. Response, and it is strict:

```json
{
  "verdict": "pass" | "flag" | "reject",
  "score": 0.0,
  "labels": ["gore"],
  "illegal": false,
  "provider": "iwf-image-intercept"
}
```

`verdict` is required and must be one of the three. Anything else — a missing
verdict, a JSON array, a 200 with an empty body — is `error`, which under the
default fail mode drops the attachment. A Worker route that exists but has not
been written yet must not read as a pass.

`illegal` must be literally `true` to take effect; a truthy string does not
count. `provider` overrides the recorded name, so a dispute months later shows
which list matched rather than the word "webhook".

#### A Cloudflare Worker that implements it

The intended shape. Bound directly to the R2 bucket, so it reads the object with
no egress and does not even need the presigned URL; Workers AI runs on the free
10,000 neurons/day allowance. Nothing leaves Cloudflare's network.

```js
export default {
  async fetch(request, env) {
    if (request.headers.get("authorization") !== `Bearer ${env.SCAN_TOKEN}`) {
      return new Response("no", { status: 401 });
    }
    const { imageUrl } = await request.json();

    // Read from the bucket binding rather than the URL: same account, no
    // egress, and the presigned URL never has to be trusted or followed.
    const key = decodeURIComponent(new URL(imageUrl).pathname.slice(1));
    const object = await env.ATTACHMENTS.get(key);
    if (!object) {
      // Refuse rather than guess. The API treats a non-verdict as `error`,
      // which under the default fail mode drops the attachment.
      return new Response("{}", { status: 404 });
    }
    const bytes = await object.arrayBuffer();

    // 1. Hash match first — this is the one with legal weight, and it is
    //    cheap. Wire your approved provider here.
    // const hit = await checkHashList(bytes, env);
    // if (hit) {
    //   return Response.json({ verdict: "reject", score: 1, illegal: true,
    //     labels: ["illegal"], provider: "iwf-image-intercept" });
    // }

    // 2. Classifier second, for everything a hash list cannot know about.
    const out = await env.AI.run("@cf/microsoft/resnet-50", { image: [...new Uint8Array(bytes)] });

    return Response.json({ verdict: "pass", score: 0, labels: [], provider: "cf-workers-ai", _: out });
  },
};
```

`wrangler.toml`:

```toml
[[r2_buckets]]
binding = "ATTACHMENTS"
bucket_name = "pqp-attachments"

[ai]
binding = "AI"
```

Note what that example is and is not. The R2 read, the auth check, the
fail-by-refusing and the response shape are real. `resnet-50` is ImageNet-1k and
has **no nudity or gore classes** — Cloudflare ships no purpose-built moderation
classifier, so a Workers AI implementation means prompting a vision model
(`llama-3.2-11b-vision-instruct`, roughly $0 at 1,000 images/month and ~$7 at
100,000) with accuracy nobody has measured for adversarial input. Treat the
Worker as the place the **hash matcher** goes; the classifier is better served
by `openai`.

### Wiring a hash matcher

Once approved for IWF Image Intercept or Project Arachnid Shield: implement
their call inside the Worker above, at step 1, and return
`{"verdict":"reject","illegal":true,"labels":["illegal"],"provider":"<name>"}`
on a match. Everything downstream already works — block, quarantine, no
auto-delete, the shouty log, the report. **That is the entire integration**, and
it is the reason the plumbing exists in this shape.

---

## Runbook: an illegal-content hit

Triggered by `[content-safety] ILLEGAL-CONTENT MATCH` in the logs, or a
`csam_suspected` / `illegal` row in the quarantine query above.

**Do not open the file.** Nothing about this process requires you to look at it,
and the legal protection for handling it covers what is *necessary*, not what is
curious.

1. **Preserve.** Do not delete the object, the row, or the surrounding logs.
   The CPS/NPCC memorandum on s.46 of the Sexual Offences Act 2003 — the
   provision that protects service operators who encounter this material in the
   course of their duties — expects reasonable steps to preserve data relevant
   to the discovery, held securely with restricted access. The quarantine sweep
   already refuses to touch these rows at any age.
2. **Suspend the account.** Ban the uploader; the terms make this the one rule
   with no warning step.
3. **Report to the IWF.** Reports made to the IWF in line with its procedures
   are accepted as a report to a relevant authority.
   <https://report.iwf.org.uk/>
4. **Report to the NCA** via the CSEA-IRP. This is the s.66 statutory duty.
   Content already reported to NCMEC counts, since NCMEC refers UK-linked
   reports onward — but if you are UK-based, the NCA portal is the direct route.
5. **Record it.** Report reference, timestamps, attachment id, uploader id,
   what was preserved and where. Keep it with the s.23 records.
6. **Delete only when told to**, and record who told you.

Relevant offences, so the shape of the risk is clear rather than vague:
Protection of Children Act 1978 s.1 (taking, *making* — which includes causing a
copy to exist — distributing, or possessing with a view to distribution) and
Criminal Justice Act 1988 s.160 (simple possession). PCA 1978 s.1B, inserted by
s.46 SOA 2003, provides a defence where the handling was necessary for the
prevention, detection or investigation of crime. That defence protects the
process above; it does not protect browsing, collecting, or "verifying" beyond
need.

---

## Residual risk, stated plainly

Everything below is true with the recommended configuration (`openai`) turned
on. This is the honest list.

1. **Novel CSAM is not detected.** With `openai`, `sexual/minors` is text-only,
   so image input scores it zero — the category exists in the adapter and
   returns nothing. Until a hash-matching provider is wired through the
   `webhook` adapter, **the CSAM control on this platform is a user report, an
   operator's eyes, and Cloudflare's serving-path scanner if enabled**. This is
   the largest remaining gap and it is closed by an application, not by code.
2. **Hash matching only ever finds known material.** Even with IWF Image
   Intercept live, first-generation material has no hash and will not match.
   Nothing available at this price detects it.
3. **Non-consensual intimate imagery is undetectable.** Prohibited by the terms,
   invisible to every classifier. Human reports only.
4. **Video, audio and PDF are not scanned at all.** They are recorded `skipped`,
   which is not `pass`. Only the five raster image types are checked. A video
   attachment is entirely unexamined.
5. **Nothing uploaded before scanning was enabled has been checked.** Those rows
   read `unscanned` and there is no backfill. Writing one is possible — iterate
   the rows, presign, scan — but it is not implemented, and on a free tier it is
   rate-limited rather than instant.
6. **A classifier's judgement is probabilistic.** The reject threshold is 0.9 by
   default. Something at 0.89 is posted and flagged. Something at 0.91 is
   blocked and might be a false positive with no appeal path in the product yet
   — the sender is told the file did not attach, and is not told why.
7. **`flagged` content is live while it waits.** A flag posts the image and
   files a report. If nobody reads the queue, that is where it stays.
8. **The presigned URL is handed to a third party** and lands in their logs for
   120 seconds of validity. Short, but not zero. A `webhook` provider inside
   Cloudflare avoids this entirely by reading the bucket binding.
9. **An object can still be replaced after it is scanned.** The presigned PUT
   stays valid for its 15-minute TTL and an S3 PUT is an unconditional
   overwrite, so a body of *identical length* can be swapped in after the scan
   and after the claim. This predates scanning (see the note on `presignPut` in
   `lib/s3.ts`) and scanning does not close it.
10. **`CONTENT_SCAN_FAIL_MODE=open` disables the protection** during exactly the
    outage in which it matters. It is not the default; do not set it and forget.
11. **Age assurance is a separate, unaddressed duty.** A self-declared "18 or
    over" checkbox is not "highly effective age assurance" under the OSA Part 3
    / Part 5 duties, live since 25 July 2025. If pornographic content can appear
    here, that is a distinct compliance surface this document does not cover.

---

## Reference

### Environment

Full annotations in `.env.example`.

| Variable | Default | Effect |
|---|---|---|
| `CONTENT_SCAN_PROVIDER` | *(empty)* | `openai` \| `sightengine` \| `webhook`. Empty = off. |
| `CONTENT_SCAN_FAIL_MODE` | `closed` | `open` posts images a broken scanner could not judge |
| `CONTENT_SCAN_TIMEOUT_MS` | `6000` | Hard ceiling on how long a send waits |
| `CONTENT_SCAN_REJECT_THRESHOLD` | `0.9` | Block at or above. Values outside 0..1 ignored. |
| `CONTENT_SCAN_FLAG_THRESHOLD` | `0.55` | Queue for review at or above |
| `CONTENT_SCAN_FLAG_MINORS` | `true` | Flag an apparent minor even with no sexual context |
| `CONTENT_SCAN_QUARANTINE_DAYS` | `30` | Ordinary rejections only; never illegal ones |
| `OPENAI_API_KEY` | | provider=openai |
| `OPENAI_MODERATION_MODEL` | `omni-moderation-latest` | provider=openai |
| `SIGHTENGINE_API_USER` / `_SECRET` | | provider=sightengine |
| `SIGHTENGINE_MODELS` | `nudity-2.1,gore,face-attributes` | provider=sightengine |
| `CONTENT_SCAN_URL` / `CONTENT_SCAN_TOKEN` | | provider=webhook |

### Columns on `message_attachments`

| Column | |
|---|---|
| `scan_status` | `unscanned` \| `skipped` \| `pass` \| `flagged` \| `rejected` \| `error` |
| `scan_provider` | Who said so. Null only while `unscanned`. |
| `scan_score` | Top category score, 0..1, normalised by the adapter |
| `scan_labels` | JSONB array of categories over threshold |
| `scanned_at` | When |
| `quarantined_at` | Set on rejection. Excludes the row from the orphan sweeper. |

`unscanned` is **not** a synonym for `pass` and nothing in this codebase treats
it as one.

### Cost at a glance

| Provider | 1,000 img/mo | 100,000 img/mo | Approval |
|---|---|---|---|
| OpenAI omni-moderation | **$0** | **$0** | none |
| Cloudflare Workers AI (via webhook) | $0 | ~$7 | none |
| Sightengine (nudity only) | $0 | ~$209 | none |
| Sightengine (nudity+gore+faces) | ~$29 | ~$609 | none |
| AWS Rekognition | $1 | $100 | none |
| Google Vision SafeSearch | $0 | ~$149 | none |
| Azure AI Content Safety | $0 (F0, 5k/mo) | ~$75 | none |
| **IWF Image Intercept (CSAM)** | **$0** | **$0** (<1M/mo) | **application** |
| **Project Arachnid Shield (CSAM)** | **$0** | **$0** | **application** |
| Cloudflare CSAM Scanning Tool | $0 | $0 | none (email only) |

Anthropic's Claude is deliberately absent: its acceptable use policy forbids
processing explicit images, so it is the wrong tool here regardless of price.

### Code

| File | |
|---|---|
| `server/src/services/content-scan.ts` | Providers, policy, fail-closed rule |
| `server/src/services/attachments.ts` | Where the scan runs, quarantine, escalation |
| `server/src/services/reports.ts` | `createAutomatedReport` |
| `server/src/services/content-scan.test.ts` | Failure modes, per provider |
| `server/src/services/attachments.test.ts` | `describe("scanning")` — the DB consequences |
