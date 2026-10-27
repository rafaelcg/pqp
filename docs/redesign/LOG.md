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
## Open questions for André

- Popover behaviour: eight popovers each place, portal and dismiss
  themselves. Sharing one behaviour means adding `@radix-ui/react-popover`
  (a new dependency and lockfile change). Only the look is shared for now.

1. Resolved 2026-10-26: Grok 4.7 is the third reviewer.
2. Four features live in two versions behind flags. The redesign should
   rebuild only the version that stays. Which one stays for each?
   - DM list: classic or Conversas home (`conversations_home`).
   - New conversation dialog: classic or new.
   - Phone shell: bottom tabs (`conversations_home_phone_tabs`) or the drawer.
   - Channel list: mixed layout (`mixed_channel_list`) or legacy sections.
3. `error-boundary.tsx` is English only, and AGENTS.md says to leave it alone.
   Redesign its look and keep the copy as is?

## Decisions

- Oct 26, 2026: the council drops Grok 4.7 at André's request ("he takes too
  long"). From IconButton round 5, Tooltip round 5, Input round 4, Select
  round 3, Checkbox round 2 and Radio round 1 on, an element passes with
  Opus and Codex at 9.0+, no MUST and no category below "before".

| Date | Decision | Why |
|---|---|---|
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
