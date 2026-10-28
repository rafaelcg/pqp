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
  Claude Opus 5.5, Codex GPT-6 Luna, Grok 4.7 (through Cursor). Reasoning
  high for all three. (Gemini 4 Argon was the first pick; it ran out of
  Cursor credits, and André chose Grok on 2026-10-26.)
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
| 1 | Tokens for the chosen direction | Done |
| 1 | André signs off on `/qa/ui` | Done, after round T3 |
| 2 | `p-button` | Merged (cap at round 5: 8.9, 8.9, 9.0, no MUST) |
| 2 | `p-icon-button` | Merged (cap at round 5: 9.0, 8.9, no MUST) |
| 2 | `p-tooltip` | Merged (cap at round 5: 8.9, 8.8, no MUST) |
| 2 | `p-input` | Merged (cap at round 5: 8.7, 8.9, no MUST) |
| 2 | `p-select` | Merged (cap at round 5: 8.9, 8.8, no MUST) |
| 2 | `p-checkbox` | Merged (cap at round 5: best round 3, 8.6, 8.5; round 5 MUST fixed) |
| 2 | `p-popover` | Merged (cap at round 5: 8.4 Opus, 8.3 Codex r4, no MUST) |
| 2 | `p-radio` | Merged (cap at round 5: 8.3 Opus r4, 8.0 Codex r5, no MUST) |
| 2 | `p-tabs` | Merged (cap at round 5: 8.4 Opus r5, 8.7 Codex r4, no MUST) |
| 2 | `p-menu` | Merged (cap at round 5: 8.4 Opus r5, 8.4 Codex r4, no MUST, approved) |
| 2 | `p-slider` | Merged (cap at round 5: 8.0 Opus r4, 8.8 Codex r5, no MUST) |
| 2 | `p-banner` | Merged (approved at round 3: 8.3 Opus, 8.5 Codex r2, no MUST) |
| 2 | `p-badge` | Merged (approved at round 2: 8.3 Opus, 8.3 Codex r1, no MUST) |
| 2 | `p-toast` | Merged (cap at round 5: 8.5 Opus r5, 8.7 Codex r2, no MUST) |
| 2 | `p-avatar` | Merged (cap at round 5: 8.6 Opus r5, 8.7 Codex r2, no MUST) |
| 2 | `p-list-row` | Merged (cap at round 5: 8.6 Opus r5, 8.4 Codex r2, no MUST) |
| 2 | `p-card` | Merged (cap at round 5: 8.5 Opus r5, 8.4 Codex r1, no MUST) |
| 2 | `p-section-header` | Merged (cap at round 5: 8.0 Opus r5, 8.4 Codex r2, no MUST) |
| 2 | `p-loading` | Merged (cap at round 5: 8.6 Opus r5, 8.6 Codex r4, no MUST) |
| 2 | `p-empty` | Merged, capped at round 5 (Opus 8.6) |
| 2 | `p-sheet` | Merged, capped at round 5 (Opus 8.6) |
| 2 | `p-dialog` | Merged, capped at round 5 (Codex 8.7 r2, Opus 8.2 r4) |
| 2 | `p-scroll` | Merged, capped at round 5 (Opus 7.9 r5, 8.6 r4). Hover thumb contrast not measured; Windows check open |
| 2 | `p-settings-kit` | Merged, capped at round 5 (Opus 8.5 r5, 8.5 r2) |
| 3 | `s-frame` | Merged, capped at round 5 (Opus 8.8) |
| 3 | `s-rail` | Merged, capped at round 5 (Opus 8.2 r5, 8.8 r3) |
| 3 | `s-sidebar-header` | Merged, capped at round 5 (Opus 8.3 r5, 8.7 r3) |
| 3 | `s-sidebar-special` | Merged, capped at round 5 (Opus 8.1 r5, 8.6 r2; r5 MUST fixed after) |
| 3 | `s-category` | Merged, capped at round 5 (Opus 7.9 r5, 8.3 r3) |
| 3 | `s-channel-row` | Merged, capped at round 5 (Opus 8.5 r5). Follow-up: tooltip `sideOffset` so the name bubble clears the tiles |
| 3 | `s-voice-row` | Merged, capped at round 5 (Opus 8.0 r5, 8.2 r3). Open: light selected and connected fills are close; check with the token owner |
| 3 | `s-sidebar-rail` | Merged, capped at round 5 (Opus 8.1 r4 and r5) |
| 3 | `s-voice-strip` | Merged, capped at round 5 (Opus 8.1 r5). Follow-ups: composer hang-up glyph (`s-composer`), music idle row fixture (`m-sheets`) |
| 3 | `s-user-panel` | Merged, capped at round 5 (Opus 8.2 r5). Open: the Invisível hint is seven lines at the card width (copy, shows with the toggle off) |
| 3 | `s-header` | Merged, capped at round 5 (Opus 8.3 r4 and r5). Follow-up: rename `--pane-header-rule` / `--pane-header-px` to `--pane-bar-*` after the chain |
| 3 | `s-banners` | Merged, capped at round 5 (Opus 8.2 r5, MUST fixed after). Not done: a dark-only accent edge |
| 3 | `s-message-row` | Merged, capped at round 5 (Opus 8.5 r5) |
| 3 | `s-message-content` | Merged, capped at round 5 (Opus 8.6 r5). Open: the broken-image chip is English in every language (question in the spec) |
| 3 | `s-message-chrome` | Merged, capped at round 5 (Opus 8.6 r3 and r5, Codex 8.6 r4) |
| 3 | `s-log-chrome` | Merged, capped at round 5 (Codex 8.6 r5, Opus 8.5 r4). Open: "Load older messages" is English in every language |
| 3 | `s-composer` | Merged, capped at round 5 (Codex 8.8 r5, Opus 8.3 r4). Not on the sheet: an attachment chip and the autocomplete |
| 4 | `f-onboarding` | Merged, capped at round 5 (Opus 8.3 r3 and r5) |
| 5 | `m-sheets` | Merged, approved at round 5 (Opus 9.0, no MUST) |
| 4 | `f-user-settings` | Merged, capped at round 5 (Opus 8.1 r5, 8.2 r4) |
| 4 | `f-connections` | Merged, capped at round 5 (Opus 8.4 r3 and r4, 8.3 r5). Open: question 6 (copy) |
| 4 | `f-search` | Merged, capped at round 5 (Opus 8.5 r5). Not done: `<li role="none">` inside the listbox (it changes the toggle-off tree too) |
| 4 | `f-server-settings` | Merged, capped at round 5 (Opus 7.8 r5, 7.9 r4) |
| 4 | `f-invites` | Merged, capped at round 5 (Opus 7.8 r5, 8.1 r3 and r4) |
| 4 | `f-communities` | Merged, capped at round 5 (Opus 7.6 r5, 8.1 r3). Not done: a balanced chip wrap |
| 4 | `f-bots` | Merged, capped at round 5 (Opus 8.3 r5). Not done: a spinner on the wizard's final button while it saves |
| 4 | `f-states` | Merged, capped at round 5 (Opus 8.1 r5, 8.3 r4). Open: question on the deploy notes' wording (Railway). Not done: the error page in the canvas frame |
| 4 | `f-profile` | Merged, capped at round 5 (Opus 8.2 r5, MUST in r1 fixed). Not done: a filled check for "already friends" |
| 4 | `f-forum` | Merged, capped at round 5 (Opus 8.4 r5, no MUST). Not done: an unread post in the light shots |
| 4 | `f-call` | Merged, capped at round 5 (Opus 8.5 r5, approved). Not done: "Lia (você)" on the self tile (copy), muted and moderator-muted captures |
| 5 | `m-breakpoints` | Merged (code only, no council) |

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

### Council round T3

Answers: `~/pqp-redesign/t-tokens/council-t3/`.

| Overall | Toggle off | Redesign on |
|---|---|---|
| Claude Opus 5.5 | 7.3 | 8.4 |
| Codex GPT-6 Luna | 7.7 | 9.0 |

Codex: no fixes. Opus MUST: in Everforest dark the selected row nearly
matched the side pane. Fixed, and the bench now measures selected to side
pane. Also: Clássico light soft pair moved from hue 135 (mint) to 126
(lime), the light mention chip stands further off its row (floor 0.05),
and `--radius-pane` (16px) splits a shell pane from a dialog. Not taken:
stating the pane pair in every look block (the `order` check already fails
a look that inverts).

André signed off on `/qa/ui` after round T3 (2026-10-26).

## Phase 2: elements

### p-button

Spec (audit: 185 importers, about 610 `<Button>` uses, plus 598 raw buttons
that the elements they live in will fold as they are rebuilt):

1. Job: the one action control. Variants default, secondary, ghost, danger,
   plus `danger-ghost` (a quiet destructive action, 4 hand-painted sites
   folded). Sizes sm, default, icon, plus `lg` (44px, for touch).
2. Redesign: a pill, more horizontal room, a lifted primary, the row-hover
   fill and secondary text on ghost.
3. Every redesign value is a component token with a fallback in the class,
   so the toggle off is unchanged and a call site's own class still wins.
   (A `redesign:` class would outrank it: a ghost button painted red would
   turn grey.)
4. Icon-only buttons are `p-icon-button`, the next element.
5. Public pages use Button too; tokens keep their own padding and colours.

Council (Opus 5.5, GPT-6 Luna via Codex, Grok 4.7), overall after:

| Round | Opus | Codex | Grok | MUST open |
|---|---|---|---|---|
| 1 | 7.2 | 8.3 | 8.5 | 2 (Opus: secondary and ghost vanish on a dark dialog) |
| 2 | 8.3 | 8.7 | 8.6 | 0 |
| 3 | 8.6 | 8.9 | 8.7 | 0 |
| 4 | 8.7 | 8.8 | 8.9 | 1 (Codex: a misread of the light hover, withdrawn in round 5) |
| 5 | 8.9 | 8.9 | 9.0 | 0 (Grok COULD: non-primary disabled labels near 3:1 in light; disabled controls are exempt) |

Stopped at the five-round cap with no MUST and every category above
"before". Best round: 5. Screenshots: `~/pqp-redesign/p-button/`.

Decisions:
- Fills are tints of the text, never a surface, so a button keeps its edge
  on a pane and on a dialog.
- A disabled primary is an empty pill (strong edge, quiet medium label, full
  opacity); other variants fade to 0.5. Disabled means off, never just
  dimmed.
- `danger-ghost` stays red at rest (two reviewers asked to keep it).
- `redesign:` classes only for disabled-only rules; everything else is a
  component token with the old value as its fallback.

Deferred to the element that owns the call site:
- The dialog's square close button: `p-dialog`, on `IconButton`.
- The avatar "Remover" in profile settings as `danger-ghost`:
  `f-user-settings`.
- `aria-disabled:opacity-60` on two Buttons in `app-launcher.tsx`: `f-apps`.

Verified: typecheck; 10,315 unit tests; `bench:tokens` (3,062 pairs);
`settings-sections` and `settings-keyboard` e2e (14 passed); i18n check;
retro dark and light, Halloween, high contrast light, 390px; toggle off
matches the original sheet and settings screens.
### p-icon-button

Spec (audit: about 180 raw icon-only `<button>`s, six heights, three hover
fills, about a third with no accessible name; four named copies):

1. Job: every icon-only control. One `IconButton` in `ui/`, wrapping
   `Tooltip`, so the label is required and is the accessible name.
2. Sizes xs/sm/md/lg (24/28/32/36px); 44px under 640px unless `touch={false}`.
   Tones ghost and danger; `pressed` for toggles (`aria-pressed`).
3. Redesign: a pill, secondary text, row-hover fill, selected fill when
   pressed. Tokens with fallbacks, so the toggle off is unchanged.
4. Folded now: `PostIconButton` (forum, 3 uses). `HEADER_ACTION_TILE` and
   `CHANNEL_ACTION_TILE` fold in `s-header` and `s-channel-row`, `ChromeButton`
   in `f-stories`; the raw buttons fold with the element that owns them.

Council (Opus 5.5, GPT-6 Luna via Codex; Grok 4.7 through round 4, then
dropped at André's request), overall after:

| Round | Opus | Codex | Grok | MUST open |
|---|---|---|---|---|
| 1 | 7.4 | 8.3 | 7.7 | 0 |
| 2 | 8.3 | 8.7 | 8.4 | 0 |
| 3 | 8.5 | 8.8 | 8.8 | 0 |
| 4 | 8.7 | 9.1 | 9.0 | 0 |
| 5 | 9.0 | 8.9 | not run | 0 |

Stopped at the five-round cap with no MUST and every category above
"before". Best round: 5. Screenshots: `~/pqp-redesign/p-icon-button/`.

Decisions:
- A pill with secondary text at rest and the ghost tint on hover; pressed is
  the selected-row fill with an accent glyph, and keeps it when disabled.
- Disabled is `aria-disabled`, so the control stays focusable and named.
- The focus ring's offset band is transparent under the redesign; the press
  respects reduced motion.
- The primitive owns the glyph size (`--icon-button-glyph-*`).

Deferred:
- `touch` grows the drawn circle on a phone, not only the hit area: `m-*`.
- The forum header's Lucide glyphs: `f-forum`.
### p-tooltip

Spec (audit: 153 files import `Tooltip`, 7 use the rail tone; two
hand-rolled bubbles; 471 native `title=` attributes):

1. Job: name a control on hover and keyboard focus; `rail` names a server.
2. Redesign: four colour roles (`--color-tooltip*`), deepest surface plus a
   strong edge in dark, inverted in light; medium label, title face on the
   rail. Tokens with fallbacks, so the toggle off is unchanged.
3. Merges: the reaction tip (`message-list.tsx`, its own `ink` palette) and
   the locked-look hint (`appearance-section.tsx`) read the same tokens.
   Their placement code stays.
4. Native `title=` stays where it labels truncated text. On icon-only
   buttons it goes as each element folds onto `IconButton`.

Council (Opus 5.5, GPT-6 Luna via Codex; Grok 4.7 through round 4, then
dropped at André's request), overall after:

| Round | Opus | Codex | Grok | MUST open |
|---|---|---|---|---|
| 1 | 7.2 | 8.4 | 7.5 | 0 |
| 2 | 8.1 | 8.9 | 8.4 | 0 |
| 3 | 8.4 | 8.9 | 8.6 | 0 |
| 4 | 8.6 | 9.0 | 8.7 | 0 |
| 5 | 8.9 | 8.8 | not run | 0 |

Stopped at the five-round cap with no MUST and every category above
"before". Best round: 5. Screenshots: `~/pqp-redesign/p-tooltip/`.

Decisions:
- Dark: a bubble below every surface (`surface-0` 55% toward black) with a
  soft edge and a faint top highlight. Light: inverted, a dark bubble.
- Medium label, the detail line at 80% of the label; the rail bubble in the
  title face at semibold, 14px from its tile.
- `mark` on a rail bubble that names a place (servers, pinned and folded
  conversations, the conversations home): a 3px accent bar, mixed toward
  the label in light. Actions stay plain.
- The reaction tip and the locked-look hint read the same tokens.

Deferred:
- Native `title=` on icon-only buttons goes as each element folds onto
  `IconButton`.
### p-input

Spec (audit: 37 files import `Input`, 8 `Textarea`; 87 raw text fields):

1. Job: one-line and multi-line text entry, with the `prefix` box.
2. States: rest, filled, hover, focus ring, invalid, disabled, placeholder.
3. Redesign: `--color-field` (a well in dark, a faint tint in light), the
   strong edge, a full-strength placeholder, invalid red by `aria-invalid`.
   Tokens with fallbacks, so the toggle off is unchanged.
4. Folded: the schedule-session description, a hand-drawn textarea with no
   focus ring, is now `Textarea` (it gains the ring). Selects that copy the
   field recipe fold in `p-select`; search bars fold with their element.

Council (Opus 5.5, GPT-6 Luna via Codex; Grok 4.7 through round 3, then
dropped at André's request), overall after:

| Round | Opus | Codex | Grok |
|---|---|---|---|
| 1 | 7.6 | 8.6 | 7.8 |
| 2 | 7.8 | 8.8 | 8.1 |
| 3 | 8.3 | 8.9 | 8.7 |
| 4 | 8.6 | 8.7 | not run |
| 5 | 8.7 | 8.9 | not run |

Round 2 had a MUST (an empty disabled field read as a resting one), fixed
in round 3. Stopped at the five-round cap with no MUST and every category
above "before". Best round: 5. Screenshots: `~/pqp-redesign/p-input/`.

Decisions:
- One role, `--color-field`: a well below panes in dark, a 3% text tint in
  light, its edge held at 3:1 on the fill, a dialog and the pane.
- A field matches its button in height, not shape: fields are rounded
  rectangles, actions are pills.
- Disabled keeps the edge, drops the fill, and dims the value one step and
  the placeholder and prefix two. A disabled invalid field draws as
  disabled: no tint, no red edge.
- Invalid adds a red tint to the red edge (`--input-invalid-bg`, 10% in
  dark, 6% in light); the docs pair it with visible error text.
- The prefix is `text-secondary`, 2px from the value.

Deferred:
- 16px text on touch screens so iOS does not zoom: the whole field family,
  in the phone pass (`m-*`).
- Aligning the disabled primary Button's edge with the field edge, and a
  stronger light focus ring for fields: revisit with `p-dialog`.

Verified: typecheck; 10,331 unit tests; `bench:tokens`; `settings-sections`,
`server-settings-sections`, `profile-section` and `theme-switching` e2e (39
passed); i18n check.
### p-select

Spec (audit: `SettingsSelect` in 9 places, 19 raw `<select>`s in 4 recipes):

1. Job: a choice from a short list. Stays native for the phone picker and
   for the e2e specs that find options by value.
2. New `ui/Select` on `FIELD_BOX`; sizes md (40px) and sm (36px); layout on
   `wrapperClassName`. Redesign: a Phosphor caret instead of the OS arrow.
3. Folded: `SettingsSelect` (deleted), the five `ink`-palette copies, AutoMod
   (3), Baú follow (2), the share dialog, the birth date, the waitlist. The
   `ink` copies gain the standard focus ring (offset, focus-ring colour).
4. Left: selects on `surface-2` (bots, watch party options and
   transmission) and the channel overview's tall `fieldClass` fold with
   their surfaces, since their toggle-off look differs.

Council (Opus 5.5, GPT-6 Luna via Codex; Grok 4.7 through round 2, then
dropped at André's request), overall after:

| Round | Opus | Codex | Grok |
|---|---|---|---|
| 1 | 7.5 | 8.2 | 7.6 |
| 2 | 8.2 | 8.8 | 8.5 |
| 3 | 8.6 | 8.7 | not run |
| 4 | 8.8 | 8.8 | not run |
| 5 | 8.9 | 8.8 | not run |

Stopped at the five-round cap with no MUST and every category above
"before". Best round: 5. Round 5 took one COULD (a 14px caret on `sm`).
Left for the settings surfaces: no context shot shows a Select in a
settings row yet (Privacidade, Voz e vídeo). Screenshots:
`~/pqp-redesign/p-select/`.

### p-checkbox

Spec (audit: Switch in 18 files, CheckRow in 9, 5 native checkboxes, 4
hand-built switches, 3 hand-built ticks):

1. Job: the independent on/off controls. Switch (a setting), CheckRow (a
   checklist), and a new `Checkbox`, a native input for forms.
2. Fold: the two Baú settings switches (onto Switch, with `busy` and a
   label badge), the new-conversation tick (onto `TickBox`), and five native
   checkboxes (prompt dialog, community address and listing, Baú composer).
3. Left for their surfaces: the poll composer's switch (`f-chat`) and the
   stories composer's tick and switch (`f-stories`, its own media palette).
4. Redesign: a 40 by 24 pill track with a lifted knob, off as a faint tint
   inside the field's 3:1 edge, an 18px tick with a bold check, the ghost
   tint on row hover, and a disabled label that dims with its control.
5. Tokens with fallbacks; the toggle off draws what it drew before.

Council (Opus 5.5, GPT-6 Luna via Codex), overall after:

| Round | Opus | Codex |
|---|---|---|
| 1 | not recorded | 8.4 |
| 2 | 8.4 | 8.5 |
| 3 | 8.6 | 8.5 |
| 4 | 8.2 | 8.6 |
| 5 | 8.0 | 8.1 |

Stopped at the five-round cap. Best round: 3. Round 5's MUST (a saving
switch in a settings row still faded like a disabled one) was fixed after
the council and pinned by a test. Covers Switch, CheckRow and Checkbox.
Screenshots: `~/pqp-redesign/p-checkbox/`.

### p-menu

Spec (audit: Menu in 15 files, ContextMenu in 25, one shared row renderer;
six hand-built `role="menu"` lists):

1. Job: a list of actions or exclusive choices, opened by a click (Menu) or
   a right-click and long-press (ContextMenu, with a quick-reaction strip).
2. Redesign: a visible highlight, concentric rows, quieter icons that come
   up on the highlighted row, sentence-case headings, the Phosphor tick,
   disabled at 0.5.
3. Merges: the recipe is exported (`MENU_SURFACE`, `MENU_ROW`,
   `MENU_ROW_BUTTON`, `MENU_ICON`, `MENU_SEPARATOR`); the composer's "+"
   menu, which drew the same classes by hand, now uses it.
4. Near-folds left for their surface (an `ink-2` panel with
   `shadow-popover`, so folding changes the toggle-off look): the status
   menu (`s-user-panel`), the profile popover's "more" (`f-profile-popover`),
   video quality (`f-call`), the watch player's two (`f-watch-party`), the
   message list's "more" (`s-message`).
5. Round 1 also moved: the menu surface now builds on `POPOVER_SURFACE`;
   `topContent` callers use `MENU_SEPARATOR` and the heading recipe; a
   disabled row fades its icon and label, not its detail. Left for
   `s-message`: the message menu's danger rows sit mid-list, not last.

Council (Opus 5.5, GPT-6 Luna via Codex), overall after. Rounds 4 and 5 ran
one reviewer each:

| Round | Opus | Codex |
|---|---|---|
| 1 | 7.7 | 8.7 |
| 2 | 8.0 | 8.5 |
| 3 | 8.4 | 8.5 |
| 4 | not run | 8.4 |
| 5 | 8.4 | not run |

Round 5 approved the element as it stands. Both reviewers asked to move the
message menu's "Excluir mensagem" to the end; that changes the order with
the toggle off, so it is logged for `s-message`. Open for the icon element:
whether 16px menu icons go filled, as direction B says, or stay outline.
Screenshots: `~/pqp-redesign/p-menu/`.

### p-popover

Spec (audit: no popover primitive; eight anchored panels, each with its own
portal and placement):

1. Job: the panel an anchored popover floats in.
2. Redesign: the pane radius, a faint text edge and a deeper lift, set
   through the level-3 elevation variables.
3. Merges: `POPOVER_SURFACE` for the emoji and GIF pickers (panel and
   loading skeleton), the update note, the soundboard, the forum icon
   picker and the music speaker panel.
4. Left: placement and dismissal stay per caller. One behaviour for all of
   them needs `@radix-ui/react-popover`, a new dependency (logged as a
   question). The profile popover and peer audio (`ink-2` panels) move with
   `f-profile-popover` and `f-call`.
5. Left for the composer surface: with the toggle off a window shorter
   than the emoji picker cuts its category bar (the wrapper div never takes
   the shell's height). The redesign fixes it; the old look keeps the bug.

Council (Opus 5.5, GPT-6 Luna via Codex), overall after. Round 5 ran one
reviewer, at André's request to spend less on agents:

| Round | Opus | Codex |
|---|---|---|
| 1 | 7.5 | 8.1 |
| 2 | 8.2 | 8.6 |
| 3 | 7.9 | 8.5 |
| 4 | 7.8 | 8.3 |
| 5 | 8.4 | not run |

Round 4's MUST (the gap under the emoji category bar had no effect) was
fixed in round 5. Stopped at the five-round cap with no MUST. Best round: 5.
Screenshots: `~/pqp-redesign/p-popover/`.
### p-sheet

Spec (audit: no sheet primitive; Dialog is a sheet below `sm`, plus the app
launcher's phone form, the cinema stage's picker and three story sheets):

1. Job: the look of a panel rising from a phone's bottom edge.
2. Redesign: a 24px top radius, the raised fill, a top hairline only, an
   upward shadow, the dialog's scrim. Tokens `--sheet-*`.
3. Merges: `SHEET_SURFACE` / `SHEET_SURFACE_PHONE` / `SHEET_SCRIM` in
   Dialog, the app launcher and the cinema picker. Redesign only: the three
   drew three different surfaces with the toggle off.
4. Left: the story sheets (their own media styling) move with `f-stories`;
   the cinema picker's desktop card moves with `f-call`. No grab handle:
   nothing drags.

Rounds: r1 Codex 8.4, r2 Opus 8.4, r3 Codex 8.5, r4 Opus 8.5, r5 Opus 8.6.
Capped at round 5, no MUST. Round 5 SHOULDs applied before the merge: the
light sheet keeps one top edge (the border; the 1px shadow layer is gone),
and `SHEET_SAFE_BOTTOM` (`max(0.75rem, env(safe-area-inset-bottom))`) pads
every footerless phone sheet the same. Left as COULD: desktop dialogs share
the 6px scrim blur (watch GPU over a playing share), landscape side safe
areas. The dialog footer two-tone belongs to `p-dialog`. Verified:
typecheck, 10,454 unit tests, bench:tokens, i18n:check, forum-shell and
mobile-immersive-stage e2e. Screenshots: ~/pqp-redesign/p-sheet/.

### p-radio

Spec (audit: RadioGroup in 13 files; 14 more draw their own radios):

1. Job: one of a few, in three shapes (segmented, chips, list) with one
   keyboard model.
2. Redesign: a tinted pill track with a raised thumb, stronger chip edges,
   and a filled accent dot inside the field edge for the list.
3. No hand-built group folds without changing the toggle-off look, so each
   is left for the element that owns it: poll duration chips and Baú
   visibility (`f-chat`, `f-bau`, near chips and segmented), the voice track
   toggle (`f-watch-party`), invite choices (`f-invites`), the two timeout
   grids that should share one control (`f-profile-popover`), the guest
   setting (`f-watch-party`, near list). Swatch, image, icon and card grids
   (appearance, bots, avatar, forum icons, the settings choice grid) are a
   different control and stay.
4. Tokens with fallbacks; the toggle off draws what it drew before.

Council (Opus 5.5, GPT-6 Luna via Codex), overall after. Round 5 ran one
reviewer, at André's request to spend less on agents:

| Round | Opus | Codex |
|---|---|---|
| 1 | 7.7 | 8.7 |
| 2 | 7.8 | 8.8 |
| 3 | 8.0 | 8.5 |
| 4 | 8.3 | 8.2 |
| 5 | not run | 8.0 |

Round 2's MUST (the "Modo" picker drew the old track) and round 4's MUST (a
selected chip read by hue only) were fixed. Stopped at the five-round cap
with no MUST. Screenshots: `~/pqp-redesign/p-radio/`.

### p-tabs

Spec (audit: six hand-built tab rows, two of them copies of each other):

1. Job: switch one panel, in four shapes (underline, segmented, pill,
   filled) with one keyboard model: roving tab stop, arrows, Home, End.
2. Redesign: secondary text for unselected tabs, round tinted pills,
   RadioGroup's track and thumb for `segmented`, a tinted filter chip.
3. Folded: bot overview, roles, profile popover, friends, call split, and
   both report queues (now one `ReportStatusTabs`). Each keeps its toggle-off
   look; only the bot tabs keep a focus ring with the toggle off.
4. Left out: the live preview (a public page), the phone tab bar (`m-*`)
   and `SectionRail` (settings navigation, its own element).

Council (Opus 5.5, GPT-6 Luna via Codex), overall after. Rounds 2 and 5 ran
one reviewer each:

| Round | Opus | Codex |
|---|---|---|
| 1 | 7.6 | 8.2 |
| 2 | not run | 8.6 |
| 3 | 7.8 | 8.4 |
| 4 | 8.2 | 8.7 |
| 5 | 8.4 | not run |

Round 5's SHOULD (a disabled tab still took hover) is fixed: a disabled tab
takes no pointer under the redesign. One reviewer split was settled here:
the tabs keep their own track rather than RadioGroup's `SEGMENTED_*` strings,
because those would change the toggle-off look. Stopped at the five-round
cap with no MUST. Screenshots: `~/pqp-redesign/p-tabs/`.

### p-slider

Spec (audit: Slider in 13 files; 11 native range inputs elsewhere):

1. Job: one value on a line, in four shapes: scrub (progress that seeks),
   volume, edge (a compact player's fill on a border) and hue.
2. Redesign: a text-tint track that shows on any surface, a scrub track
   that thickens on hover and focus, a lifted knob (white with a hairline in
   light), disabled at 0.5.
3. No native range folds without changing its toggle-off look (the OS
   slider tinted by `accent-color`), so each is logged for its surface:
   the watch player, its PiP and the transmission gains (`f-watch-party`),
   the story size sliders (`f-stories`), peer volume (`f-call`), the role
   hue (server settings).
4. Tokens with fallbacks; the toggle off draws what it drew before.
5. Not taken in round 2: naming the group (`group/slider`). It would stop a
   hoverable parent row from showing the knob with the toggle off too, so it
   is a behaviour change; `f-music` decides it for the now-playing row.
6. Left for `f-call` (voice settings): above 100% the accent fill covers the
   middle of the unity tick. Raising the tick would paint it over the knob
   at 100%, so it needs its own treatment there.

Council (Opus 5.5, GPT-6 Luna via Codex), overall after. Rounds 4 and 5 ran
one reviewer each:

| Round | Opus | Codex |
|---|---|---|
| 1 | 7.6 | 8.5 |
| 2 | 8.4 | 9.0 |
| 3 | 8.3 | 8.6 |
| 4 | 8.0 | not run |
| 5 | not run | 8.8 |

Round 4's MUST (the voice settings' 100% label collided with the hint under
it) was fixed; round 5 found nothing left. The slider group naming and the
unity tick are logged for `f-music` and `f-call`. Stopped at the five-round
cap with no MUST. Screenshots: `~/pqp-redesign/p-slider/`.
### p-banner

Spec (audit: six hand-built strips in `App.tsx`, `connection-banner.tsx` and
`sanction-notice-bar.tsx`, each its own tinted bar):

1. Job: state something about the app or the conversation until it stops
   being true, with at most two actions.
2. Redesign: an inset rounded card on the look's soft tone fill, the message
   in the text colour, a leading icon and pill actions in the tone's ink.
3. Folded: dev bypass, connection, app error, idle warning, success notice,
   sanction. Each keeps its toggle-off bar.
4. Left for their owners: watch now (`s-banners`), arrival, bring-crew and
   newcomer strips (`f-onboarding`), the Discord import note
   (`f-server-settings`). pt-BR idle copy moved to "tu".

Council (Opus 5.5, GPT-6 Luna via Codex), overall after. One reviewer per
round, Opus for the sign-off:

| Round | Opus | Codex |
|---|---|---|
| 1 | not run | 8.2 |
| 2 | not run | 8.5 |
| 3 | 8.3 | not run |

Round 1's phone check led to `BannerText` (two actions wrap under the
message). Round 3 approved; its notes were applied after it: the share
button and "Ainda tô aqui" draw as the main way out under the redesign, the
icon and actions align to the first line, and the filled pill's focus ring
has an offset. Logged, not done: the dark warning fill reads heavy beside
success and danger; revisit if it does in use. Screenshots:
`~/pqp-redesign/p-banner/`.

### p-badge

Spec (audit: 7 `Badge` callers, six hand-built count pills with one shared
class string, six hand-built name tags in message headers):

1. Job: name a state (Badge), a tag beside a name (Badge `tag`), or a
   waiting count (new `CountBadge`).
2. Redesign: sentence-case pills, 11px semibold, the variant's pair always;
   counts in 11px semibold tabular figures. The beta tag beside BOT matches.
3. Folded: six count pills (DM list, conversations home twice, quick
   switcher, phone tabs, phone conversations) and the OP, gone, AutoMod,
   Webhook, BOT and removed tags. New `muted` variant for gone and removed.
4. Left for their owners: the server rail counts (`s-rail`), the
   channel list's counts and live chips (`s-channel-row`), Baú media
   overlays (`f-bau`), the voice-clean chip (`f-call`).

Council (Opus 5.5, GPT-6 Luna via Codex), overall after. One reviewer per
round, Opus for the sign-off:

| Round | Opus | Codex |
|---|---|---|
| 1 | not run | 8.3 |
| 2 | 8.3 | not run |

Round 2 approved; its notes were applied after it. The bench now measures
the neutral and muted badges, and under the redesign they are a step
stronger (body text on `surface-3`; secondary text on `surface-2`) because
Catppuccin, Everforest, Ocean and Modo 2005 fell under 4.5:1. The 16px
count takes 10px type; the beta tag beside Bot drops its wash; the sheet
shows a painted Webhook tag and a "Saiu" tag. Screenshots:
`~/pqp-redesign/p-badge/`.

### p-toast

Spec (audit: no toast primitive; seven toasts, each with its own corner and
queue; five drew the level-3 card, two drew their own):

1. Job: the look of a note that arrives and leaves on its own.
2. Redesign: the popover's card (radius, fill, edge, lift) and IconButton's
   round ghost for the dismiss button.
3. Merges: `TOAST_SURFACE` in the DM, friend, forward, not-in-server and
   app-join toasts (exact with the toggle off); `TOAST_SURFACE_REDESIGN` in
   the session reminders and the watch party approval (redesign only, they
   drew another card); `TOAST_CLOSE` in four close buttons.
4. Left: the retro toasts (their own look), the image lightbox's notice
   (a media overlay, `s-message-content`) and the voice-clean confirmation
   in `App.tsx` (`f-call`). Placement and queues stay per toast.

Council (Opus 5.5, GPT-6 Luna via Codex), overall after. One reviewer per
round, Opus for the sign-off:

| Round | Opus | Codex |
|---|---|---|
| 1 | not run | 8.3 |
| 2 | not run | 8.7 |
| 3 | 8.1 | not run |
| 4 | 8.4 | not run |
| 5 | 8.5 | not run |

Capped at round 5, no MUST open. Round 3's MUST (two dismiss buttons with
no focus ring) was fixed in round 4. Round 5's notes were applied after it:
every 32px leading mark in the 40px slot, the DM fallback disc on
`surface-3`, one body tone, the app join's undo ring. Not done: a toast
over a busy screen, because the capture rig renders the sheet only.
Verified: typecheck; 10,417 unit tests; `bench:tokens`; i18n check;
`dm-toast`, `dm-toast-suppression`, `retro-look` and `watch-party` e2e (37
passed); retro, Halloween, high contrast, 390px and toggle off. Screenshots:
`~/pqp-redesign/p-toast/`.

### p-scroll

Spec (audit: `ScrollArea` had no callers; every list scrolls natively, a
few sideways strips hide their bar):

1. Decision: delete `ScrollArea` and its Radix dependency. Adopting it
   would change how every pane scrolls (an overlay bar, Radix's own
   viewport), which is behaviour, not look.
2. Redesign: native scrollbars take the look's colours (a thumb of tertiary
   text at 65%, 80% in light, at least 3:1 on both panes; no track) at the platform's width, from one rule on the root.
3. Not verifiable here: the captures run on macOS, whose overlay bars are
   hidden at rest; the sheet draws the thumb's colour as a bar instead.
   Headless Chromium ignores "Show scroll bars: Always" too (tried
   2026-10-27). For André, about a minute each:
   - macOS: System Settings, Appearance, Show scroll bars "Always"; open
     the Electron app with the toggle on; check the thumb at rest, on hover
     and while dragging.
   - Windows: the same, plus the arrow buttons, which Chromium draws in the
     thumb colour once `scrollbar-color` is set. Do they look like legacy
     chrome next to the rounded panes?
   - Linux (GTK): rest, hover, drag.
   Values to confirm: `scrollbar-width: auto`, thumb at 65% (dark) and 80%
   (light) of tertiary text.
### p-avatar

Spec (audit: every person avatar already renders through `UserAvatar`, 65
sites; 30 different monogram palettes passed as `fallbackClassName`):

1. Job: a person's picture or monogram, a bot's face, presence on a corner.
2. Redesign: direction B's round avatars everywhere, the monogram on one
   neutral disc. Callers keep their sizes; the toggle off keeps their
   shapes and colours.
3. Kept: Modo 2005's monogram (plain CSS, it wins), story media avatars
   (`ownPalette`), bot faces.
4. Left for their owners: the server rail tiles and `ServerIcon` (`s-rail`),
   `ChannelIcon` (`s-channel-row`), the call banner's faces (`f-call`), the
   story ring (`f-stories`).

Council (Opus 5.5, GPT-6 Luna via Codex), overall after. One reviewer per
round, Opus for the sign-off:

| Round | Opus | Codex |
|---|---|---|
| 1 | not run | 8.1 |
| 2 | not run | 8.7 |
| 3 | 8.4 | not run |
| 4 | 8.5 | not run |
| 5 | 8.6 | not run |

Capped at round 5, no MUST open. Round 5's notes were applied after it: the
avatar notes moved under UserAvatar, and the sheet's stack cuts its overlap
with `--avatar-dot-ring`. Not done (logged): a 40px monogram's letter at
15px under the redesign, which needs each 40px caller to opt in.
Verified: typecheck; 10,420 unit tests; `bench:tokens`; i18n check;
`channel-presence`, `member-sidebar`, `profile-popover-avatar`,
`retro-look`, `conversations-home` and `dm-list-polish` e2e (26 passed);
retro, Halloween, high contrast, 390px and toggle off. Screenshots:
`~/pqp-redesign/p-avatar/`.

### p-list-row

Spec (audit: about twelve row kinds, each hand-built with palette aliases;
the row roles in `index.css` were defined and drawn only on `/qa/ui`):

1. Job: one row with a leading mark, a label, a second line and a trailing
   slot; states hover, selected, unread, muted, disabled.
2. Redesign: Salas pills on the row roles, a step taller, more room inside.
3. Built as the primitive with its sheet block. Nothing adopts it here: each
   row keeps its toggle-off look only if it moves together with its shell
   element (`s-channel-row`, `s-voice-row`, `s-member-list`, `f-dm-home`,
   `f-friends`), so the folds happen there.

Council (Opus 5.5, GPT-6 Luna via Codex), overall after. One reviewer per
round, Opus for the sign-off:

| Round | Opus | Codex |
|---|---|---|
| 1 | not run | 8.0 |
| 2 | not run | 8.4 |
| 3 | 8.5 | not run |
| 4 | 8.4 | not run |
| 5 | 8.6 | not run |

Capped at round 5, no MUST open. Round 5's notes were applied after it: a
time stacks over a count on a two-line row, the selected row's action takes
the label's colour, the pip is 8px. Decided: the end pip (or a count) is the
one unread mark; the sidebar's left-edge bar goes when `s-channel-row`
adopts ListRow. Verified: typecheck; 10,430 unit tests; `bench:tokens`;
i18n check; no call site adopts it yet, so no e2e changes; retro,
Halloween, high contrast, 390px and toggle off. Screenshots:
`~/pqp-redesign/p-list-row/`.

### p-card

Spec (audit: 15 in-app copies of one card class in seven files, plus
bespoke cards in Baú, polls, voice notes, the forward and the corner card):

1. Job: a bounded group that sits in a pane or a dialog.
2. Redesign: fill and edge as tints of the text, so the same card reads on
   any surface.
3. Folded: the 15 copies (bot wizard and overview, bots settings, connection
   check, profile popover, conversations empty and phone screens).
4. Left for their owners: Baú posts (`f-bau`), polls and voice notes
   (`s-message-content`), the forward card (`s-message-content`), the corner card
   (`f-onboarding`), the public `/apps` page (out of scope).
5. Two eyebrow labels inside cards (bot overview, conversations empty) draw
   different specs. Unifying them changes the toggle-off look, so they fold
   onto `SectionLabel` with `p-section-header`.

Council (Opus 5.5, GPT-6 Luna via Codex), overall after. One reviewer per
round, Opus for the sign-off:

| Round | Opus | Codex |
|---|---|---|
| 1 | not run | 8.4 |
| 2 | 8.4 | not run |
| 3 | 8.3 | not run |
| 4 | 8.3 | not run |
| 5 | 8.5 | not run |

Capped at round 5, no MUST open. Round 5's notes were applied after it: the
connection check's detail line is secondary text, the bot wizard's tool tile
takes the card's row tint, the light card tokens have their own comment, and
DESIGN.md says a static row takes no hover. Verified: typecheck; 10,434 unit
tests; `bench:tokens`; i18n check; `conversations-home`,
`profile-popover-menu`, `dialog-mobile-layout` and `settings-sections` e2e
(41 passed); retro, Halloween, high contrast, 390px and toggle off.
Screenshots: `~/pqp-redesign/p-card/`.

### p-section-header

Spec (audit: two pane titles drawn twice, about 170 uppercase tracked labels
in 50 files, in four sizes, three trackings and two colours):

1. Job: the title of a pane, and the small label over a group.
2. Redesign: Gabarito pane titles at 20px; labels in sentence case, 13px
   semibold, secondary text, no tracking.
3. Folded: settings and server settings pane titles, server settings group
   titles, forward picker, profile popover, shortcuts, invites, roles,
   server identity, video quality menu.
4. Left for their owners: channel categories (`s-category`), member list
   sections (`s-member-list`), DM sections (`f-dm-home`), Baú
   (`f-bau`), watch party (`f-watch-party`), voice menus (`f-call`). Labels
   over a single input are field labels, not this element: logged for
   `p-settings-kit`.
5. Council round 3 (Opus): the roles field label ("Nome do cargo") is still
   11px caps beside sentence-case labels, and the settings rail headings are
   12px. Queued for `p-settings-kit` (field labels) and the settings rail.

Council (Opus 5.5, GPT-6 Luna via Codex), overall after. One reviewer per
round, Opus for the sign-off:

| Round | Opus | Codex |
|---|---|---|
| 1 | not run | 8.0 |
| 2 | not run | 8.4 |
| 3 | 7.8 | not run |
| 4 | 7.5 | not run |
| 5 | 8.0 | not run |

Capped at round 5, no MUST open. Round 3's two MUST and round 4's MUST (the
unlayered `.font-display` rule beating the sans face) were fixed, and a
browser test reads the computed face. Round 5's notes were applied after it:
the variant notes sit under PaneHeader and SectionLabel, and a test pins the
danger colour on a group title. Not done (logged): a `--section-group-gap`
token, because each caller sets its own gap today and both would add up.
Queued: the dialog title against the pane title in both settings dialogs
(`p-dialog`), and the roles field label in caps (`p-settings-kit`).
Verified: typecheck; 10,440 unit tests; `bench:tokens`; i18n check;
`section-label-face`, `server-settings-sections`, `settings-sections`,
`settings-keyboard`, `profile-popover-menu` and `profile-popover-friends`
e2e (26 passed); retro, Halloween, high contrast, 390px and toggle off.
Screenshots: `~/pqp-redesign/p-section-header/`.

### p-loading

Spec (audit: 44 `animate-spin` sites, about 30 of them the Lucide
`Loader2`, a few hand-built bordered rings; `Skeleton` in 16 files plus
local placeholders):

1. Job: show that something is on its way, or hold the shape of content.
2. Redesign: a ring spinner with a faint track; skeletons as a faint text
   tint, pill rows and round avatars; both still under reduced motion.
3. Folded: the spinners in the settings kit and settings tabs,
   connections, the profile popover, forward picker, depoimentos, search,
   user search, GIF picker, message list and forum. Every `Skeleton` user
   gets the new fill.
4. Left for their owners: call, stories, apps, watch party and voice note
   spinners (their surfaces), the splash ring (`f-states`), the server
   rail skeleton (`s-rail`).

Council (Opus 5.5, GPT-6 Luna via Codex), overall after. One reviewer per
round, Opus for the sign-off:

| Round | Opus | Codex |
|---|---|---|
| 1 | not run | 8.5 |
| 2 | 8.4 | not run |
| 3 | 8.4 | not run |
| 4 | not run | 8.6 |
| 5 | 8.6 | not run |

Capped at round 5, no MUST open. Round 5's notes were applied after it: the
channel header's placeholder is a Skeleton, the update button's busy state
uses the Spinner, the sheet drops the 12px sample. Left for their owners
(placeholders and spinners outside this element's scope):
`community-home-feed.tsx` (`f-bau`), `pages/locadora-guest-page.tsx` and
`pages/home/mudanca.tsx` (public pages, out of scope), `pages/claim-page.tsx`
(signed-out), the channel skeleton's row spacing (`s-channel-row`).
Verified: typecheck; 10,444 unit tests; `bench:tokens`; i18n check;
`conversations-home`, `send-jumps-to-bottom`, `dialog-mobile-layout`,
`profile-popover-menu`, `retro-look` and `message-permalink-scroll` e2e (39
passed); retro, Halloween, high contrast, 390px and toggle off.
Screenshots: `~/pqp-redesign/p-loading/`.

### p-empty

Spec (audit: four local empty components and about 30 hand-built empty
blocks, each with its own sizes, colours and spacing):

1. Job: say what is not here yet and the next step; `page` and `inline`.
2. Redesign: the glyph on a soft disc, a Gabarito title, a secondary body
   line, the actions under it; inline is quiet.
3. Folded: the empty channel (both versions), the forum's empty and failed
   blocks (six uses), search's empty and prompt states, the settings kit's
   `SettingsEmpty` (every settings tab).
4. Left for their owners: watch party, communities, stories, call stage,
   apps, conversations home, friends (their surfaces' elements); the error
   boundary (`f-states`, André's question 3).

5. Council: one reviewer per round, Opus for the sign-off.

| Round | Opus | Codex |
|---|---|---|
| 1 | not run | 8.2 |
| 2 | not run | 8.4 |
| 3 | 8.5 | not run |
| 4 | not run | 8.4 |
| 5 | 8.6 | not run |

Capped at round 5, no MUST open. Round 5's notes applied after it: search's
empty state leads with a magnifier under the redesign, and the light theme's
neutral disc is a tint of the text so it holds its shape. Logged: the two
secondary buttons differ in dark because the forum pane remaps the
secondary fill (`f-forum`); `SettingsEmpty` takes a filled Phosphor glyph in
`p-settings-kit`. Verified: typecheck; 10,418 unit tests (the HLS rebuild
suite timed out under load once and passed alone); `bench:tokens`; i18n
check; `forum-pane` and `forum-shell` e2e (6 passed); retro, Halloween, high
contrast, 390px and toggle off. Screenshots: `~/pqp-redesign/p-empty/`.
### s-frame

Spec (audit: the root, the rail, five side panes and Novidades each drew
their own edge and fill; the phone breakpoint is defined three ways):

1. Job: the canvas, the panes, their corners and the gutter between them.
2. Redesign: the rail sits on the canvas with no edge; from 768px the
   sidebar, conversation, member list, docked thread, forum side post and
   Novidades float as `--radius-pane` panes with the `--space-gutter`
   gutter; the conversation is the brightest pane.
3. Built as class strings in `ui/pane.ts`, appended after each pane's own.
4. Left: below 768px the drawers keep their edges (`m-shell`, `m-breakpoints`).

### s-rail

Spec (audit: one rail in `server-rail.tsx`, six tile kinds each drawing its
own lime-on-hover square, a hand-made count pill, legacy tokens throughout):

1. Job: the doors on the left edge: Conversas, waiting and pinned people,
   servers, create and join, Novidades, Discover, the update button.
2. States: selected, unread pip, mention and request counts, muted, Baú
   count or ring, live party, public community, dragged, keyboard focus.
3. Redesign: 44px round tiles in the side pane's colour; the selected one is
   the accent's rounded square; a hover lifts the fill and never turns lime;
   filled Phosphor glyphs; counts on `CountBadge`; marks cut from the canvas.
4. Left: `PhoneServersScreen` (`m-shell`) and `ServerRailSkeleton`
   (`p-loading`, which is in review).
Rounds: r1 Codex 8.0, r2 Codex 8.5, r3 Opus 8.3 (MUST: a call added a
second gutter; fixed), r4 Opus 8.6, r5 Opus 8.8. Capped at round 5, no MUST.
Applied before the merge: `--space-gutter` is 0 under 768px, the same width
where the frame classes stop floating. Left as COULD:
- Light `pane-side` is close to `pane-main`; only the gutter parts them.
  Try `color-mix(in oklab, var(--color-surface-1) 98%, var(--color-text))`
  if a later element removes the sidebar divider (re-run the bench).
- For `s-user-panel`: the mockup draws the user panel as its own inset
  rounded card, not a full-width divider.
- For `s-thread`: shoot the docked thread pane.
Verified: typecheck, 10,454 unit tests, bench:tokens, i18n:check, e2e
app-shell-scroll, forum-shell, channel-layout, call-split-layout,
forum-pane. Screenshots: ~/pqp-redesign/s-frame/.

Rounds 3 to 5 (Opus; Codex out of usage): 8.8, 8.0, 8.2. Fixed on the way:
the join door on the same disc, idle doors lifted 4% in dark, a quieter grey
globe, one focus ring on the update tile, the lime rule written down (a lime
fill is "you are here", small lime marks are "new for you"). Capped at round
5, no MUST open. Open: the sheet's face fixtures load from dicebear, so a
capture can miss them.
Verified: typecheck, 10,462 unit tests, bench:tokens, i18n:check, e2e
conversations-home, dm-list-polish, live-read-ack (17). Screenshots:
~/pqp-redesign/s-rail/.

### p-dialog

Spec (audit: Dialog in 50 files, ConfirmDialog in 24, PromptDialog in 1;
14 `role="dialog"` overlays outside it, 4 sheets, 3 native prompts):

1. Job: a modal panel over the app: a title, a body, an optional footer of
   actions; a full-screen page on a phone when asked.
2. Redesign: a deeper scrim, a text edge and the deepest lift, no header
   rule, a softer footer rule, a 24px inset, a 22px title, a sentence-case
   eyebrow, the close button as IconButton's ghost.
3. Merges: nothing folds without changing the toggle-off look. The close
   button keeps its element (IconButton's `lg` has a 20px glyph and another
   hover) and borrows IconButton's tokens under the redesign.
4. Left for their surfaces: the 14 overlays outside Dialog, the sheets
   (`p-sheet`), and the native `window.prompt` and `confirm` (nickname,
   kick), which belong to `f-profile-popover` and `f-server-settings`.
5. Round 1: the close button takes IconButton's focus ring and an 18px
   glyph, the header 20px at the top, a body-less dialog drops its footer
   rule. Left for `f-server-settings`: its rail divider starts in mid-air
   now that the header rule is gone.

6. Rounds 2 to 5: Codex 8.7 at round 2; the round 3 MUST is fixed; Opus
   8.2 at round 4 and 8.1 at round 5. Fixed on the way: light dialogs sit
   on the brightest surface (`--dialog-surface`), and the close glyph lines
   up with the title's right edge. Capped at round 5, no MUST open.
Verified: typecheck, 10,462 unit tests, bench:tokens, i18n:check, e2e
dialog-mobile-layout (16). Screenshots: ~/pqp-redesign/p-dialog/.

### s-sidebar-header

Spec (audit: one header in `channel-list.tsx`, three hand-built icon
buttons, a search entry styled as a faint field, the banner strip in
`server-identity.tsx`):

1. Job: the open server's name and menu, members, collapse, close (phone),
   message search, and the banner when the server has one.
2. States: hover and open menu, a long name (tooltip), public, loading, no
   server, with and without a banner, phone drawer.
3. Redesign: the name in the title face over no rule, without the icon
   the rail tile already shows beside it; the three buttons are
   IconButton; search is a pill a step off the pane; the banner is an inset
   card. The search dialog itself is `f-search`.

### s-sidebar-special

Spec (audit: `story-strip.tsx`, `live-party-block.tsx` and
`community-home-preview.tsx`, each with its own card, dashed invite and
label; the pinned section is a category header and channel rows, so it
moves with `s-category` and `s-channel-row`):

1. Job: what is happening on this server before its channels: stories, a
   live or pending watch party, the Baú's newest posts.
2. States: party live (open, not open, audience), pending, waitlist teaser
   (open, on the list), create, history links; Baú card (new posts), row
   (nothing new, open), empty for staff and for members; stories with and
   without new, first run, notice.
3. Redesign: one family from `ui/sidebar-block.ts` (card, dashed invite,
   row). The open block is `row-selected`; red stays on the live badge;
   labels are `SectionLabel`, counts `CountBadge`.
Rounds (Opus / Codex): r1 - / 8.3, r2 - / 8.6, r3 8.7 / -, r4 7.8 / -,
r5 8.3 / - (no MUST, would approve). Last fixes: the trigger's hover is the
ghost step (8%) above the search's 6%, open 10%, both tokens
(`--sidebar-trigger-*`); the banner on the header's 12px inset. Kept: the
members button on desktop (round 5 suggested hiding it at every width; the
server menu has Membros too; question 4).

### m-breakpoints

Spec (audit: width queries in the signed-in app: `PHONE_QUERY`, `SM_UP_QUERY`,
`use-sm-up`, `use-md-up`, `use-lg-up`, the forum's 767px, stories' 640px,
the soundboard sheet, the voice note card, the thread panel, two device
probes, and the stylesheets' 639, 640 and 767px):

1. Job: one definition of where the layout changes.
2. Change: `lib/breakpoints.ts` names Tailwind's `sm`, `md` and `lg` in rem,
   with "below" queries at `.999`; every caller imports it; each stylesheet
   query writes the same rem value and names the file.
3. Merges: the forum's 767px and stories' 640px become `md` and `sm`.
4. Same at a 16px base font, except one pixel: stories' `max-width: 640px`
   overlapped `sm` at exactly 640px and now stops at 639.99px. With another
   base font size, JS and CSS now switch with the `sm:` and `md:` utilities.
5. No council: it draws nothing new. Verified by unit tests (a new
   breakpoints test), forum, stories, shell and phone e2e.
6. Found on the way: `app-shell-scroll` failed on `redesign` (not on main):
   `/vem` renders after network idle once the dev server loads the icon
   package. The test now waits for the page to render.

### p-settings-kit

Spec (audit: 28 files in `settings/kit/`, about 30 callers in user settings;
server settings do not use it, so its roles field label in caps moves to
`f-server-settings`; no select of its own, the choice grid is the radio card):

1. Job: the blocks every user settings tab is built from: group, row, switch,
   slider, link, action row, choice grid, preview, notice, badge, keys,
   empty, result, loading rows, copy, inline status, unsaved bar.
2. States: hover, focus, disabled, busy, chosen, every notice tone, saving,
   saved, error, unsaved, refused close.
3. Redesign: group boxes and choice cards on the card tokens, the badge is
   `ui/Badge`, notices take the banner's shape with a tinted info tone,
   Phosphor icons through a shared `IconSwap`. Empty and result take the
   `p-empty` shape once that merges.
Rounds: Codex 8.2 (r1); Opus 8.5 (r2), 8.0 (r3), 8.5 (r5), no MUST left.
Round 5 fixes: the copy failure glyph at 14px, the info tint at 7% in
dark, the rail build line in mono. Merged on the cap.

### f-communities

Spec (audit: `communities-view.tsx`, a full-screen overlay from the rail's
Comunidades door; `community-card.tsx` with its skeleton; states: loading,
error, empty per filter, results, load more):

1. Job: browse and join public communities by search, category and language,
   and start one.
2. Redesign: the page on the conversation's tone (`--communities-bg`), cards
   one solid step above (`--community-card-bg`) with card corners and a
   round icon; category chips are the shared pill choices; the language
   filter is the segmented control; search on the input tokens; Gabarito
   titles; filled Compass and Sparkle; a round close.
3. Merges: nothing. The emoji in empty states and chips stay (character).
4. Kept: the hover lift and glow, share and report on every card, the
   create call to action above the grid.

Rounds (Opus only): r1 7.4 (MUST fixed), r2 7.8 (MUST fixed), r3 8.1, r4
8.0 (MUST fixed: the language filter hid every community while the page
said none existed), r5 7.6 (no MUST, cap; best r3). After r5: the
language-only empty result names the language, the language control has a
visible label, a louder cricket, no lift on card hover. Not done: a balanced
chip wrap (11 chips leave "Geral" alone at 1440px).

### m-sheets

Spec (audit: the four phone sheets in the inventory. The app launcher, the
soundboard, every `Dialog` below `sm` and the settings strip already draw
the merged sheet, popover or list row tokens; the music queue is the one
left: `voice/music-fila.tsx` as the composer's sheet and as the drawer,
`music-queue-list.tsx`, the history in `music-extras.tsx` and the field in
`music-search-picker.tsx`):

1. Job: see what plays next, add a song, reorder, play one again.
2. Redesign: one recipe in `voice/music-classes.ts` for both homes: rows at
   the control radius on the menu's translucent hover, covers nested inside, the
   highlighted result on the menu's highlight, round ghost icons, sentence
   case headings, card-edge seams; the drawer on the side pane with the
   sheet's scrim and a sideways shadow; Phosphor glyphs.
3. Merges: the drawer's paper tokens and the sheet's surface tokens meet in
   one look under the redesign.
4. Kept: drag and Alt+arrow reordering, the row menu, history, shuffle,
   watch on stage, the field's hint, outside-press close.
5. Left: the player bar under the queue is call chrome (`f-call`).
Rounds (Opus only): r1 7.0 (MUST fixed: the row hover vanished on the
composer's well), r2 8.2 (MUST fixed: history rows had no cover), r3 8.6,
r4 8.1, r5 9.0 (approved, no MUST). Also: one right icon column, Subir and
Descer in a row's menu under the redesign (touch has no drag), still
history rows, a sideways drawer shadow. New copy: `music.moveUp`,
`music.moveDown`.

### f-search

Spec (audit: `search/search-dialog.tsx`, one caller, the sidebar search pill
and Ctrl K; states: prompt, too short, searching, no match, error, results,
load more):

1. Job: find a message in this server by words and jump to it.
2. Redesign: the field is the input's round field inset in the body with a
   Phosphor glass; a result is a card-cornered row, the highlighted one on
   the menu's highlight; channel name semibold with a bold `#`; author and
   snippet in secondary text; the match a soft accent tint.
3. Merges: nothing. The other search fields (about nine) belong to their
   surfaces.
4. Kept: combobox and listbox semantics, arrows and Enter, load more.
Rounds (Opus only): r1 7.5 (MUST fixed: four left edges), r2 8.3, r3 8.4,
r4 8.1 (MUST fixed: the channel name sat 3px above the author). Decisions:
the always-focused field draws a 1px accent border, not the primitive's
2px ring with an offset, because a ring around a field that never loses
focus is heavy. The row's `#` is the bold (symbol) glyph, the same weight
as the field's glass. Hover selects a row only on a real pointer move.

### f-invites

Spec (audit: `invite-panel.tsx` in create and join modes, `invite-choice-row`,
`invite-paste`, `create-server-dialog.tsx` with name, paste, preview and done
steps, `discord-import-preview`, `server-ready-panel`, `bring-crew-announcement`):

1. Job: make and share invite links, join with a code, start a server from a
   name or a copied Discord layout.
2. Redesign: invite rows are the shared card with filled share, link, copy
   and bin glyphs; expiry and limit chips are pills (selected row fill with
   an accent edge); field and group labels sentence case; the Discord path is
   a card row with a caret; text areas take the input tokens.
3. Merges: nothing. The chip row stays (it wraps on a 360px panel, a
   segmented control would not).
4. Kept: every step, the system share sheet, the paste helpers.

### f-user-settings

Spec (audit: `settings-modal.tsx`, `SectionRail` shared with server and
channel settings, 13 sections, the kit, `UnsavedChangesBar`, the handle
confirm, the delete account dialog, the phone tab strip):

1. Job: one place for the account and the app: a rail of tabs in groups, a
   page per tab, profile drafts with an unsaved bar, instant save elsewhere.
2. Redesign: a small frame. The band and the rail on the side pane's tone,
   the page an inset rounded pane (`--settings-*`). Tabs are the list row's
   small pill with filled Phosphor glyphs; group names are section labels;
   the account card in the rail foot is a pill.
3. Merges: nothing. `SectionRail` and the `fill` dialog surface are shared,
   so server and channel settings take the rail and the frame tone too;
   their pages stay for `f-server-settings`.
4. Kept: every section, the close guard, the handle confirm, the 44px phone
   targets, the dirty dot and its spoken description.

### f-connections

Spec (audit: `connections-section.tsx` in user settings (built on the kit),
`connection-badges.tsx` on the profile card, `connection-callback.tsx` the
overlay while a provider redirect completes):

1. Job: link Steam, Battle.net and Twitch, choose who sees them, show them
   on a profile.
2. Redesign: the section is the kit's (already reviewed); the badges list on
   the profile is a card with semibold names, provider in the detail colour
   and a bold arrow; the linked name is sans medium; the callback is a pill
   on the popover surface over the sheet scrim.
3. Merges: nothing.
4. Kept: per-provider visibility, the unavailable list, the callback overlay.
Rounds (Opus only): r1 8.0, r2 8.2, r3 8.4, r4 8.4, r5 8.3 (cap, no
MUST in any round). Changes: Desconectar on the plain `danger-ghost` at the
action edge, a spinner and `role="status"` on the callback pill, an edge on
the near-black tiles in dark, coming-soon tiles muted (grey and faded in
light), the linked name at medium weight, a mocked linked-state shot
(`38-*`). Open: question 6 (copy, shows with the toggle off).

### f-server-settings

Spec (audit: `server-settings-dialog.tsx` with 13 sections and its own
`Block` and `SectionHeader`, `channel-settings-dialog.tsx` with 5, roles and
the rank list, emoji, AutoMod, webhooks in and out, the audit log, danger):

1. Job: run a server or a channel: a rail of sections, a page each, a Fechar
   footer; owner-only sections and the armed transfer and delete.
2. Redesign: the user settings frame (side tone, inset page, pill tabs with
   filled glyphs). Bespoke boxes take the card look (`SETTINGS_CARD_REDESIGN`),
   uppercase eyebrows become section labels, field labels sentence case,
   roles are list row pills with a Phosphor grip, the danger block is a card
   with the danger banner's edge, status pills take the badge recipe.
3. Merges: nothing; `Block` stays (the kit's group has rows, these do not).
4. Kept: every section, drag to reorder, the armed confirms, the footer.
Rounds (Opus only): r2 7.6, r3 7.4, r4 7.9, r5 7.8 (cap). Merged on the cap.

### s-category

Spec (audit: `ChannelSectionHeader` in `channel-section-header.tsx` used by the
classic sections, Pinados and `CategoryHeader`; `MixedCategoryHeader` in
`channel-list-mixed.tsx`; the "Categorias" label in `channel-list.tsx`):

1. Job: fold a group of channels; for a manager, add a channel, a private
   channel or a category, rename, delete and drag a category.
2. States: open, folded (count and unread dot), hover, focus, drop target,
   drop into (mixed), dragging, the "+" menu open, a phone (always shows "+").
3. Redesign: one recipe for all three (section label face in sentence case,
   pill row, bold caret, round actions). The three keep their own markup
   because their drag rules differ; only the look is shared.

### s-channel-row

Spec (audit: `ChannelRow` for text, forum and watch party rooms,
`SidebarThreadRow`, `ChannelIcon` at nine render sites, `DraftMark`,
`ChannelListSkeleton`):

1. Job: open a channel, show what is waiting in it, and for a manager pin it,
   open its settings and drag it; threads nested under their channel.
2. States: plain, hover, focus, selected, unread, mentions, muted, draft,
   private, pinned, forum beta, watch party live (viewers, Assistir) and not
   live (topic), connected, drag and drop, loading.
3. Redesign: the `sm` list row on its tokens with the end pip as the one
   unread mark (decided in `p-list-row`), `CountBadge`, Phosphor icons in
   `ChannelIcon` (every site), round action tiles, the live pill as a dot.
   The voice row and its occupants are `s-voice-row`.

### s-voice-row

Spec (audit: voice rooms through `ChannelRow`, `VoiceOccupantRow`,
`VoiceOccupantBadges`, `ChannelMusicCard`, `ChannelSessionHint`):

1. Job: show who is in a room and what they are doing; join with a double
   click; per-person sound from a click; drag a person to another room.
2. States: connected, occupants speaking, muted, deafened, sharing, camera,
   hand (queue number), app line, soundboard marks, dragging; music playing
   (in the call or not, with "Ouvir"); a scheduled session hint.
3. Redesign: occupants as small list rows, filled 14px badges, the music
   card on the card tokens, the connected room on `success-soft`.
4. For `s-user-panel`: deafened is `EarSlash`; the panel's deafen button
   should use the same glyph.

### s-sidebar-rail

Spec (audit: one renderer, `ChannelList` folded by `iconsOnly` on desktop,
`ChannelRailItem` per channel, the Baú's `CommunityHomeNavButton compact`):

1. Job: the channel list at 72px: expand, search, the Baú, every channel as
   a glyph in groups (favourites, text, voice, categories).
2. States: selected, unread pip, mention count, muted, private (tooltip
   detail), the call you are in with its count, people in a room, a live
   watch party, hover, focus; Baú with new posts, Baú open.
3. Redesign: 40px rounded squares (`--strip-tile-radius`, 12px, so the strip
   does not read as a second server rail) on the list row's fills; round
   expand and search buttons; counts are `CountBadge` cut out of the pane.
   The full-width Baú row (no preview card) takes the channel row's look.

### s-voice-strip

Spec (audit: `VoiceStatusBar` wide and compact, `MusicMiniPlayer` idle and
playing in the sidebar footer, three call sites through `sidebarFooter`):

1. Job: the call you are in, from anywhere: status, quality, the room,
   leave, camera and share; music in the call.
2. States: connecting, connected, listen only, audience mode, push-to-talk
   idle, camera on, sharing, at the camera or share limit, a call in a text
   channel, leave hidden, compact; music idle and playing; two coachmarks.
3. Redesign: the footer's blocks are inset cards on the card tint
   (`SIDEBAR_FOOTER_CARD_REDESIGN`), leave is a round danger button, the room
   a pill, camera and share pills on the secondary fill (accent soft when
   on). `MusicNowPlaying` is shared with the composer's music bar and moves
   with `s-composer`.

Rounds (Opus only): r1 7.6, r2 8.0, r3 7.8 (no MUST). r3 fixes: status
labels on one edge, the room's microphone glyph. Decision: the 6px gap
between the voice strip and the user panel is the footer stack's gap, and
both cards keep the 8px side inset; not changed.
r4 8.0, r5 8.1 (cap, no MUST). r5 fixes: the footer cards draw
`--card-border` (the light card barely separated from the pane), and the
72px room button takes the row's shape. Follow-ups: the composer dock's
hang-up moves to `PhoneDisconnect` (`s-composer`); the music idle row needs
the music store fixture (`m-sheets`) before it can be reviewed.

### s-user-panel

Spec (audit: `UserPanel` wide and compact through `sidebarFooter`; its
hand-built status menu with the recado field; `DownloadHint` above it):

1. Job: who you are and your presence, mute, deafen, Não Perturbe, settings;
   the menu to rename, set the recado, pick a status, send feedback, get
   help, download.
2. States: off a call (mute and deafen disabled), mic off, deafened, muted
   by a moderator, listen only, DND, invisible, saving, error, compact;
   menu: the recado typed, over the limit, a status chosen.
3. Redesign: an inset card at the foot of the sidebar; round buttons, a soft
   danger fill when the mic or sound is off (warning for a moderator's
   mute); the deafen glyph is the bold ear the voice row uses. The menu
   keeps its own behaviour (not a Radix menu: the field and roving focus)
   and takes the popover surface and the menu row tokens.
4. Question for André: the status menu could become `ui/menu`'s
   `DropdownMenu` with the field as top content. That is behaviour, so it is
   not done here.

Rounds (Opus only): r1 7.5 (MUST fixed), r2 7.8, r3 8.1, r4 8.1, r5 8.2
(cap, no MUST). Changes over the rounds: the moderator's mute at full
strength; listen only as an outlined mic with a lock badge, named "Só
ouvindo" under the redesign; the home-indicator inset below the card;
`--footer-card-solid-hover` for the dot cutout; the status menu as wide as
the card with the dots in 16px slots; Não Perturbe as a red glyph without a
fill. Open (copy, shows with the toggle off too): the Invisível hint wraps
to seven lines at the card's width.

### s-header

Spec (audit: the chat header in `App.tsx` with `channelHeaderTools` and
`HEADER_ACTION_TILE`, shared with the call split's header; six more headers
drawn by hand: forum, Baú, friends, Novidades on a phone, two skeletons):

1. Job: where you are (name, topic or "N aqui", a conversation's line) and
   the pane's tools (join, call, nudge, schedule, pins, history, settings,
   members, more).
2. States: text, private, with an image, voice room (join), DM (call,
   video, join with count), in the call, members open, phone back or menu
   with the update dot, loading.
3. Merge: one recipe, `ui/pane-header.ts` (bar, title, detail, 36px round
   action tile, phone nav button), on every header above. From `md` up the
   topic sits beside the name after a rule, as in the mockup. Left for their
   elements: the thread panel's header (`s-thread`), the call split's own
   bar (`f-call`), the party bar (`f-watch-party`).
Rounds (Opus only): r1 7.0 (two MUST fixed: the phone title cut to "# p.",
`--list-row-icon` undefined on the branch), r2 7.9 (MUST fixed: the title
size token declared twice, so every title drew at 20px; the bar now has
`--pane-bar-title-size`), r3 8.0, r4 8.3, r5 8.3 (cap). Also: one baseline
and tracking with the sidebar header, the room's glyph before a voice or
forum title, the open members tile on the selected fill, 18px glyphs, the
forum and friends on the recipe. Follow-up after the chain: rename the
bar's `--pane-header-rule` and `--pane-header-px` to `--pane-bar-*` (six
chain branches use them now). Not done: an avatar before a DM's name.

### s-banners

Spec (audit: connection, sanction, error, idle and handle strips already use
`ui/banner` since `p-banner`; six strips still drew their own: watch now,
arrival (five variants), bring the crew, newcomer invite, the Discord import
notice, the upcoming session card):

1. Job: one strip at a time under the header that says something about the
   conversation and offers one way forward.
2. States: watch now with a second stream folded, joining, failed; arrival
   for a member and for the owner (copy, copied, failed); bring the crew
   arrived, reminder, empty; newcomer; import; a session scheduled or live.
3. Merge: each keeps its markup (confetti, faces, the folded list) and takes
   the banner's card through `bannerSurfaceRedesign(tone)` in
   `ui/banner.tsx`: inset, `--banner-radius`, the tone's soft fill and edge,
   text in the text colour, a round dismiss in the tone's ink. The session
   card is news, not a tone: the same inset and corner on the card tint.
Rounds (Opus only): r1 7.6 (MUST fixed: the second action was the generic
grey secondary on a tone), r2 8.1, r3 8.1, r4 8.0, r5 8.2 (cap; MUST fixed
after: the reminder's accessible name now follows its visible text). The
family: one card (`bannerSurfaceRedesign`), a tinted disc
(`BANNER_DISC_REDESIGN`), one ink-filled main action, a tinted second
action (`BANNER_QUIET_REDESIGN`, also the primitive's quiet), the round X
only where a strip can be hidden, one text column at 44px, meta lines at
13px. New copy: `watchPartySchedule.card.reminding` ("Lembrete ligado").
Not done: a dark-only accent edge at about 20% (judge with one strip in
place, not the sheet's stack).

### s-message-row

Spec (audit: `MessageRow` in `chat/message-list.tsx`, its gutter and author
line, `RankMarks`, `StatusDot`, the failed and queued footers, the blocked
row; one renderer with a stream variant and compact density):

1. Job: one message: who, when, what, and its delivery state.
2. States: first in a group, continued, compact, own, role colour, rank
   marks, bot, OP, webhook, AutoMod, gone; pinned, edited; sending, queued,
   failed (retry, wait, discard); blocked; mentions you (joined in a run);
   flash; bulk select; forum answer; stream rows.
3. Redesign: the row is inset 8px with an 8px corner and gives the inset
   back as padding, so text does not move; hover is a text tint (4.5% in
   dark, 3% in light); a mention is the system's mention row, a step
   quieter in light so it never reads as the selected channel; your own
   name is in the accent when you have no role colour; role names get a
   lightness clamp; times are tertiary; Retry is on the soft accent and
   Discard on the secondary fill. The hover toolbar, reactions, reply and
   thread chip are `s-message-chrome`; the inline edit field is
   `s-composer`.
Rounds (Opus only): r1 7.5 (MUST fixed), r2 8.0 (MUST fixed), r3 8.1,
r4 7.6 (MUST fixed: a pinned continuation line showed no pin), r5 8.5
(cap, no MUST). Also: the presence dot is cut from the fill it sits on,
a pinned continuation line carries its pin in the gutter, "(editada)"
ends the paragraph right before it. For `s-member-list`: the same role
lightness clamp on member rows and role chips.

### s-message-content

Spec (audit: `MessageBody` and the `.markdown-body` rules, `AttachmentGrid`
and its four tiles, `VoiceNoteCard`, `ForwardCard`, `PollCard`, `ChanceCard`,
`BotActionCard`, `BauPostCard`, `StoryQuoteCard`, `GifAttachment`,
`EmbedCard`, `WebhookEmbedCard`; custom emoji draw an image only):

1. Job: what a message carries, readable and one family.
2. States: markdown (bold, code, link, quote, list, code block, mentions:
   you, someone, everyone), picture (loading box, broken falls to the chip),
   video, audio, file, voice note (playing, unheard, broken, receipts),
   forward (restricted, media chip, thumbnail), poll (voted, leading,
   closed), dice, bot plan and ask, Baú post (locked, pinned, video), story
   quote (live, expired), GIF (reduced motion), link preview, webhook embed.
3. Redesign: one card (`ui/content-card.ts`): the card's text tint and edge
   at the card radius, no stripe and no shadow; pictures on a 12px media
   radius; file and media glyphs are Phosphor on a 36px tile; links in the
   accent ink with a soft underline; mentions a rounded accent tint; the
   voice note a pill. A webhook keeps the sender's colour on its left edge.
4. Kept as is: the lightbox (already the IconButton primitives; its chrome
   moves with the overlays), the bot notice (`s-log-chrome`).
5. Question: the broken-image chip says "Image unavailable" in English for
   every language (`attachment-grid.tsx`). Translating it changes the
   toggle-off app, so it waits for a yes.

Rounds (Opus only): r1 7.8 (MUST fixed: your own mention lost the cascade),
r2 8.2, r3 7.9 (MUST fixed: the webhook edge thinned at the corners), r4
8.2, r5 8.6 (no MUST, cap). After r5: one title scale (poll 16px), the
poll's other options at 14% under the 26% leader, the roll comment on the
kicker, named chips at medium weight. Not done: none.

### s-message-chrome

Spec (audit: the hover toolbar, its "Mais" panel and `MoreMenuItem`,
`ReactionBar`, `ReactionChip` and its who-tip, `ReplyQuote`, `ThreadChip`;
the right-click menu is the merged `ContextMenu`):

1. Job: act on a message, and see what others did with it.
2. States: toolbar (three quick reactions, yours filled; add; reply; start
   or open a thread; edit; more), "Mais" open up or down with a danger
   group; reactions (yours, others, many, the add button); reply (author,
   excerpt, deleted parent); thread chip (unread dot, open, archived, faces).
3. Redesign: the toolbar is a pill on the popover surface with 32px round
   buttons and Phosphor glyphs; "Mais" is the menu's panel and rows, so it
   matches the right-click menu; a reaction is a 28px pill on a text tint,
   yours the accent's soft fill with an accent ring; the reply line reads
   author in text and excerpt in secondary; the thread chip is a pill on a
   text tint, open is the selected row's fill.
4. Duplicate kept: "Mais" and the right-click menu list the same actions in
   two components. Moving "Mais" onto `Menu` changes its keyboard behaviour
   with the toggle off, so it waits (question below).
5. Question: should "Mais" become the shared `Menu` (arrow keys, type to
   find) for everybody, not only under the redesign?

Rounds: r1 Opus 7.6, r2 Codex 8.4, r3 Opus 8.6, r4 Codex 8.6, r5 Opus 8.6
(no MUST, cap). After r5: the open chip's meta in its own softened colour,
legible initials on the faces, toolbar focus in the focus colour. Not done:
raising the toolbar to `-top-5` (it would cover more of the row above).

### s-log-chrome

Spec (audit: `DaySeparator`, `UnreadSeparator`, the load older and newer
buttons, `TypingIndicator` and `BotActivityRows`, `BotNoticeRow`, the jump
pill and the "message is gone" note, the bulk delete bar; the empty and
failed states are `p-empty`'s, already merged):

1. Job: where I am in the log, and what is happening around it.
2. States: day rule, NEW rule, older or newer history to load (loading),
   typing (one, two, many; bots at work), the bot's note to me, jump to the
   present (missed count, stream "paused"), jump target gone, bulk select.
3. Redesign: the day is a pill in sentence case on faint rules; NEW is the
   danger fill's pill; load buttons are the secondary pill; the jump pill,
   the gone note and the bulk bar float on the popover surface; the bot's
   note is a message card with a round dismiss.
4. Question: "Load older messages" and "Loading older messages…" are
   English in every language. Translating them changes the toggle-off app.
5. Not on the sheet: the bulk bar and the gone note need a live list state.

Rounds: r1 Codex 8.0, r2 Opus 8.0, r3 Codex 8.5, r4 Opus 8.5, r5 Codex 8.6
(no MUST, cap). Fixed along the way: the jump pill rises over the bot's
note and follows it down, one left edge for the footer, the day label
outlined so it stops reading as a button, room under the newer button, the
weekday in sentence case. Open: the "Load older messages" copy question.

### s-composer

Spec (audit: `MessageComposer` (the well, reply chip, attachment chips,
format bar and preview, feedback strip, tools, send, slow mode), the "+"
menu (already `MENU_SURFACE`), `AutocompleteMenu`, the emoji and GIF panels
(already `POPOVER_SURFACE`), `PollComposer`, the voice note mic and panel,
`ComposerReadOnlyNotice`, the inline `EditComposer`; one composer serves the
channel, the thread panel and the forum dialog):

1. Job: write and send, with everything a message can carry.
2. States: resting, typing, replying, attachments (uploading, failed),
   format bar open, a panel open (+, emoji, GIF, autocomplete row and grid),
   poll, voice note (hold, locked, review), slow mode, read-only, stream
   variant, embedded, editing a message, feedback (error, success, info).
3. Redesign: one 20px well on a faint text tint whose edge comes up while
   typing; 36px round tools with Phosphor glyphs, a held fill when a panel
   is open; a round accent send; the reply chip a pill; chips are cards;
   autocomplete is the menu's panel and rows; the poll composer a card with
   the input's fields and accent-ringed chips; feedback floats on the
   popover surface with a toned glyph.
4. Kept: the music bar and call dock inside the well move with `f-call`; the
   poll composer's hand-made switch stays (question: swap it for `Switch`).
5. Not on the sheet: the "+" menu (needs attachments or slash commands).

Rounds: r1 Codex 8.0, r2 Opus 8.2, r3 Codex 8.2, r4 Opus 8.3, r5 Codex 8.8
(no MUST, cap). Fixed along the way: slow mode's countdown on the soft
accent, a firmer typing edge, the text 16px in, an open tool held a step
firmer than a hover, line-weight smiley and GIF, the read-only edge on its
own token, a typed draft on the sheet. Not on the sheet: an attachment chip
and the autocomplete (they need a live upload and a member list).

### f-onboarding

Spec (audit: `onboarding/` (11 files), the hints in `layout/*-hint.tsx`
and `corner-card.tsx`: the wizard, the first-run card, arrival and newcomer
strips, ten hints that all render through `CornerCard`):

1. Job: get a new person to a working setup, and teach a feature once.
2. Redesign: `CornerCard` (the one hint shell) on the popover surface,
   edge, lift and radius, a round close (glass on a hero), a 15px title;
   the first-run card a pane-radius card with accent-soft step wells.
3. Merges: none needed; the hint shapes already share `CornerCard`.
4. Kept: every hint, the queue, the quiet contexts, the wizard.
Rounds (Opus only): r1 7.3 (MUST fixed), r2 7.8, r3 8.3, r4 8.2, r5 8.3
(cap, no MUST). The family: one 32px round close on every card (glass on
a hero, from `--glass-bg` / `--glass-fg` / `--glass-border`), the shell
sizes a footer's primary action (`data-cta`, 120px), done steps keep their
place with a check and "Feito" and no strike. Rebuilt off `redesign`
without the f-call work the first branch carried.

### f-profile

Spec (audit: `user-profile-popover.tsx` (self, other, bot, blocked; action
strip, Mais menu, manage and cargos sections, inline timeout and ban
composers, medals, depoimentos, connections, communities),
`member-moderation-dialog.tsx`, `depoimentos-section.tsx`):

1. Job: who this person is and what you can do about them, from any name.
2. Redesign: the card is the shared popover (surface, edge, lift, radius);
   the action wells are round on the card tint with filled glyphs; Mais is
   the shared menu's rows; manage, cargos and the about pane are cards; the
   name in Gabarito, the tag in sans; role chips and timeout presets are
   pills; inline fields take the input tokens.
3. Merges: Mais stays its own fixed menu (the card scrolls, a portal menu
   must not clip). Question kept: native `prompt` and `confirm` for nickname
   and kick still belong to the browser.
4. Kept: every action, the moderation composers inline (the evidence stays
   in view), the contact-sheet strip.

Rounds: r1 Codex 7.8 (MUST fixed: the action wells vanished in light), r2
Codex 8.0, r3 Opus 8.1, r4 Codex 8.1, r5 Opus 8.2 (no MUST, cap). After r5:
danger hover on the red rows, focus rings on the timeout pills and reason
inputs, the timeout note in secondary text, menu row rhythm in the
community card. Not done: a filled check for "already friends" (copy shows
with the toggle off).

### f-states

Spec (audit: `app-loading-shell.tsx` (the boot shell and the cannot-reach-
the-API page, from `main.tsx` and `App.tsx`), `ui/skeleton.tsx` and the
spinner (merged as `p-loading`), `error-boundary.tsx`, `HistoryFailed`
(merged as `p-empty`)):

1. Job: what the app shows before it can show the app, and when it cannot.
2. Redesign: the boot shell is the frame (canvas, rail on it, floating side
   and main panes on the frame recipes) with its skeletons, the composer a
   rounded well, the label sentence case, "pqp" in Gabarito; the API error
   page takes Gabarito and sentence case.
3. Not touched: `error-boundary.tsx`. AGENTS.md says to leave it alone, and
   question 3 asks André first.
4. Kept: the stored sidebar width on first paint, the retry and the docs
   pointers on the error page.
5. Question (copy, shows with the toggle off): the deploy notes on the
   error page name "Railway/Docker", but production runs on Vultr. Under
   the redesign they fold behind "Detalhes para quem hospeda"; the text
   itself waits for a yes.

Rounds: r1 Opus 7.8, r2 Opus 7.6 (MUST fixed: the rail skeleton was squares
where the rail draws circles), r3 Codex 7.4 (its MUST was a misread: it took
the dark shot for light; the file is the dark capture), r4 Opus 8.3, r5 Opus
8.1 (no MUST, cap; best r4). After r5: the host summary in secondary text,
the failure announced and focus on the retry under the redesign. Not done:
the error page inside the canvas frame (it replaces the whole tree; a
restructure), a lighter light skeleton (the loading council set 10% because
8% vanished at the pulse's low point), the kicker as plain text (it is a
link today).

### f-bots

Spec (audit: `bots-settings-section.tsx` in server settings, `bots/` (the
wizard with its preview pane, the overview, the face, radio choices, tags,
the intro hint); behind the per-server `custom_bots` flag):

1. Job: give a server a helper bot: name, face, colour, what it may do, and
   see what it did.
2. Redesign: the server settings frame around it; eyebrows sentence case;
   face and colour choices take the kit's chosen-card recipe and the accent
   ring; icon tiles round.
3. Merges: question kept: `radio-choices.tsx` duplicates the roving radio
   group; folding it into `ui/RadioGroup` would change the toggle-off look.
4. Kept: the wizard steps, the practice chat, the activity list.

### f-call

Spec (audit: `voice/call-stage.tsx`, 5,900 lines: the controls in three homes
(the open stage's floating bar, the composer's dock, the column beside an
app), camera and primary tiles, the room view, the listener ring, badges,
tile and share overlays; soundboard, audience, video quality as their own
files):

1. Job: be in a call: see who talks, mute, camera, share, hand, music, leave.
2. Redesign: one recipe for every control (`call-control-classes.ts`): wells
   on the stage, ghosts in the dock, on is the soft accent, muted the soft
   danger, hang-up solid red; tiles on the card radius with a gapped speaking
   ring; dark glass on pictures; filled Phosphor glyphs.
3. Merges: the four look-alike control strings into one recipe.
4. Kept: every control, the folding rules, the idle fade, all three homes.

Rounds: r1 Codex 8.1, r2 Opus 8.2 (kept the live mic neutral, agreed), r3
Codex 8.3, r4 Opus 8.4, r5 Opus 8.5 (no MUST, approved, cap). After r5: an
even gap beside an app, docked dots ringed in the composer's fill. Not done:
"Lia (você)" on the self tile (copy, shows with the toggle off), a ring on
stacked initials (the avatar's), muted and moderator-muted captures.

### f-forum

Spec (audit: `forum/` (8 files): the pane with its search, filter bar and
layout switch, three post layouts (card, compact row, gallery tile) and the
pinned row, the post view with status, tags, follow and the solution, the
composer dialog with similar posts and tags):

1. Job: browse, filter and open posts; start one; mark one resolved.
2. Redesign: cards, tiles and pinned rows on the card tokens with a stronger
   edge on hover and when open; compact rows on the row roles (the selected
   fill replaces the side bar); filters, tags and the status trigger are
   pills on the segmented track's tint; the layout switch is segmented; the
   search is a round input well; filled glyphs.
3. Merges: the three tag pill looks share one resting tint.
4. Kept: every layout, filter, sort and badge; the 767px breakpoint and the
   forum's own empty block (logged, not merged: the shared EmptyState already
   draws it).

Rounds: r1 Codex 7.6, r2 Codex 8.2, r3 Opus 8.3, r4 Codex 8.3, r5 Opus 8.4
(no MUST, no SHOULD, cap). After r5: the composer title on the card edge,
the light open row a step under the selected channel, the segmented status
and the inverse toggles written down in DESIGN.md. Not done: an unread post
in the light shots (the dark pass marks the fixture read first).

### f-watch-party

Spec (audit: `watch-party/` (24 files): the sidebar block with its live
card, create, teaser, scheduled and history rows; the create dialog; the
host's pane (setup, scheduled card, live bar, dock, transmission strip,
activity feed, options, people, co-hosts); history; waitlist; guests):

1. Job: make, announce, run and watch a party; tell everyone it is live.
2. Redesign, this pass: the sidebar rows are cards (the open live card a
   soft red), the live badge solid red, the scheduled card a pane card with
   a sentence-case label, the host bar on the pane like a header, the mic
   chip a pill on the call's tints, the transmission strip on card tokens.
   Dialogs, the dock and the options use the merged primitives already.
3. Merges: none yet; the five dialog shells stay (each is `ui/Dialog`).
4. Kept: every state, the copy (the live badge stays uppercase).

Rounds: r1 Codex 8.5, r2 Opus 8.2, r3 Codex 8.5, r4 Opus 8.5 (approved),
r5 Opus 8.6 (approved, cap). After r5: the header's "more" button on the
symbol weight (a shared shell line), the host bar's glyphs at the header's
18px, the mic chip at 32px with Phosphor glyphs and its colour kept on
hover, and the live red named in DESIGN.md. Left: "Copiar link" stays a
ghost like every share button.

## Open questions for André

- Popover behaviour: eight popovers each place, portal and dismiss
  themselves. Sharing one behaviour means adding `@radix-ui/react-popover`
  (a new dependency and lockfile change). Only the look is shared for now.

1. Reviewers (answered 2026-10-28): André dropped Grok (too slow), so the
   council is Opus and Codex. Codex hit its usage limit on 2026-10-27 and
   rounds on Oct 27-28 were Opus only. On 2026-10-28 André moved Codex to a
   ChatGPT Plus plan and picked gpt-6-luna (high). Codex reviews the middle
   rounds; Opus joins for the sign-off round.
2. Four features live in two versions behind flags. The redesign should
   rebuild only the version that stays. Which one stays for each?
   - DM list: classic or Conversas home (`conversations_home`).
   - New conversation dialog: classic or new.
   - Phone shell: bottom tabs (`conversations_home_phone_tabs`) or the drawer.
   - Channel list: mixed layout (`mixed_channel_list`) or legacy sections.
3. `error-boundary.tsx` is English only, and AGENTS.md says to leave it alone.
   Redesign its look and keep the copy as is?
4. Sidebar header: the members button duplicates the server menu's Membros
   and the chat header's members control. Hide it on desktop too, so a long
   server name fits? It is hidden in the phone drawer already.
5. Invites: each invite card says "1 uso" under a "Usos" chip row, which
   reads as "limited to one use". The council suggests "Usado 1 vez · sem
   limite" and "{used} de {max} usos". That is a copy change in three
   languages and shows with the toggle off too. Change it?
6. Connections and profile: three notices say a feature is "not active on
   this server" ("não estão ativas neste servidor"). In pqp a "servidor" is
   a chat server, so the council reads it as wrong. Suggested pt-BR: "ainda
   não estão disponíveis aqui", with en and es to match, for
   `settings.connections.unconfigured`, `settings.profile.banner.unconfigured`
   and `settings.profile.media.unconfigured`. It shows with the toggle off
   too. Change it? Same tab: the visibility hint says "Para usar" while
   the rest of the tab says "pra"; the council suggests "Pra usar".

## Decisions

- Oct 26, 2026: the council drops Grok 4.7 at André's request ("he takes too
  long"). From IconButton round 5, Tooltip round 5, Input round 4, Select
  round 3, Checkbox round 2 and Radio round 1 on, an element passes with
  Opus and Codex at 9.0+, no MUST and no category below "before".

| Date | Decision | Why |
|---|---|---|
| 2026-10-27 | `f-friends` merges after the shell chain | Its branch sits on top of `s-sidebar-special` through `s-member-list`; merging it first would bring unreviewed shell work into `redesign`. |
| 2026-10-26 | Element branches use `rd/<id>` | Git ref conflict with `redesign`. |
| 2026-10-26 | Direction mockups are a dev-only page on an unmerged branch | Real pixels for the pick, no change to production components, nothing to clean up on `redesign`. |
| 2026-10-26 | Direction B (Salas), with filled icons instead of outlines | André's pick. The council preferred A; B was second for both reviewers (7.2, 7.4), and the risks they named for B go into the Phase 1 tokens: gutters cost width on small screens, and a third surface level invites card-in-card settings. |
| 2026-10-26 | Redesign colours are scoped to Clássico; shape applies to every look | A look is a palette. The other looks keep their identity and get only the fixes the new roles need. |
| 2026-10-26 | Derived roles use `color-mix(in oklab)`, and the bench and `/qa/ui` learned to read it | One formula reaches all ten looks, the custom accent and high contrast, and stays measured. |
| 2026-10-26 | `ui/icon.tsx` ships with the tokens | It is the only place the fill-or-bold rule lives, and the sheet needs it to show the icon tokens. |
| 2026-10-26 | Council T1 runs with two reviewers | Gemini 4 Argon is still out of credits; the third seat waits on open question 1. |
| 2026-10-26 | Tokens merged on André's sign-off at Codex 9.0, Opus 8.4 | Opus's last MUST was fixed after T3. The element rounds hold the 9.0 bar from here. |
| 2026-10-26 | Phase 2 follows the inventory order: primitives first, then shell, surfaces, phone | Every later element is built from the primitives. |
| 2026-10-26 | The toggle ships before the tokens | It is the same for every direction and changes nothing visible. Precedence: `?redesign=1|0`, then the person's Beta switch (`pqp-redesign`), then the `redesign` flag. |

Rounds (Opus only): r1 7.4 (3 MUST fixed), r2 7.8 (MUST fixed: the chosen
card's edge was 1px), r3 7.7, r4 7.9, r5 8.3 (no MUST, cap). After r5: no
resize grip on the persona, the stat notes on one line, the no-channel note
in the warning colour. Not done: a spinner on the wizard's final button
while it saves (`ui/button.tsx` has no loading prop).

