# How to work on pqp with Rafael

Companion to `HANDOVER-2026-09-07.md`. That one is state. This one is method.

## What he wants from you

His standing instruction, in his words: *"whatever you do, UX needs to be
intuitive. QA everything to make sure it's good. and finally: push ASAP meaning
if it can go, goes. if it needs to wait for down time, schedule it."*

Read that as three rules.

**Ship it.** Client-only and green means merge, do not ask. He called this out
directly after being asked for merge permission he had already granted three
times: *"so after INUMEROUS asks to sort all the PRs you're waiting on my to send
you 2 letters."* If you have raised a concern once and he reaffirms, that is the
decision. Proceed with the full request.

**Schedule, do not park.** Anything that restarts the API waits for quiet, but
"schedule it" means leave a real mechanism running that lands it, not a note for a
human. An agent polling occupancy and merging when the gate opens is the pattern
that works. A gate that can never open is a block pretending to be a schedule: the
first version of this used "zero voice rooms", which never happened once in two
full nights, and it silently held nine PRs.

**QA properly, and distrust green.** More than one bug this week survived because
a test passed without exercising anything: a rail-scroll spec asserting a CSS
property with only two tiles present, an Android contract test served from Gradle
cache, an iOS handshake test that passed with the capability removed. When an
agent writes a test for a bug, have it break the code deliberately and confirm the
test catches it. Several did this unprompted and it earned its keep every time.

## Communication

Terse. Lead with the outcome. He reads on a phone half the time.

No em dashes, ever, in anything: replies, code, copy, commit messages, PR bodies.
This is a hard rule and CI has a test for it in some places.

Portuguese first for anything user-facing, then English. Casual Brazilian
Portuguese, funny, never corporate.

When he asks for a message to send to his community, give him something
pasteable, and check what he has already told them. He corrected me for repeating
two things he had said an hour earlier: *"could you pay attention please"*.

For community replies: never lead with no. Say what works today, what is planned,
and invite them to keep reporting.

## Delegation

Almost everything here goes to a subagent. He asked for this explicitly: *"can you
assign subagents so we can leave the main session clear for our comms"*.

What makes a good brief here:
- Tell it what was already verified and what to check rather than trust.
- Name the traps. There are several in this codebase that look like ordinary
  work and are not.
- Tell it whether it may merge, and what gate applies.
- Tell it to report what it could NOT verify. The best reports this week all
  said plainly what needed a device or a human.

Give agents the occupancy script path and the gate rule rather than a room count,
since the number changes hourly.

## Traps in this codebase

**Working and silently-not-working look identical.** This is the recurring theme.
Dead relay credentials that were never used, a log shipper with a wrong label
shipping nothing, a signing key rotating silently, TestFlight builds reaching
nobody, a roster capability nobody negotiated. When you ship a mechanism, ship the
counter that proves it is running, and read it.

**A client change reaches the server instantly and users gradually.** An API
restart reconnects browsers without reloading them, so any negotiated wire change
starts at zero adoption on a perfect deploy. Do not read that as failure.

**Metrics counters are per process and reset on deploy.** A reading is true until
the next restart. This caught one investigation mid-report.

**The LiveKit room count is not occupancy.** Most calls are peer to peer and
invisible to it. Use the occupancy script, which reads the API.

**Deploy runs show red even when the API deploys fine**, because the worker step
fails on an authorisation error. Judge deploys by the running version and the
health check, never by the workflow's colour.

**Main gets force-pushed.** Twice in two days by the other contributor. Branches
lose their base and show huge phantom conflicts. Recovery is
`git rebase --onto origin/main <old base>`, never a plain rebase, and audit the
result rather than trusting a clean replay.

**Measure, do not extrapolate.** A capacity prediction of 800 to 1000 measured at
350. A load test that bypasses your own code proves nothing about your own code.

## Watching production

A cron job in the session runs `tmp/watch.sh` every 30 minutes and reports rooms,
signups, errors, API version and DNSSEC. It dies with the session, so start your
own. One line unless something changed.

What actually matters in that output: error count, the pool queue, and whether the
API version matches what you think you deployed.

## What he decides, not you

- Spending money. He approved the staging database and the second machine
  explicitly.
- Anything user-visible in his community, like listing a community publicly.
- Legal pages. Project rules keep agents out of them; he overrode that once,
  deliberately, for a page that had become false.

Everything else, he expects you to handle.
