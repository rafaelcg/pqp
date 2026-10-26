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
| 1 | Tokens for the chosen direction | Not started |
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
| 2026-10-26 | The toggle ships before the tokens | It is the same for every direction and changes nothing visible. Precedence: `?redesign=1|0`, then the person's Beta switch (`pqp-redesign`), then the `redesign` flag. |
