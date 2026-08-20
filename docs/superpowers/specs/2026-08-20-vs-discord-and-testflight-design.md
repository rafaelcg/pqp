# Design: `/vs-discord` scoreboard + TestFlight external beta path

**Date:** 2026-08-20  
**Status:** Draft for review  
**Approved direction:** Scoreboard page (Approach A), bilingual, spicy/honest tone  
**URL:** `/vs-discord`

---

## 1. Goals

1. Ship a marketing page that converts people who need **screen share / video in Brazil today**, without trash-talking Discord where it still wins.
2. Make the **iOS TestFlight beta** an honest, shippable offer (external testers), including the App Store Connect **Sign-in information** demo account Apple expects.
3. Keep claims **verified** against the product and public Discord/ANPD reporting.

Non-goals: App Store public release this cycle; landing-nav link (optional follow-up); `/discord` redirect alias (optional follow-up); full iOS CI pipeline (nice-to-have after first external beta).

---

## 2. Fact sheet (do not ship untrue cells)

| Claim | Verdict | Source / note |
|---|---|---|
| Discord screen share / video / Go Live suspended in Brazil since **17 Aug 2026** | True | Discord’s letter to BR users; G1 coverage; ANPD preventive measure (order ~12 Aug, effect 17 Aug). Frame as **product claim**, not legal advice. |
| No return date | True | Discord’s letter: working to restore, no date. |
| pqp screen share works | True | Mesh + SFU; landing already sells it. |
| pqp camera in calls works | True | Conversation/DM camera path; do **not** claim camera in every voice-channel UX if we only advertise call camera — copy says “camera in calls”. |
| Free / open source / self-host | True | Hosted pqp.gg free; repo public; self-host docs. |
| Native 18+ age gate | True | Server age gate from day one. |
| Servers in São Paulo | True | Live API on Fly `gru`; privacy policy says São Paulo. **Marketing copy says “São Paulo” only — never “Fly” / “gru” (ops jargon).** |
| Desktop app | True | Electron, offered on landing. |
| iOS App Store live | **False** | Do not claim. |
| iOS TestFlight | **True (internal already)** | Repo at version **1.0 (11)**; Release signing + `gg.pqp.app` + live Clerk key in `project.yml`. External beta + ASC Test Information still need owner steps. |
| Discord wins: ecosystem, maturity, store apps | True | Say it out loud. |

---

## 3. Page design — `/vs-discord`

### 3.1 Job and tone

Same register as the landing: Brazilian informal in pt-BR (“você”), spicy EN that keeps the job of the joke. Discord gets credit. No roadmap promises.

### 3.2 Structure

```
[MarketingNav solid]
[Hero: brand "pqp" → H1 → short intro → small product-claim disclaimer]
[Scoreboard]
[Closing + primary CTA]
[MarketingFooter]
```

- **No full-bleed photo hero.** The scoreboard is the visual product of the page.
- **Signature:** sticky column headers (desktop); pqp column gets a quiet signal edge; status chips (`works` / `suspended` / `yes` / `no` / `partial`).
- **Desktop:** real `<table>` for accessibility.
- **Mobile:** stacked row cards (label → pqp block → Discord block), same chips — no squeezed 3-column table.
- **Motion:** rise-in hero + staggered rows; respect `prefers-reduced-motion`.
- **Shell:** `DarkRoutes`, lazy page chunk, `Seo` with bilingual title/description, path `/vs-discord`.

### 3.3 CTA

Primary: create a room / open sign-up → `/app` (same Clerk modal pattern as landing).  
Optional secondary: link to TestFlight once a **public or invite link** exists (hide until Rafael pastes the URL into env or catalogue).

### 3.4 Rows (chips)

| Row | pqp | Discord |
|---|---|---|
| Screen share | works | suspended |
| Camera in calls | works | suspended |
| Price | yes | yes |
| Open source | yes | no |
| Self-host | yes | no |
| 18+ age gate | yes | yes (neutral) |
| Where we run it | yes — **São Paulo** (no vendor/region codes in UI) | partial (global; don’t invent their map) |
| Native apps | **partial** — Desktop ships; iOS **TestFlight beta**, not App Store | yes — polish, Android, stores |
| Ecosystem | no / young | yes |
| Maturity | partial — open beta | yes |

Copy lives in `catalogue.ts` + `messages.pt-BR.ts` under `vsDiscord.*` keys (drafted in research; polish in implementation). H1 may use the user’s “comparação honesta (2026)” framing in pt-BR; EN keeps the same honesty job.

**Copy banlist for end-user strings:** `Fly`, `gru`, `Railway`, bundle IDs, mesh/SFU, Clerk — say “São Paulo”, “open source”, “self-host” (label), not infra.

### 3.5 Implementation sketch

| Piece | Path |
|---|---|
| Page | `client/src/pages/vs-discord-page.tsx` |
| Route | `client/src/main.tsx` under `DarkRoutes` |
| i18n | `vsDiscord.*` in catalogue + pt-BR |
| Reuse | `MarketingNav`, `MarketingFooter`, `Seo`, `Button`, existing motion/utils |

No new design-system package. Prefer one focused comparison component colocated with the page if the table markup gets long.

---

## 4. TestFlight / App Store Connect workstream

### 4.1 What “signin info account” means here

Three different things people mix up:

| | Meaning | Need? |
|---|---|---|
| (a) | Rafael’s Apple ID / ASC team access | Always (owner only) |
| (b) | Sign in with Apple capability | Only if Clerk shows Google (etc.) as a primary login |
| (c) | **ASC “Sign-in information” = demo username/password for Apple reviewers** | **Yes for external TestFlight and App Store** |

**(c) is what we will create.** A dedicated production Clerk user with email+password, age gate already passed, seeded into a small sample server, credentials pasted into App Store Connect → TestFlight → Test Information.

It is **not** creating a new Apple Developer login (unless membership is missing — team `WXBFUF9WMA` already appears in `project.yml`).

### 4.2 Current iOS shipping reality

- Bundle ID `gg.pqp.app`, team `WXBFUF9WMA`, Release profiles named `pqp appstore` / `pqp broadcast appstore`.
- Version **1.0 (11)** already in plists; prior TestFlight uploads happened manually.
- No iOS GitHub Actions / Fastlane in repo; `ios/asc/` is empty; uploads stay manual for this cycle.
- In-app Report/Block exist on iOS (`ReportSheet`) — important for guideline **1.2**; some trust docs may be stale.

### 4.3 Shortest path to external TestFlight

1. Confirm ASC app + distribution profiles still valid.
2. Clerk: ensure **email + password** works for a demo user; check whether Google login is on → SIWA decision.
3. Create demo user `appstore-review@…` (inbox Rafael controls), strong password, complete **18+** age gate once.
4. Seed a private sample community with a few messages + a second dummy user (so Report/Block are exercisable).
5. Archive Release → **Internal** TestFlight → smoke the demo account on a device.
6. Fill Test Information + Sign-in credentials + Notes (age gate done; where Report/Block live; privacy/terms URLs).
7. Add build to **External** group → Beta App Review → invite / public link.
8. Paste TestFlight URL into the vs-discord page (or a small `VITE_TESTFLIGHT_URL` / catalogue key) when ready.

### 4.4 Owner-only vs agent-automatable

**Rafael only:** Apple login, ASC UI, certificates/profiles renewal, Clerk dashboard user create, paying Developer Program, answering Beta App Review.

**Agent can:** draft ASC Notes text; document the checklist in `docs/`; add vs-discord page + TestFlight CTA wiring; optionally script seeding *after* the Clerk user exists (API with Bearer token); verify Report/Block paths; later iOS CI (out of scope for v1 of this work).

### 4.5 Risks to name in Notes / prep

- **Guideline 1.2 (UGC):** reviewers must be able to report and block inside the app.
- **Guideline 4.8:** Sign in with Apple if third-party social login is offered.
- **Age gate:** demo account must already be adult-declared.
- **APNs:** optional for first external beta install; required only if push is in the test story (`APNS_ENVIRONMENT=production` for TestFlight).

---

## 5. Delivery plan (after spec approval)

Parallel tracks:

| Track | Work |
|---|---|
| **A — Web** | Implement `/vs-discord` + i18n + e2e smoke (route renders, table/dialog a11y basics) |
| **B — Docs** | Add `docs/TESTFLIGHT.md` runbook from §4 (owner checklist + demo account recipe) |
| **C — Demo account** | Rafael creates Clerk user; agent helps seed server + draft ASC Notes once credentials exist |
| **D — Wire CTA** | When external link exists, show TestFlight affordance on vs-discord (and optionally landing) |

Implementation plan file to follow via writing-plans after this spec is approved.

---

## 6. Open questions for Rafael (blockers only)

1. Confirm Clerk production has **password** sign-in enabled (not OTP-only) for the demo account.
2. Is **Google (or other social)** enabled on Clerk for iOS? If yes, SIWA is in scope before external review.
3. Preferred demo email domain / inbox for `appstore-review@…`.
4. When external TestFlight link exists, should it appear on `/vs-discord` only, or landing too?

---

## 7. Spec self-review

- No TBD rows in the comparison table — apps row corrected to TestFlight.
- São Paulo claim tied to live Fly deploy, not aspirational Railway.
- App Store “signin” disambiguated to demo credentials (c).
- Scope capped: page + TestFlight path docs/demo prep; not full App Store launch or iOS CI.
