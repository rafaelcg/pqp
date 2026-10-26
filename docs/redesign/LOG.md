# Redesign log

Status, decisions, council scores and open questions for the redesign. The
element list and its order are in [`INVENTORY.md`](./INVENTORY.md). The method
is [`docs/DESIGN_COUNCIL.md`](../DESIGN_COUNCIL.md).

Read this file and the inventory at the start of every session.

## How the work is organised

- Integration branch: `redesign`, local only. Never pushed, never merged into `main`.
- Element branches: `rd/<element-id>`, cut from `redesign`, merged back with
  `--no-ff`, then deleted. (The plan said `redesign/<id>`. Git cannot hold a
  branch `redesign` and a branch `redesign/x` at the same time, so the prefix
  is `rd/`.)
- Before each element: merge `main` into `redesign`.
- Screenshots and council answers: `~/pqp-redesign/<element-id>/`, never in git.
- Baseline screenshots of `main`: `~/pqp-redesign/baseline/`.
- Council: three reviewers on three providers, one brief, read-only. Roster:
  Claude Opus 5.5, Codex GPT-6 Luna, Gemini 4 Argon (through Cursor). Reasoning
  high for all three.
- Toggle (Phase 1): `data-redesign` on `<html>`, a `redesign:` Tailwind variant,
  Settings > Beta "Novo visual", runtime flag `redesign` (default off).

## Status

| Phase | Item | Status |
|---|---|---|
| 0 | Council tooling committed as the first commit on `redesign` | Done |
| 0 | Inventory | Done |
| 0 | Three directions, mockups and council round D1 | Done (2 of 3 reviewers) |
| 0 | André picks a direction | Done: B (Salas), with filled icons |
| 1 | Toggle | Done |
| 1 | Tokens for the chosen direction | Built on `rd/tokens`, council round T3 running |
| 1 | André signs off on `/qa/ui` | Not started |

## Phase 0: directions

The mockups live on branch `rd/directions` (not merged). Open
`/qa/directions/a`, `/b` or `/c`, with `?mode=light` for light, under the dev
auth bypass. Screenshots: `~/pqp-redesign/directions/`.

Every direction draws the same scene as the council capture, so the only
variable is the design. All three keep the lime accent and the pt-BR voice.

| Id | Name | Idea |
|---|---|---|
| a | Afinado | The current shell, retuned. Panes separated by tone, not lines. One quiet type scale, lime only for state (selected server, mention, presence). Closest to today, lowest risk. |
| b | Salas | Rounded panels floating on a darker canvas, with gutters. More air: 40px avatars, 23px line height, pill-shaped rows and composer. Selected channel is a soft lime pill. Softer and more "app". |
| c | Fliperama | Flat and loud. Ink borders, 4px corners, Gabarito uppercase for server, channel and section names, mono timestamps, a solid lime rail and a solid lime selected channel. Most character, most risk. |

### Council round D1

Answers: `~/pqp-redesign/directions/council-d1/`. Gemini 4 Argon failed
(Cursor: "not included in your weekly usage"), so this round has two reviewers.

| Overall | Current | A Afinado | B Salas | C Fliperama |
|---|---|---|---|---|
| Claude Opus 5.5 | 6.2 | 7.6 | 7.2 | 6.6 |
| Codex GPT-6 Luna | 6.5 | 7.8 | 7.4 | 7.0 |

Both recommend A. Both score C highest on Character (9.0, 8.5) and lowest on
Scalability (4.8, 5.5): a solid lime rail and selected row become a large
saturated slab when a look retints the accent.

What both say A should take from the others:

- From C: Gabarito as a display role for the server name and channel title,
  sentence case. Tabular or mono timestamps.
- From B: a rounded, inset composer with a filled round send button.
- From B: a little more separation between panes, and a raised "you" card
  at the bottom of the sidebar (Opus).

What Phase 1 tokens must solve for A (both reviewers):

1. Accent used as text in light mode is about 2:1. Add an `accent-text`
   (and `success-text`) role that reaches 4.5:1 in every look.
2. Mention highlight needs its own tokens (row, bar, chip) per look; lime at
   low alpha reads khaki in dark.
3. Pane separation by tone alone collapses in light. Set a minimum lightness
   step between adjacent panes, checked on every look.
4. Selected, hover and unread need distinct treatments.
5. Contrast floors for timestamps, offline names and placeholders.

## Phase 1: tokens

Branch `rd/tokens`. Screenshots and council answers: `~/pqp-redesign/t-tokens/`.
The method and every value are in `docs/DESIGN.md`, section "The redesign
(Salas)". In short:

- Shape for every look: radius 4/10/14/20 px and pill rows, Gabarito for the
  title role, 22px body leading, 36px rows, an 8px gutter (0 under 640px),
  snappier motion, a deeper modal shadow.
- The Salas palette for Clássico, dark and light. Accent unchanged, so the
  custom accent hue still applies.
- New roles for the council's D1 asks: `canvas`, `pane-side`, `pane-main`,
  `row-hover`, `row-selected`, `on-row-selected`, `accent-text`,
  `success-text`, `mention-row`, `mention-bar`, `mention-chip`,
  `on-mention-chip`. Each is derived with `color-mix(in oklab, …)` from roles
  every look already sets.
- Small redesign-only fixes for Night, Modo 2005, Everforest and Catppuccin,
  so the new roles pass there.
- Filled icons: `@phosphor-icons/react` and `ui/icon.tsx` (objects fill,
  symbols bold).
- The bench measures 20 new pairs and 7 pane steps on every look with the
  toggle on: 3062/3062 contrast, 308/308 steps, 0 leaks, 0 drift.
- `/qa/ui` has the redesign switch, a shell specimen built from tokens only,
  and an icons section.

Toggle off: no line of `index.css` was removed and every new selector needs
`data-redesign`, so every existing token keeps its value.

Verified: client typecheck, 811 unit test files (10,309 tests), i18n check,
bench:tokens.

### Council round T1

Answers: `~/pqp-redesign/t-tokens/council-t1/`. Two reviewers (see open
question 1).

| Overall | Toggle off | Redesign on |
|---|---|---|
| Claude Opus 5.5 | 6.6 | 7.8 |
| Codex GPT-6 Luna | 7.0 | 8.5 |

Both flagged the Night light shot as dark. Not a bug: Night is dark only
(`appearanceForcesDark`), so its light block never applies. Fixed after T1:
one pane rule (the conversation is always the brightest pane), a darker Modo
2005 canvas, a visible Night conversation pane, spread Everforest light text,
a lime label on the Clássico dark selected row. Deferred to the element
rounds: an inset mention radius, a composer fill role, read rows in
`text-tertiary`.

### Council round T2

Answers: `~/pqp-redesign/t-tokens/council-t2/`.

| Overall | Toggle off | Redesign on |
|---|---|---|
| Claude Opus 5.5 | 6.6 | 8.4 |
| Codex GPT-6 Luna | 7.6 | 8.4 |

Codex: no fixes. Opus MUST: Modo 2005 light had the side pane brighter than
the conversation. Fixed, and the bench now checks the pane order on every
look (`order`), because a distance alone let the swap pass. Also: the
selected row's label is `accent-text` in every dark look, and Night's side
pane sits further off the black canvas. Deferred to the pane header element:
a 16px title in the target versus the 18px title role.

## Open questions for André

1. The third council reviewer: Gemini 4 Argon is out of Cursor credits. Use
   Grok 4.7 or GPT-5.6 Sol (both on Cursor) instead, buy credits, or run with
   two reviewers?
2. Four features live in two versions behind flags. The redesign should
   rebuild only the version that stays. Which one stays for each?
   - DM list: classic or Conversas home (`conversations_home`).
   - New conversation dialog: classic or new.
   - Phone shell: bottom tabs (`conversations_home_phone_tabs`) or the drawer.
   - Channel list: mixed layout (`mixed_channel_list`) or legacy sections.
3. `error-boundary.tsx` is English only, and AGENTS.md says to leave it alone.
   Redesign its look and keep the copy as is?

## Decisions

| Date | Decision | Why |
|---|---|---|
| 2026-10-26 | Element branches use `rd/<id>` | Git ref conflict with `redesign`. |
| 2026-10-26 | Direction mockups are a dev-only page on an unmerged branch | Real pixels for the pick, no change to production components, nothing to clean up on `redesign`. |
| 2026-10-26 | Direction B (Salas), with filled icons instead of outlines | André's pick. The council preferred A; B was second for both reviewers (7.2, 7.4), and the risks they named for B go into the Phase 1 tokens: gutters cost width on small screens, and a third surface level invites card-in-card settings. |
| 2026-10-26 | Redesign colours are scoped to Clássico; shape applies to every look | A look is a palette. The other looks keep their identity and get only the fixes the new roles need. |
| 2026-10-26 | Derived roles use `color-mix(in oklab)`, and the bench and `/qa/ui` learned to read it | One formula reaches all ten looks, the custom accent and high contrast, and stays measured. |
| 2026-10-26 | `ui/icon.tsx` ships with the tokens | It is the only place the fill-or-bold rule lives, and the sheet needs it to show the icon tokens. |
| 2026-10-26 | Council T1 runs with two reviewers | Gemini 4 Argon is still out of credits; the third seat waits on open question 1. |
| 2026-10-26 | The toggle ships before the tokens | It is the same for every direction and changes nothing visible. Precedence: `?redesign=1|0`, then the person's Beta switch (`pqp-redesign`), then the `redesign` flag. |
