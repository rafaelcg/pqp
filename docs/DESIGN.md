# Design system

> Written 2026-09-08 against `main`. Grounded in `client/src/index.css`,
> `client/src/components/ui/*.tsx` and `client/bench/theme-tokens.mjs` as they
> are, not as they should be. Where a primitive is missing, it is listed under
> Planned primitives rather than described as if it existed.

The theme itself (brightness, looks, high contrast, accent hue, and why they are
separate axes) is `docs/THEMING.md`. This file is about what a component may
draw, and with which name.

The live sheet is `/qa/ui`. It renders every token and every primitive in the
theme you have on. It exists only on a build with the dev auth bypass; see
Reference page below.

## Principles

1. **A name says the role, not the colour.** `surface-2`, not `ink-3`. A theme
   can invert a ramp or retint an accent without a class name becoming a lie.
2. **A value belongs to the token layer.** A component names a token. It does
   not name a colour, a radius or a duration.
3. **The primitives are the reference.** New UI composes `client/src/components/ui/`.
   A one-off control that reimplements a button is how the next inconsistency
   starts.
4. **Contrast is a number, not an opinion.** Every foreground and background
   pair that matters has a floor, and the bench measures it in every theme.
5. **The rules are counted.** A rule nobody can enforce is a preference. Every
   rule in this file that can be counted is counted, by `bench/theme-tokens.mjs`
   or, for the copy rule, by `scripts/check-i18n.mjs`.

## Foundations

### Colour

Three tiers, and only the middle one has names a component may write.

| Tier | Where | Example |
|---|---|---|
| Reference | The raw OKLCH values in the token blocks | `oklch(0.16 0.012 250)` |
| System | Role tokens in `@theme static` and the theme override blocks | `--color-surface-0` |
| Component | The Tailwind utility a primitive writes | `bg-surface-0` |

A component only ever reaches tier three. A theme only ever edits tiers one and
two. Nothing outside `index.css` writes a reference value.

The role set, as defined today:

| Group | Tokens |
|---|---|
| Surfaces | `surface-0`, `surface-1`, `surface-2`, `surface-3`, `rail`, `surface-card` |
| Borders | `border`, `border-strong` |
| Text | `text`, `text-secondary`, `text-tertiary` |
| Accent | `accent`, `accent-hover`, `on-accent` |
| Status | `danger`, `warning`, `success`, and `on-danger` for a count drawn on the danger fill (an unread badge) |
| Soft | `accent-soft`, `danger-soft`, `danger-soft-hover`, `warning-soft`, `success-soft`, and an `on-` for each fill |
| Code | `code-bg`, `code-text` |
| State | `focus-ring`, `ring-offset`, `selection`, `indicator` |

#### The text ladder

Three roles, loudest first: `text` is primary, `text-secondary` is a label or a
second line, `text-tertiary` is the quietest thing that still has to be read.
The names follow Apple's ladder.

They replaced `text-subtle` and `text-muted`, which were backwards: `subtle`
measured 11.1:1 and `muted` 7.8:1, so the name that says "quieter" was the
louder of the two everywhere it was written. `text-secondary` carries the old
`subtle` value and `text-tertiary` the old `muted` value, so nothing changed
colour.

Both old names survive in the alias block as `var()` references and still
resolve for the couple of hundred call sites outside `ui/`. They are deprecated
(Rule 4) and the bench counts them inside `ui/`.

#### The soft surfaces

A tinted fill for a badge, a toast, a banner or the danger button, and the
foreground that belongs on it: `--color-danger-soft` with
`--color-on-danger-soft`, and the same shape for accent, warning and success.
Every pair is a real colour, not an alpha wash, and clears 4.5:1 in every theme
because the bench measures the pair.

What they replaced was `bg-danger/20 text-danger`, improvised in three places.
An alpha wash has no measurable ratio at all, because the result depends on a
backdrop nobody declared, so nothing could say whether the label was readable.

`--color-danger-soft-hover` is the only hover in the set: the danger button is
the only soft surface a pointer lands on. Add another when something needs one;
do not reach for an opacity modifier.

`surface-0` is the app background, `surface-1` a panel, `surface-2` a raised
panel or a hover, `surface-3` a skeleton and the one surface that is *darker*
than the panel in light themes. `surface-card` is a grouped box of rows on a
panel (the settings kit's `SettingsGroup`, written `elevation-1 bg-surface-card`).
It is a role, not a new colour: `surface-1` in dark, where the border lifts the
box, and `surface-0` in every light look, so the box is lighter than the grey
panel instead of a faint outline. It always equals a surface the bench already
measures text on, so it adds no contrast pair. `on-accent` exists because the accent is bright
in dark and dark in light, so a foreground on it cannot be derived from `text`.

Two sets are deliberately not themed: the third-party connection marks
(`--color-connection-*`), because a Steam badge has to look like Steam, and the
medal golds, because a gold coin that followed the accent would stop being a
coin.

The blocks that define all of this, in the order they appear in `index.css`:
`@theme static`, then unlayered `:root`, then `:root[data-theme="light"]`, then
the four `[data-appearance]` skins, then `[data-contrast="more"]`, then
`[data-accent="custom"]`. Every block after the first is unlayered so it outranks
`@theme` with no specificity trick.

**Never use `@theme inline`.** It resolves values at build time, which
structurally breaks runtime theming. `@theme static` is required for the
opposite reason: the default `@theme` tree-shakes anything the utility scanner
does not see, and role tokens are read at runtime by the override blocks.

### Typography

Four families. `--font-sans` (Instrument Sans) is everything. `--font-display`
(Gabarito) is headings and dialog titles. `--font-handle` (Bricolage Grotesque)
is used for exactly one thing, somebody's `@`. `--font-brand` (Dela Gothic One)
is the wordmark.

Five type roles. Each has a size and a line height, and each size matches the
Tailwind utility the components already use, so a primitive may keep writing
`text-sm`. The tokens exist so plain CSS and any surface that cannot use a
utility can name the role instead of the number.

| Role | Size | Line height | Used for |
|---|---|---|---|
| `--type-display-size` | 24px | 1.2 | Dialog titles, in `--font-display` |
| `--type-title-size` | 18px | 1.3 | Section headings inside a panel |
| `--type-body-size` | 14px | 20px | The app default, and every control's label |
| `--type-label-size` | 12px | 16px | A compact control, an eyebrow, a tooltip |
| `--type-caption-size` | 11px | 16px | The quieter second line under a label |

The equivalent utilities are `text-2xl`, `text-lg`, `text-sm`, `text-xs` and
`text-[11px]`.

One rule that is not a token: on a screen under 640px wide, or any coarse
pointer, `input`, `select` and `textarea` are forced to 16px. Below that iOS
Safari magnifies the whole page on focus, which moves a fixed dialog off the
screen. See the comment in `index.css`.

### Spacing

Tailwind's default 4px scale, through `--spacing`. It is deliberately **not**
redefined. `p-2` is 8px, `gap-4` is 16px, and every number in a class name is a
count of 4px steps.

Redefining the scale would silently move every existing layout in the app, and a
4px step is already the right granularity for a chat shell. If a surface needs a
value the scale does not have, it is an arbitrary value on that surface, not a
new global step.

### Radius

Five roles, in the unlayered `:root`. Consumed as `rounded-[var(--radius-card)]`.

| Token | Value | Used for |
|---|---|---|
| `--radius-tick` | 3px | The square tick in CheckRow |
| `--radius-control` | 6px | Button, Input, menu row, Skeleton, the default tooltip bubble |
| `--radius-card` | 8px | Menu containers, the `rail` tooltip shell, a card |
| `--radius-panel` | 16px | A dialog panel |
| `--radius-pill` | 999px | Anything fully rounded in plain CSS |

The names avoid `--radius-sm`, `--radius-md` and `--radius-lg` on purpose.
Tailwind emits those itself and `rounded-md` reads them, so redefining one would
reshape every `rounded-md` in the app rather than only the primitives.
`rounded-full` is a static Tailwind utility and is still used directly on round
elements; `--radius-pill` is for the plain CSS in `index.css`.

### Elevation

**A level is three values, not one.** A shadow alone does almost nothing on a
dark page, because black on near-black is invisible. Dark UI states elevation in
surface lightness plus a hairline border, and keeps the shadow for things that
genuinely float. So each level is a surface, an edge and a shadow together.

| Level | Surface | Border | Shadow | For |
|---|---|---|---|---|
| `elevation-1` | `surface-1` | `border` | none | A resting card lifted off the page |
| `elevation-2` | `surface-2` | `border-strong` | `--shadow-2` | A raised block inside a panel |
| `elevation-3` | `surface-2` | per theme | `--shadow-2` | Anything floating: popover, menu, dialog |

Levels 2 and 3 cast the same shadow and differ in their edge. That is deliberate:
`--shadow-2` is what every menu, tooltip and popover in this app has always
drawn, through the `--shadow-popover` alias, and naming the level must not
restyle it.

A component writes the level, not the parts. The three are Tailwind v4
`@utility` blocks in `index.css`, so `elevation-3` is a real class that composes
with variants and is merged by `cn` like any other. The alternative, three
documented token triplets, still leaves the caller spelling
`bg-[var(--elevation-3-surface)] border-[var(--elevation-3-border)]
shadow-[var(--elevation-3-shadow)]`, which is three chances to take two of the
three; a menu with a shadow and no edge is exactly the bug this replaces.

The parts are `--elevation-N-surface`, `--elevation-N-border` and
`--elevation-N-shadow` in the unlayered `:root`. They hold `var()` references,
not colours, so retinting a surface moves every level with it. They are
deliberately not in `@theme`: a `bg-elevation-3-surface` utility is the call
site the levels exist to remove.

A caller that needs a different **background** or **shadow** at the same level
writes that one utility after the class (`elevation-3 bg-surface-1`) and keeps
the rest. The **border colour cannot be overridden this way**: Tailwind v4 orders
the emitted rules by property rather than by the order the classes are written,
and the level's `border` shorthand lands after the `border-color` a utility like
`border-danger` emits, so the danger colour is silently dropped. A different edge
means a wrapper: the level on the outer element, the coloured border on an inner
one.

A theme that wants no edge at a level sets the border to `transparent` rather
than dropping it, so the 1px of geometry is the same in every theme. Light does
that at level 3, where the shadow already separates a floating panel from a
white page and a hairline on top reads as a box in a box. High contrast puts a
`border-strong` edge back at level 3, in both brightnesses.

Who is on which level today: `Dialog`, `ContextMenu` and the default `Tooltip`
bubble are level 3. `PromptDialog` renders a `Dialog` and inherits it. The
tooltip's `rail` tone keeps its own darker shell (`surface-0` with a `surface-2`
edge) and is a deliberate exception, not an un-migrated one. Nothing in `ui/`
draws a level 1 or 2 card yet; outside it, the settings kit's group box is level
1 (`elevation-1 bg-surface-card`) and its unsaved-changes bar is level 2.

`elevation-*` writes `box-shadow` directly, and so does a Tailwind ring. Do not
put a focus ring and an elevation level on the same element; put the ring on the
control inside.

The ladder itself is still `--shadow-1`, `--shadow-2` and `--shadow-3`, and all
three are theme values: a black shadow reads as dirt on a light page, so the
light block redefines them in the surface colour rather than in black. Only
`--shadow-2` is drawn today; the other two are rungs a theme can move, and
`/qa/ui` shows all three so neither is invisible.

`--shadow-popover` is an alias for `--shadow-2` and is kept because component
files across the app already spell it, `ui/` included. Set the level in a theme
and every consumer follows. The purpose-built shadows that are not part of the ladder
(`--shadow-speaking`, `--shadow-medal`, `--shadow-chance-*`, the hero shadows)
stay their own tokens because they are effects on one object, not elevation.

### Motion

Three durations and two curves.

| Token | Value | Used for |
|---|---|---|
| `--duration-fast` | 150ms | A state change on a control the pointer is on |
| `--duration-base` | 200ms | Something appearing or leaving |
| `--duration-slow` | 300ms | A whole panel moving |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | The default curve |
| `--ease-emphasized` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entrances and exits |

Consumed as `duration-[var(--duration-fast)]`. Anything longer than `slow` is an
animation with its own keyframes, not a transition. Every keyframed animation in
`index.css` already used the emphasized curve and now names it.

`--ease-in`, `--ease-out` and `--ease-in-out` are Tailwind's own names, which is
why these two are named for what they do.

Every animation utility in `index.css` is switched off under
`prefers-reduced-motion: reduce`. A new animation joins that block.

Nothing in the conversation pops into place. Three pieces cover it:

| Piece | What it does | Where |
|---|---|---|
| `.chat-msg-in` | A row that just arrived rises in, 6px and a fade. Only on a row younger than a few seconds when it mounts, so history and a remount stay still. | Message rows, the composer's reply bar and attachment chips, the bot practice chat |
| `Reveal` (`components/ui/reveal.tsx`) | Something under the log that comes and goes opens and closes its own height, and keeps its last content while it shrinks away. | Typing, a bot at work, the bot notice |
| `.chat-collapse` + `data-open` | A section of a card folds open or shut in place. | A bot card's steps and buttons, a question's answers |

`.chat-swap-in` fades in content that replaces other content in the same spot,
keyed so it remounts (a bot's activity label, a card header that settles).
Entrances use `backwards`, not `both`: a landed row keeps no transform, which
would make it a stacking context and trap its hover toolbar. The list stays
pinned to the bottom while a `Reveal` grows, because its ResizeObserver re-pins
on every size change. With reduced motion everything is simply there or not.

### Focus and states

- **Focus.** `focus-visible:outline-none focus-visible:ring-2
  focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset
  focus-visible:ring-focus-ring`. All four parts carry the variant: an
  unprefixed `ring-offset-2` paints a permanent band around the control and
  changes its apparent size. `--color-focus-ring` is the theme's accent at 60%
  alpha in every theme block, so one token covers all of them.
  `--color-ring-offset` is the 2px band between the control's edge and the ring,
  without which the two fuse into one thick border on a field that already has
  one. It is painted, not a gap, so it names a surface: it follows
  `--color-surface-1`, the panel a field, a row control or a button sits on
  nearly everywhere. A control on a different backdrop overrides the one class
  (`focus-visible:ring-offset-surface-0`), not the token. Focus is
  `focus-visible` only, never `focus`: a mouse click on a button must not leave
  a ring behind.
- **Hover.** A background step up the surface ramp, usually `hover:bg-surface-2`.
  Text controls also lift `text-text-tertiary` to `text-text`.
- **Active.** `active:scale-[0.98]` on Button. Nothing else presses.
- **Disabled.** `disabled:pointer-events-none disabled:opacity-40` on Button
  (0.5 under the redesign, where a disabled primary is an empty pill instead),
  `disabled:cursor-not-allowed disabled:opacity-50` on Input. The two differ
  because a disabled button must not swallow a tooltip's hover and a disabled
  field should still say why it cannot be typed in.
- **Selected.** A wash of the accent plus full-strength text, as SectionRail
  draws it: `bg-accent/12 font-medium text-text`.
- **Danger.** `text-danger` on a menu row, `bg-danger-soft
  text-on-danger-soft hover:bg-danger-soft-hover` on a button. Danger is never
  the accent, and a danger fill is never an opacity modifier.

### Iconography

`lucide-react`, imported per icon so the tree shakes. Sizes are `h-4 w-4` inline
with body text, `h-3.5 w-3.5` in a menu row, `h-3 w-3` inside a tick.

An icon is a mnemonic, not a name. Every icon-only control needs an accessible
name, and the way to give it one is `Tooltip`, which sets `aria-label` on the
trigger so the label and the tooltip cannot say different things. Decorative
icons get `aria-hidden`.

### Density

One density. The control ladder is three heights and matches what the primitives
already draw:

| Token | Value | Utility | Drawn by |
|---|---|---|---|
| `--control-sm` | 2rem | `h-8` | `Button size="sm"` |
| `--control-md` | 2.25rem | `h-9` | `Button` default and `size="icon"` |
| `--control-lg` | 2.5rem | `h-10` | `Input` |

There is no `lg` button and no `sm` input. Do not add one without a surface that
needs it.

The message list is the one exception, and it is the user's choice rather than
the system's. Settings > Appearance sets three root variables that the list and
the preview block in Settings both read: `--chat-font-size` (12 to 24px, default
15), `--chat-line-height` (22/15 of the size) and `--chat-group-gap` (0 to 24px
above a new group, default 8). Compact density is state, not CSS: the message
row reads it from the store and drops the avatar for a time on every line. The store is `client/src/lib/chat-display.ts`; the
boot script in `index.html` paints the stored values before the bundle loads,
and the values follow the account through `preferences.chatDisplay`.

Touch targets: a row control (Switch, CheckRow) makes the whole row the hit
target rather than shipping a 16px native tick. A tooltip is inert on touch by
design, so any explanation a phone user needs is said out loud on the surface.

## The redesign (Salas)

The redesign rebuilds the app element by element behind a toggle. Its status,
decisions and council scores are in `docs/redesign/LOG.md`. The direction is B,
"Salas": rounded panes that float on a darker canvas, with filled icons.

### The toggle

`<html>` carries `data-redesign` when the redesign is on (`lib/redesign.ts`).
With the toggle off, no `redesign:` class matches and no redesign token block
applies. Three ways to draw the new look, in order of preference:

1. A component token with a fallback in the class:
   `px-[var(--button-px,1rem)]`, with `--button-px` set only on
   `:root[data-redesign]`. Use it for a primitive, because a call site's own
   class still wins through `cn`.
2. The `redesign:` variant, for an element nobody overrides from outside. It
   outranks any plain class on the same element.
3. `useRedesign()`, when the markup itself differs.

### What the toggle changes in the token layer

Two kinds of block in `index.css`, both scoped to `data-redesign`:

1. Shape, for every look. Radius, the title face, line heights, the list-row
   height, the two space tokens, motion, the icon stroke and the shadow ladder.
   A look is a palette. The redesign is the structure under all of them.
2. Colour, per look. Clássico gets the Salas palette in dark and in light.
   Night, Modo 2005, Everforest and Catppuccin get small fixes so the new roles
   pass in them. Every other look keeps its colours as they are.

Source order is the cascade. The redesign selectors have the same specificity
as a look or the light block (`:where()` keeps the look and the brightness out
of it). So a look wins over the shape block, and high contrast and the custom
accent win over every redesign colour block. Do not quote the light or look
selectors in a comment in `index.css`: the bench finds blocks by regex.

| Token | Toggle off | Redesign |
|---|---|---|
| `--radius-tick` / `control` / `card` / `panel` | 3 / 6 / 8 / 16 px | 4 / 10 / 14 / 20 px |
| `--radius-row` (new) | `--radius-control` | pill |
| `--radius-pane` (new) | `--radius-panel` | 16 px (a dialog keeps `--radius-panel`, 20 px) |
| `--type-title-font` (new) | `--font-sans` | `--font-display` (Gabarito) |
| `--type-body-leading` | 20px | 22px |
| `--control-row` (new) | 32px | 36px |
| `--space-gutter` (new) | 0 | 8px (0 under 768px, where the frame stops floating) |
| `--space-pane` (new) | 16px | 16px |
| `--duration-fast` / `base` / `slow` | 150 / 200 / 300 ms | 120 / 180 / 280 ms |
| `--icon-sm` / `md` / `lg` (new) | 16 / 20 / 24 px | same |
| `--icon-stroke` (new) | 2 | 2.25 |
| `--elevation-3-shadow` | `--shadow-2` | `--shadow-3` |

### The shell and row roles

New colour roles, in `@theme`. Nothing draws them with the toggle off. Each
one is derived from roles every look already sets, so every look, the custom
accent and high contrast get them without restating anything.

| Role | Use | Derived from |
|---|---|---|
| `canvas` | The frame the panes float on, behind the rail | Dark: `surface-0` mixed 25% toward black. Light: `surface-1` mixed 10% toward the text |
| `pane-side` | Channel list, member list, conversation list | Dark: between `surface-1` and `surface-0` (60/40). Light: `surface-1` |
| `pane-main` | The conversation, always the brightest pane | Dark: `surface-1`. Light: `surface-0` |
| `row-hover` | A list row under the pointer | Dark: `pane-main` mixed 6% toward the text. Light: `pane-side` mixed 5% toward the text. It differs from both panes |
| `row-selected` / `on-row-selected` | The current row and its label | `accent-soft` (deepened toward the accent in light) / `accent-text` in dark, `text` in light |
| `accent-text` | The accent used as text: a link, "Na call", a count | `on-accent-soft` mixed 15% toward the text |
| `success-text` | Success used as text | `on-success-soft` mixed 15% toward the text |
| `mention-row` / `mention-bar` | A message that pings you, and its left bar | `accent-soft` 45% over `pane-main` (all of `accent-soft` in light) / `accent` |
| `mention-chip` / `on-mention-chip` | The `@name` chip | `accent-soft` / `on-accent-soft` (both deepened in light) |

Night and the seasonal looks are dark only (`appearanceForcesDark` in
`lib/appearance.ts`), so their light blocks never apply.

States are never told apart by colour alone:

- Hover is a fill (`row-hover`).
- Selected is the accent's soft fill (`row-selected`).
- Unread is the body text colour at weight 600, plus the `indicator` pip.

The mixes are `color-mix(in oklab, …)`. The bench and the sheet both read that
form, so a derived role is measured like any other.

### The server rail

`layout/server-rail.tsx`, on the canvas with no edge (`RAIL_REDESIGN` in
`ui/pane.ts`). Under the redesign:

- Every tile is a 44px circle (`--rail-tile`) in the side pane's colour
  (`--rail-tile-bg`). The monogram is 13px semibold in secondary text; the
  Conversas caption under its tile is 11px semibold.
- The selected tile is the accent's rounded square
  (`--rail-tile-radius-selected`, 16px) with a short drop
  (`--rail-tile-shadow`). A face (a pinned or waiting conversation) stays
  round and takes an accent ring instead, because its photo fills the tile.
- A hover lifts the fill (`--rail-tile-hover`) and rounds the tile toward the
  selected square. It never turns lime: a lime tile fill only means "you
  are here". Small lime marks (a friend request count, a Baú count, the
  Novidades and update dots) mean "new for you", and they never fill a tile.
- Every door, join included, sits on the same disc (`--rail-tile-bg`).
- The pip on the left edge is the text colour: tall for selected, a dot for
  unread.
- The Baú's ring (new posts beside a mention) hugs the disc with no gap, like
  a story ring. Keyboard focus is a ring with a gap in the text colour, so it
  never reads as a chosen face or the Baú.
- Counts are `CountBadge` with a ring cut from the canvas. The public globe
  and the live dot sit on canvas discs at the lower corners; the live dot is
  solid, never pulsing.
- Every door is one 44px tile, the update tile included.
- Glyphs are filled Phosphor objects; `+` is a bold symbol.

### The sidebar header

The top of the channel list (`layout/channel-list.tsx`). Under the
redesign:

- No rule under it. The server's name is the title face at 16px bold
  (`--sidebar-header-title-size`), with no icon (the open server's tile is
  right beside it on the rail). The caret sits right after the name. The
  row is a 44px pill on `row-hover` when hovered, a step stronger (text at
  10%) while the menu is open.
- Members, collapse and close are `IconButton`'s round ghost: 32px from
  `md`, like the chat header's, and 44px on a phone (`HEADER_ICON_BUTTON`).
  On a phone the members button is hidden: the chat header has its own.
- Search is a pill (`--sidebar-search-*`): a text tint off the pane in dark,
  the field's white with its edge in light.
- The banner (`ServerBannerStrip`) is an inset card with
  `--sidebar-banner-radius`.

### The sidebar blocks

The blocks above the channels: stories (`stories/story-strip.tsx`), a watch
party (`watch-party/live-party-block.tsx`) and the Baú
(`community-home/community-home-preview.tsx`). Under the redesign they share
three strings from `ui/sidebar-block.ts`:

- `SIDEBAR_CARD_REDESIGN`: something to look at (a live party, the Baú's
  newest post). The card tint and edge, radius `--sidebar-card-radius`.
- `SIDEBAR_INVITE_REDESIGN`: something to make (start a party, the first
  story, the first Baú post). A dashed edge (`--sidebar-invite-border`), no
  fill until hovered.
- `SIDEBAR_ROW_REDESIGN` and `SIDEBAR_ROW_SELECTED_REDESIGN`: a one-line
  entry, the list row's pill and fills.

The open block takes `row-selected`, like any row. Red stays on the live
badge alone. A party being set up is the one block on `warning-soft`. Section
labels are `SectionLabel`; counts are `CountBadge`.

### The category headers

Three headers fold the channel list: `ChannelSectionHeader` (Texto, Voz,
Pinados, and each category of the classic list), the mixed list's
`MixedCategoryHeader`, and the "Categorias" label. Under the redesign they
share one recipe from `layout/channel-section-header.tsx`:

- `CATEGORY_ROW_REDESIGN`: a 32px pill row whose text brightens on hover, with
  no fill.
- `CATEGORY_LABEL_REDESIGN`: the section label's face. Sentence case, so a
  category keeps the case its owner typed.
- `SectionCaret`: a bold caret that turns when the section folds.
- `CATEGORY_ACTION_REDESIGN` and `SectionActionGlyph`: round 24px actions
  ("+", the lock, the new category) with 14px glyphs.
- `CATEGORY_SUMMARY_REDESIGN`: "3 canais" and the unread dot on a folded
  section.
- `CATEGORY_DROP_INTO_REDESIGN`: a header a dragged channel would drop into.
  `bg-accent-soft`, `text-on-accent-soft`, a 1px inset `ring-accent`, and no
  hover change. The caret follows the label's colour.

A drop target hides the summary and the actions and shows `chrome.dropHere`
("Soltar aqui"); the name is already on the row. The lock is a filled glyph
(an object). The new-category folder keeps the bold outline: filled, its plus
is unreadable at 14px. The classic list always shows "+"; the mixed list shows
it on hover and focus, because it has many more headers.

### The channel row

`ChannelRow` and `SidebarThreadRow` in `layout/channel-list.tsx` keep their
markup (the tooltip on the button, pin and settings beside it, drag). Under
the redesign they take `ui/list-row.tsx`'s tokens:

- A channel is the `sm` list row: 36px (`--list-row-h-sm`), a pill, the row
  roles for hover and selected. A thread is a 32px row under a rule in the
  card edge.
- The unread mark is the end pip (`--list-row-pip`, `bg-indicator`), not the
  bar on the left edge. A mention count (`CountBadge`) replaces the pip.
- The icon (`ChannelIcon`, Phosphor) is 16px in `--list-row-icon`; a
  private padlock keeps the warning colour.
- Pin and settings are round tiles that hover with `--card-row-hover`, so
  they show on a selected row.
- A live watch party room says live with a red dot on its viewer line; the
  "AO VIVO" words stay for a screen reader. "Assistir" is a soft danger pill.
- The room you are in: `bg-success-soft`, with the name, icon and tiles in
  `on-success-soft` and the second line at 80%. It wins over selected. The
  fill says connected (the dot is for a screen reader only), so the end
  column only ever means something is waiting.
- Keyboard focus rings the whole pill in `--list-row-ring`; the row's tiles,
  the thread's X and "Assistir" use the same token.
- `ChannelListSkeleton` draws the same 36px pills, 2px apart.

### The voice row

A voice channel is a channel row (`ChannelRow`). The room you are in takes
`success-soft` with its `on-` text instead of the signal ring, open or not:
icon, name, dot, second line and tiles are all `on-success-soft`. Under it:

- `VoiceOccupantRow` is a 32px list row: the row roles, 13px names, the
  inset `--list-row-ring` focus ring. The speaking ring stays on the avatar,
  with no offset; the glow does the work.
- `VoiceOccupantBadges` take a `tone`: hand, screen and camera in
  `accent-text`, muted and deafened in `danger`. Glyphs are 14px Phosphor
  fill; deafened is `EarSlash` in the bold outline at 16px, so the ear's
  shape survives beside the mic (Phosphor has no headphones with a slash). A queued hand is
  `HandPositionBadge`: the filled hand at 14px and its number at 11px.
- `ChannelMusicCard` is a card on the card tokens with a 28px cover. A title
  that does not fit fades at the right edge.
- The occupants and threads sit under a rule in the card edge.

### Icons

The redesign's icons are Phosphor (`@phosphor-icons/react`), drawn through
`ui/icon.tsx`. One rule picks the weight:

| Kind | Weight | Examples |
|---|---|---|
| `object` | fill | speaker, bell, gear, person, chat |
| `symbol` | bold | `#`, `+`, `@`, caret, cross, search |

A filled `#` or `+` is a solid box, so symbols take the bold outline. Sizes are
the three `--icon-*` tokens. Lucide stays on every surface that is not rebuilt
yet. `--icon-stroke` is the stroke a Lucide icon takes when a primitive passes it.

`IconSwap` draws a Lucide icon with the toggle off and its Phosphor
replacement under the redesign, for a surface whose callers still pass Lucide.
A filled glyph that turns into a blob (two copy squares) takes `symbol`.

### Hints and first run

Every hint renders through `layout/corner-card.tsx`. Under the redesign it
is a popover (`--popover-surface`, `--popover-border`, `--popover-shadow`,
`--popover-radius`) with a round close, glass on a hero. The first-run card
is a pane-radius card; its steps sit in accent-soft wells.
### The music queue

`voice/music-classes.ts` holds the queue's recipe: rows, covers, the search
highlight, icon buttons and headings. The composer's sheet and the drawer
share it, so the two homes look the same under the redesign.

### The settings kit

`components/settings/kit/` builds every tab of user settings. Under the
redesign it uses the merged primitives' tokens:

- A group box is a card (`SETTINGS_GROUP_REDESIGN`): `--card-bg`,
  `--card-border`, the same edge between rows. Rows hover with
  `SETTINGS_ROW_HOVER` (`--card-row-hover`).
- `SettingsBadge` is `ui/Badge` (`new`, `neutral`).
- A notice on its own takes the banner's corners (`--banner-radius`). Info is
  a tint (`--settings-notice-info-bg`), not an outline. A notice in a group
  stays a row.
- A choice card is a card; the chosen one has a 2px accent edge (the accent border plus a 1px inset ring) and a check.
- Icons are Phosphor through `IconSwap`.

### The call

`voice/call-stage.tsx` and its controls, with the recipes in
`voice/call-control-classes.ts` and the `--call-*` tokens. Under the
redesign:

- The open stage sits on `--call-stage-bg`: the canvas grey in light, surface-0
  in dark. Its floating bar is a
  popover: `--call-bar-bg`, `--call-bar-border`, `--call-bar-shadow`.
- A control on the open stage is a 44px round well (`--call-control-bg`,
  hover `--call-control-hover`). Docked in the composer the controls rest as
  ghosts beside the composer's own icons and fill on hover.
- A control that is on (camera, share, music, a raised hand, a pinned video
  size, audience mode) takes the soft accent (`--call-control-on-bg`). A
  muted mic takes the soft danger (`--call-control-off-bg`); a moderator's
  mute takes the soft warning. The hang-up is the one solid red, 64px wide.
- The audience's raise-hand stays the solid accent: it is their one action.
- A tile is `--call-tile-bg` on the card radius (`--call-tile-radius`).
  Whoever is talking gets a 2px ring in `--call-speaking` with a 2px gap cut
  from the stage. The one exception is the single tile that fills the stage:
  there is no stage around it to cut a gap from, so its ring is drawn inset.
- What floats on a picture (the name, "⋯", fullscreen) is dark glass
  (`--call-badge-bg`), the same in both looks. Names are pills; the controls
  are 32px.
- Glyphs are filled Phosphor objects through `IconSwap`; "⋯" and the
  fullscreen corners are bold symbols.

## Components

Everything in `client/src/components/ui/`. Import from `@/components/ui/<name>`.

### Button

`button.tsx`. The one clickable primitive. Built on `class-variance-authority`,
so a variant and a size are props, not class strings.

- **Variants.** `default` (accent fill, semibold, the one primary action on a
  surface), `secondary` (raised surface with a border, for a second action),
  `ghost` (no fill until hover, for a control in a bar or a row), `danger` (the
  soft danger fill, for a destructive confirm), `danger-ghost` (below).
- **Sizes.** `default` (h-9), `sm` (h-8, 12px text, 13px under the redesign), `lg` (h-11, the touch
  size), and the icon squares `icon-sm` (h-8), `icon` (h-9), `icon-lg`
  (h-11). Give `icon-lg` an `<Icon size="lg">`, the others `md` (`sm` for
  `icon-sm`). An icon-only control on its own is `IconButton`; these sizes
  are for one that sits in a row of text buttons.
- **`danger-ghost`.** A destructive action that should not shout ("Deixar de
  seguir", "Remover"): red text, no fill until hover.
- **Under the redesign.** A pill (`--radius-button`), more horizontal room,
  and a lifted primary (a top highlight plus a cast shadow). Secondary,
  ghost and danger-ghost fills are tints of the text or of the danger colour
  (secondary 7% at rest and 15% on hover in dark, 12% in light, with
  `--color-border-strong`;
  ghost 8%; danger-ghost 14%), never a surface, so they read on a pane and
  on a dialog alike. Disabled is `opacity: 0.5`, and a disabled primary is
  switched off: an empty pill in the strong edge, a medium-weight label at
  70% of `text-tertiary`, no shadow and full opacity, so it keeps its
  outline on a dialog and cannot pass for a live button. The rule for any
  call site: disabled means off, never just dimmed. Do not add a
  `disabled:opacity-*` of your own; the primitive owns both recipes. `sm` takes a 13px label. Those
  disabled-only rules are the one place the
  primitive uses `redesign:` classes. Everything else comes from
  `--button-*` component tokens that are unset with the toggle off and fall
  back, inside the class, to the old value, so a call site's own `px-6` or
  `text-danger` still wins through `cn`. Never style a primitive with a
  `redesign:` class: it outranks the call site.
- **States.** Hover, `active:scale-[0.98]`, `focus-visible` ring, disabled
  at `--button-disabled-opacity` (0.4 with the toggle off) with pointer
  events off.
- **`asChild`.** Renders a Radix `Slot`, so a link can wear a button.
- **Ref.** `forwardRef` to the `<button>`, so a caller can move focus to a
  button it just revealed.
- **Use it** for anything that performs an action. **Do not** use it for
  navigation between routes without `asChild` and a real `<a>`, and do not use
  `default` twice on the same surface.
- **Accessibility.** An `icon` button has no text, so it must be wrapped in
  `Tooltip` or given an `aria-label`. Prefer `IconButton`, which requires
  one. A disabled button fires no hover, so its
  explanation cannot live in a native `title`.

### IconButton

`icon-button.tsx`. A control that is only an icon: settings, pin, mute, close.
It wraps `Tooltip`, so `label` is required and is both the tooltip and the
accessible name.

- **Sizes.** `xs` (24px, beside text in a row), `sm` (28px, a row's trailing
  actions), `md` (32px, a header or toolbar, the default), `lg` (36px, beside
  a default `Button`).
- **`touch`.** On by default: the box grows to 44px under 640px. Turn it off
  only inside a dense row that has a larger tap target of its own.
- **`tone="danger"`.** The icon turns red on hover, for remove and leave.
- **`pressed`.** A toggle (mute, pin). It sets `aria-pressed` and, under the
  redesign, the selected row fill with an accent glyph. Only with a fixed
  `label`: a control whose label or icon swaps (expand and collapse) is an
  action, not a toggle. Do not combine it with `tone="danger"`: a pressed toggle
  hovers in the accent, not red.
- **Glyph.** The size owns it: 14, 16, 18 and 20px for xs to lg under the
  redesign (16px at `md` with the toggle off). Pass the icon bare; a class on
  it loses.
- **`disabled`.** Rendered as `aria-disabled`, not the native attribute, so
  the control stays hoverable and focusable and its tooltip can still name
  it. Its handlers are not wired, and a click's default action is
  prevented, so a disabled submit does not submit. A pressed, disabled
  toggle keeps its fill and does not react to hover.
- **Focus.** The 2px ring with a 2px offset; in light under the redesign it
  is the solid accent (`--icon-button-ring`), since a ghost circle has no
  other chrome.
- **`detail`.** A second, quieter line in the tooltip.
- **Under the redesign.** A circle, secondary text at rest, the button's
  text-tint hover (a 20% danger tint for `tone="danger"`), a 2px ring offset
  and a press to 94%, all from `--icon-button-*` tokens with fallbacks in the
  class (see Button). The pressed state is the one set of `redesign:`
  classes, because nothing paints a pressed icon button from outside.
- **Use it** for every icon-only control. **Do not** draw a raw `<button>`
  with an icon, and do not use `Button size="icon"` for a new one: that size
  stays for an icon button that must match a row of text buttons.

### Input

`input.tsx`. A single-line text field, `forwardRef` so a form can focus it.

- One variant, one size: 40px with the toggle off, the default button's
  36px under the redesign (`--input-h`), so a field and its Save line up.
  Error state: pass `aria-invalid`. With the toggle off also pass a
  `border-danger` class; under the redesign `aria-invalid` alone turns the
  edge red.
- **`prefix`.** Fixed text drawn inside the field before the value
  (`pqp.gg/@`), not part of the value. With a prefix the field is a box around
  an unstyled input: the focus ring is on the box (`focus-within`), so the
  prefix is ringed too, `className` goes on the box (`font-mono`,
  `border-danger`), and `aria-invalid="true"` on the input turns the box's
  border red by itself. Without a prefix the markup is the bare input.
- **States.** With the toggle off: placeholder at `text-text-tertiary/70`,
  focus ring, disabled at 50% with `cursor-not-allowed`.
- **Under the redesign.** `--input-*` tokens over one role, `--color-field`:
  the deepest surface in dark (a well below panes and dialogs) and a faint
  tint of the text in light. The edge is `--color-field-border`, checked at
  3:1 on the fill, on a dialog and on the conversation pane in every look
  (the floor for a control's boundary), and grows toward the text on hover.
  The placeholder is the full `text-tertiary`, the prefix `text-secondary`,
  both at 4.5:1. Disabled keeps the edge, drops the fill, dims the value
  to `text-tertiary` and the placeholder and prefix one step further (70%),
  so an empty disabled field never looks like a resting one and a disabled
  value still reads as a value. Invalid adds a faint red tint
  (`--input-invalid-bg`, danger 10% in dark and 6% in light) to the red
  edge; a field that is also disabled draws as disabled. Pair
  `aria-invalid` with visible error text through `aria-describedby`: the
  message is the cue that does not depend on colour. Hover, invalid and disabled are the field's `redesign:`
  classes. Fields are rounded rectangles (`--radius-control`) and actions
  are pills; a field and its button share a height, not a shape. `Textarea` shares the box through
  `FIELD_BOX` and `FIELD_TEXT`.
- **Use it** for every single-line text field. A multi-line value is a
  `Textarea`.
- **Accessibility.** It renders no label. Wrap it in a `<label>` or point one at
  it. A placeholder is not a label.

- **Focus ring.** The field family (Input, Textarea, Select) rings focus in
  `--input-ring`: the shared 60% ring in dark, the solid accent in light,
  where 60% reads about 2.4:1 on the page (IconButton made the same move).

### Select

`select.tsx`. A choice from a short list: a native `<select>` dressed as a
text field, so a phone shows its own picker and e2e specs find options by
value.

- **Sizes.** `md` matches an `Input` (40px off, 36px under the redesign),
  the default; `sm` is a step under it (36px off, 32px under the redesign,
  as a small `Button`).
- **`raised`.** With the toggle off, a `surface-2` fill instead of
  `surface-0`, for the selects that sat on a raised fill (bots, watch
  party). Under the redesign every select takes the field fill.
- **`wrapperClassName`.** Width and margins go on the wrapper (`@lg:w-48`,
  `sm:min-w-[14rem]`, `mt-1.5`); `className` is for the field itself.
- **Under the redesign.** The `Input` box (`FIELD_BOX`), and a Phosphor caret
  in place of the operating system's arrow (`--select-appearance: none`,
  `--select-pr`). With the toggle off it keeps the native arrow.
- **States.** Disabled follows the field: `--input-disabled-opacity: 1`, no
  fill, the value at `text-tertiary` and the caret faded as far as the
  placeholder. The caret is a `peer` of the field: `text-secondary` on hover
  and keyboard focus, `text-danger` when invalid (hover and focus never
  repaint an invalid caret).
- **Use it** for every short list. It replaced `SettingsSelect` and about a
  dozen hand-drawn selects.

### Switch

`switch.tsx`. An independent on/off bit, with the whole row as the hit target.

- Props are `checked`, `onCheckedChange`, `label`, and an optional
  `description`, `title` and `hideLabel`. `hideLabel` keeps the label for
  assistive tech and paints only the track, for a switch that sits beside a
  row that already names the setting.
- **States.** Track goes accent when on, surface with an inset ring when off.
  The off knob is `text-tertiary` in dark; in every light look it is a pale
  `surface-0` knob with a `border-strong` ring, because the grey there reads
  as a dark dot. Disabled dims the track and blocks the pointer.
  `dimRowWhenDisabled` dims the whole row instead (label, description and
  track at 60%, the track not dimmed twice); the settings switch row uses it.
- **Under the redesign.** A 40 by 24 track with an 18px lifted knob. Off is a
  faint text tint inside the field's 3:1 edge (`--switch-off-ring`, the field
  border), so an off switch shows on a card, a dialog and a pane alike, and
  the off knob is `text-secondary`. The row hover is the ghost tint
  (`--choice-row-hover`). A disabled label dims to `text-tertiary` with its
  track, and a `busy` switch keeps its track colour and pulses its knob (it steps back to 60% without motion), with a progress cursor, even in a row that dims when disabled. An off knob in dark is between `text-secondary` and `text-tertiary`. Every value is a `--switch-*` token with today's value as the
  fallback in the class.
- `labelAdornment` draws a badge after the label; `data-*` props land on the
  button. `SwitchTrack` is the track alone, for a row a call site lays out
  itself (the poll composer is still hand-drawn and will move to it).
- **Use it** for a list of independent settings. **Do not** use it for one of
  many; that is a `RadioGroup`.
- **Accessibility.** `role="switch"` with `aria-checked`. A `title` is rendered
  on a wrapper, because a disabled button never fires the hover that would
  summon it. While a write runs pass `busy`, not `disabled`, so focus stays.

### CheckRow

`check-row.tsx`. The same row shape as Switch with a square tick, plus an
optional colour dot. Switch is for a setting; CheckRow is for a checklist, which
is why cargos use it.

- **Under the redesign.** The tick is 18px, off is the same tint and field
  edge as an off switch, and the check is Phosphor bold. Hover strengthens
  the edge. `TickBox` is the tick alone: `size="sm"` (a row) or `md` (20px,
  a tick that is its own 36px target, such as a person in a picker).
- **Accessibility.** `role="checkbox"` with `aria-checked`.

### Checkbox

`checkbox.tsx`. A native `<input type="checkbox">`, for a form or beside a
sentence ("Permitir comentários"): a `<label>` around it toggles it and a
form submits it. A row in a checklist is `CheckRow`; a setting is `Switch`.

- With the toggle off it is the browser's box tinted by `accent-color`, as
  before. Pass `h-auto w-auto accent-auto` to keep the browser's default size
  and tint where a box never had classes.
- Under the redesign `appearance: none` drops the native box and the tick
  tokens draw the same box as `TickBox`, with a Phosphor check over it that
  ignores the pointer.
- `wrapperClassName` takes margins; `className` styles the input.
- Give the `<label>` around it `group/checkbox`: hovering the label then strengthens
  the box's edge, as hovering a CheckRow's row does.
- Also give it `redesign:has-[:disabled]:text-text-tertiary`, so a disabled
  box never sits beside a full-strength label. A hint under the label indents
  by `calc(var(--tick-size)+0.5rem)` under the redesign.

### Sheet

`sheet.tsx`. Not a component: the look of a panel that rises from a phone's
bottom edge. Dialog is a sheet below `sm`; the app launcher and the cinema
stage's picker draw their own.

- With the toggle off each sheet keeps the surface it drew before.
- **Under the redesign.** `SHEET_SURFACE` (a sheet at every width) and
  `SHEET_SURFACE_PHONE` (below `sm` only) give a 24px top radius, the raised
  fill (`surface-2` in dark, `surface-0` in light), a 10% text hairline on
  the top edge only and a shadow cast upwards. `SHEET_SCRIM` is the scrim
  for a sheet that draws its own; a dialog's `--dialog-scrim` and
  `--dialog-scrim-blur` alias the same tokens. Every value is a `--sheet-*` token.
- **Use it** for a new phone panel anchored to the bottom edge. **Do not**
  add a grab handle unless the sheet can be dragged.

### Skeleton

`skeleton.tsx`. A pulsing block at `bg-surface-3/50`, plus three composed
shapes: `ChannelListSkeleton`, `MessageListSkeleton`, `ServerRailSkeleton`.

- **Use it** for a first load whose shape is known. **Do not** use it for an
  action in flight; that is a busy state on the control the user pressed.
- **Accessibility.** A bare `Skeleton` is `aria-hidden`. The composed ones carry
  `aria-busy` and a translated label.

### Toast

`toast.tsx`. Not a component: the look of a note that arrives on its own and
leaves on its own (a DM, a friend who accepted, a forward, an app join, a
session reminder, a watch party approval). Each toast keeps its own corner,
queue, timer and swipe.

- `TOAST_SURFACE` is the popover's card: with the toggle off the level-3
  card the toasts already drew, under the redesign the pane radius, the
  raised fill, the faint edge and the lift. `TOAST_SURFACE_REDESIGN` moves a
  toast that draws its own card (the session reminders, the watch party
  approval) onto the same card under the redesign only.
- `TOAST_CLOSE` is the dismiss button: today's small square with the toggle
  off, IconButton's round ghost with its focus ring under the redesign.
  `TOAST_OPEN_REDESIGN` gives a toast's whole-card button (a DM, a session
  reminder) the same ring. A 32px leading mark sits in the 40px slot
  (`redesign:mx-1`), so the text of stacked toasts lines up.
- **Not toasts.** The retro presence card, the lightbox notice and the Baú
  post hint are notes of their own and stay off this recipe on purpose.
- **Use it** for news the person did not ask for and can ignore. **Do not**
  use it for the result of a write the person just made; say that in the
  row (`InlineStatus`).

### Tooltip

`tooltip.tsx`. `TooltipProvider` is mounted once at the root; every `Tooltip`
needs it as an ancestor.

- **Props.** `label` (the visible text and, by default, the control's accessible
  name), `detail` (a second quieter line, for a control that is genuinely
  non-obvious), `name` (an accessible name that differs from the visible text),
  `side`, `align`, `tone`.
- **Tones.** `default` is the compact label on an icon button. `rail` is the
  larger, semibold bubble the server rail uses, in the title face under the
  redesign; there it shares the default's colours, radius and shadow. It is
  semibold (`--tooltip-rail-weight: 600`) because it names a server: a step
  under the bold server name in its pane title, above the medium default
  label (`--tooltip-weight: 500`). Its padding and size are tokens
  (`--tooltip-rail-px`, `-py`, `-size`), and it sits 14px from the tile.
- **`mark`.** A rail bubble that names a place (a server tile, a pinned
  conversation, the conversations home) passes `mark`: under the redesign it
  carries a short straight 3px accent bar on its start edge
  (`--tooltip-rail-mark`), mixed toward the label in light so it stays bright
  on the dark bubble. An action on the rail ("Criar comunidade") stays plain.
- **Behaviour.** 260ms before the first bubble of a group, then 500ms of no
  delay for its neighbours, so a control bar can be swept and read. Inert on
  touch, so a tap is never eaten. Portalled into the fullscreen element when one
  is open, or the tooltip would be painted where nothing can see it.
- **Under the redesign.** Every colour, the radius, the padding and the
  weight come from `--tooltip-*` tokens over four roles: `--color-tooltip`,
  `--color-tooltip-border`, `--color-on-tooltip`, `--color-tooltip-detail`.
  In dark the bubble sits below the deepest surface, so it parts from panes
  and dialogs by its fill, with a soft edge (text 18% over the bubble) and a
  faint top highlight; in light it is inverted (a dark bubble), since a white
  one vanishes into a white page. The label is medium weight; the detail
  line sits 2px under it at a 1.25 line height. The bench checks the label and the detail
  at 4.5:1 in every look.
- **Hand-placed bubbles.** A bubble that cannot use Radix (the reaction tip,
  the locked-look hint) reads the same tokens with its own fallbacks, so the
  redesign has one bubble. `tooltipBubbleClass()` and `TOOLTIP_DETAIL` draw a
  static one, as `/qa/ui` does.
- **Use it** for every icon-only control. **Do not** put a link or a control
  inside one; the bubble is `pointer-events-none`.
- **Accessibility.** With a `detail`, the description is the detail only. Without
  one, the trigger's `aria-describedby` is dropped rather than pointed at a copy
  of its own name, so nothing is announced twice.

### Dialog

`dialog.tsx`. The one modal. Focus trap, Escape, focus restoration, scroll lock,
and a layer sized to `visualViewport` rather than to `vh`, because no browser
shrinks `vh` for an on-screen keyboard.

- **Props.** `title`, `eyebrow`, `description`, `footer`, `size`
  (`sm` | `md` | `lg` | `xl` | `2xl` | `full`), `fill`, `closeOnBackdrop`, `dismissible`.
- **`2xl`** is the settings width (yours, the server's and a channel's): a
  section rail beside a pane of forms needs more room than any other dialog.
  With `fill` it is at most 56rem tall, so it does not run the height of a
  tall monitor; each pane scrolls inside it.
- **`full`** is for a flow that is its own place rather than a question, such
  as creating a server bot: the widest panel, used with `fill`. It is never
  opened on top of another dialog.
- **`fill`** gives the panel the layer's height and stops the body scrolling as
  one column, for a dialog whose content is its own layout.
- **`dismissible={false}`** removes the close button, Escape and the backdrop
  together. An X that does nothing reads as a bug.
- **The close button** is the control ladder's icon button (`--control-md`, 36px,
  what `Button size="icon"` draws), with negative margins so it adds nothing to
  the header's height and the glyph stays put. On a phone a pseudo-element reaches
  4px past the box on every side, so the touch target is 44px.
- **Accessibility.** `role="dialog"`, `aria-modal`, labelled by its title and
  described by its description. Escape is stopped from reaching a menu inside.

- **Under the redesign.** A deeper scrim with more blur (62% of near-black
  in dark, a 30% grey in light). The panel takes a 10% text edge in both
  themes and the deepest lift, through the elevation variables. The header
  loses its rule and keeps 8px under the title; the footer's rule is an 8%
  text tint. The inset is 24px, the title 22px, with 20px above the header
  and below the footer. The eyebrow is sentence case at 13px; the
  description is `text-secondary`. The close button is IconButton's ghost,
  with its focus ring and an 18px glyph. A dialog with no body (a confirm)
  keeps 16px under the question, drops the footer rule and keeps 8px above
  the buttons, so the question and its answers read as one block.
  The close button draws as IconButton's ghost (round, `text-secondary`, the
  text-tint hover). Every value is a `--dialog-*` token with the old value
  as its fallback. PromptDialog's field labels are sentence case too.

### ConfirmDialog

`confirm-dialog.tsx`. The in-app replacement for `window.confirm`. Two
equal-width footer tiles so both labels stay readable. `destructive` (default
true) picks the danger button and moves the autofocus to Cancel.

### PromptDialog

`prompt-dialog.tsx`. One name field, an optional second free-text field and an
optional checkbox. Exports `sanitizeChannelName`, which folds accents rather than
stripping them, because a Brazilian keyboard produces them by reflex. Guards
against a double Enter creating two channels.

### ContextMenu

`context-menu.tsx`. A Radix context menu with a fixed row shape, an optional
one-row quick-reaction strip, icons, ticks, separators and danger rows. Measures
itself on mount and flips above the pointer when it does not fit below.

- **Use it** for a right-click or long-press menu. For a plain click, use
  `Menu` below — the two share their row rendering (`menu-items.tsx`), so an
  item never drifts between the surfaces that both offer it.

### Menu

`menu.tsx`. A Radix dropdown menu, click-triggered, drawing the same
`ContextMenuItemDef[]` row shape as `ContextMenu` through the shared
`MenuItemRows` in `menu-items.tsx`.

- **Use it** for a chevron, a `⋮`, or any control that opens a menu on a
  plain click rather than a right-click or long-press.
- `topContent` renders non-interactive content above the items, with its own
  trailing separator — a fact about the surface the menu belongs to, not an
  action. The server header's "Público" row is the first caller.
- `items.length === 0` (or `disabled`) renders the trigger alone, same as
  `ContextMenu`.

Both menus, and a hand-built one that cannot be a Radix menu (the
composer's "+"), draw from one recipe in `menu-items.tsx`: `MENU_SURFACE`,
`MENU_ROW` (Radix rows), `MENU_ROW_BUTTON` (button rows), `MENU_ICON` and
`MENU_SEPARATOR`. A new menu uses them; it does not copy their classes.

- **Under the redesign.** The highlighted row is a 9% text tint (7% in
  light); the old highlight was the menu surface's own colour and did not
  show. Rows sit concentric inside the panel (the panel's radius minus its
  6px pad) and are 34px tall. Icons are 16px in `text-secondary` and come up
  to the label's colour on the highlighted row; a danger row's icon stays
  red. Headings are sentence case, 12px semibold in `text-secondary` (medium
  would sit too close to the 14px rows). A disabled row fades its icon and
  label to 0.5 and its hint to 0.7. Groups are 6px apart, the panel's pad,
  and separators are a 10% text tint. The tick is Phosphor's, in the accent.
  In the composer's "+" menu only focus fills a row; the pointer moves
  focus. Every value is a `--menu-*` token with the old value as its
  fallback.

### Popover

`popover.tsx`. The panel an anchored popover floats in: a picker, a small
card of settings, the "what's new" note.

- **Shared.** `POPOVER_SURFACE` (and `PopoverPanel`, the same as an element)
  is the surface only. Each popover keeps its own placement, portal and
  dismissal, because each measures a different anchor.
- **Callers.** The emoji and GIF pickers, the update note, the soundboard,
  the forum icon picker and the music speaker panel. The profile popover
  and the peer audio card still draw an older `ink-2` panel; they move with
  their surfaces.
- **Under the redesign.** The pane radius (16px), its own fill
  (`surface-2` in dark, the brightest surface in light so the panel reads
  lifted rather than sunk), a 10% text edge in both themes, and a lift
  (`--shadow-2`, one rung under a dialog) with a top highlight in dark, a
  close and a wide shadow in light. The edge and the lift are set through
  `--elevation-3-border` and `--elevation-3-shadow` on the panel, so a
  caller that sets its own fill or edge keeps it.
- A caller that draws its own edge adds `POPOVER_OWN_EDGE`, so its edge is
  the popover's whatever order the classes land in.
- The emoji picker fills its panel: no inner corner or shadow, 38px cells
  so eight fill its width, 6px under its category bar. Its fill is
  `--rgb-picker-background`, an RGB triplet the picker needs; each redesign
  look sets it by hand to its `--popover-surface` (surface-2 in dark,
  surface-0 in light), so a look that changes those sets both.
- **Use it** for anything anchored to the control that opened it. A list of
  actions is a `Menu`; a blocking question is a `Dialog`.

### Scrollbars

Native scrolling everywhere; there is no scroll area component (the unused
Radix one was deleted with the redesign's `p-scroll`). Under the redesign
the root sets `scrollbar-color` to `--scrollbar-thumb` (tertiary text at
65%, 80% in light: 3.2:1 to 4.3:1 on both panes in Clássico, Catppuccin,
Everforest and Modo 2005, measured in Chromium) on
no track, at the platform's width. A strip that scrolls sideways may hide
its bar (`[scrollbar-width:none]`); a list that scrolls down keeps it at
the platform's width. The one exception is a strip under 6rem tall (the
listener strip's wrapped list, the friends tabs), which may stay `thin`.
The innermost scroller under the pointer (`overflow-y-auto`,
`overflow-auto`, `overflow-x-auto` or a textarea) lifts its thumb to
`--scrollbar-thumb-hover` (secondary text at 80%, 90% in light). A scroller
written another way (`overflow-y-scroll`, an inline style) does not lift;
use one of those classes to opt in. Modo 2005 follows the same rule; its
toolbar hides its bar because it is a sideways strip.

### Textarea

`textarea.tsx`. A multi-line text field, `forwardRef`. The `Input` recipe with
`min-h-28 py-2 resize-y` in place of the fixed height.

- **Use it** for free text that can run past one line: a feedback report, a
  description. **Do not** use it for a single value.
- **Accessibility.** Like `Input`, it renders no label.

### RadioGroup

`radio-group.tsx`. One of a few, with one keyboard model and three shapes.

- **Variants.** `segmented` (two to four short options on one track),
  `chips` (one of many, or tag-like options that wrap), `list` (two to four
  options that each need a description: full-width rows with a radio dot,
  meant to sit as one child of a settings group). Sizes `md` and `sm`
  for `segmented` and `chips` (h-8 and h-7 with 12px text with the toggle
  off; see the redesign bullet).
- **Props.** `value`, `onValueChange`, `options` (`value`, `label`, optional
  `description` and `disabled`), `label` (required, the group's accessible
  name), `variant`, `size`, `disabled`, plus `status` (list only: drawn under
  the checked option, for the write it started), `activation` (`auto`, or
  `manual` where the arrows only move focus and Enter or Space selects, for an
  expensive change like a language reload) and `fit` (segmented only: `equal`
  cells that truncate, or `content` cells sized to their labels that wrap).
- **States (toggle off).** Selected is `bg-surface-2 font-medium text-text`
  on the segmented track and `border-accent bg-accent-soft text-on-accent-soft`
  as a chip. Chips are 32px (28px small). Disabled is `opacity-40` with
  `cursor-not-allowed`.
- **Under the redesign.** The segmented track is a pill of a 6% text tint
  with no border and a raised thumb (a 15% tint with a soft shadow in dark,
  a white chip in light), so the choice reads by shape, not by a shade of
  grey; unselected labels are `text-secondary`. The track sits on the
  control ladder (36px, 32px small) and the focus ring stays inside it. A
  small group's text is 13px, as on a small Button. Chips sit on the same
  ladder (36px, 32px small), take the strong edge and the ghost tint on
  hover, and never change weight when selected, so a chip keeps its width; a
  selected chip's accent edge is 2px (an inset ring), so the choice reads by
  shape as well as hue; a count after a label is 70% of it,
  tabular. The list's dot
  is 18px inside the field's 3:1 edge, and a filled accent disc with an
  `on-accent` centre when selected. Disabled is 0.5, as on Button. Every
  value is a `--segmented-*`, `--chip-*` or `--radio-*` token with today's
  value as its fallback.
- **Use it** for one of many. **Do not** give a segmented option a description;
  the track has no room for it, so use `list`, `chips` or a choice grid.
- **Accessibility.** `role="radiogroup"` with `aria-label`; each option is a
  `button role="radio"` with `aria-checked`. `useRovingRadio`, exported from the
  same file, puts only the checked option in the tab order, moves and selects
  with the arrows on both axes (Home and End too), and skips disabled options.
  When the checked option is disabled, the first enabled one takes the tab stop.

### Tabs

`tabs.tsx`. A row of tabs that switch what one panel shows, with one keyboard
model and four shapes.

- **Variants.** `underline` (`md`: a page's sections, the bot overview),
  `segmented` (`md`: two to four views of one thing, a role; `xs`: the same in
  a popover, a profile's about), `pill` (`md`: a header's lists, friends;
  `xs`: a compact pane header with counts, the call split) and `filled`
  (`sm`: a status filter, the reports queues).
- **Props.** `items` (`id`, `label`, optional `count`, `disabled` and `data`
  for `data-*` hooks), `value`, `onValueChange`, `label` (the tablist's
  accessible name), `variant`, `size`, `panelId` (each tab's
  `aria-controls`), `className` for the list's layout and `tabClassName` for
  layout on every tab.
- **States.** Each shape draws, with the toggle off, what its call sites drew
  before. Only `underline` had a focus ring, so only it draws one with the
  toggle off; the others keep the browser's outline there.
- **Under the redesign.** Unselected labels are `text-secondary`. Pills are
  round and the hover is the ghost tint. A selected pill is an 18% tint (15%
  in light) and medium weight, so it differs from a hovered one by more than
  the fill. The filled filter's unselected chips are a 7% text tint, 12% on
  hover; its selected chip takes `on-accent` text. `segmented` is
  RadioGroup's control: its track and thumb, its 2px gap and 3px pad, its
  cell heights (the control ladder minus the pad) and its ring offset; its
  cells truncate, and the small one is 12px, regular until selected. The
  underline's focus ring is rounded and inset. A count is a 16px
  `accent-soft` pill (a circle for one digit) with `on-accent-soft` text at
  11px, tabular. Disabled follows
  Button's. Every value is a `--tabs-*` or `--segmented-*` token with the old
  value as its fallback.
- **Use it** to switch a panel. **Do not** use it for one of a few values in a
  form (`RadioGroup`) or a settings dialog's side list (`SectionRail`).
- **Accessibility.** `role="tablist"` with `aria-label`; each tab is a
  `button role="tab"` with `aria-selected`. Only the selected tab is in the
  tab order; the arrows on both axes, Home and End move and select, and skip
  a disabled tab. When the selected tab is disabled or missing, the first
  enabled one takes the tab stop.

### Slider

`slider.tsx`. A one-dimensional value on `@radix-ui/react-slider`. Four
variants: `scrub`, `volume`, `edge` (the compact player's fill on a panel's
bottom border) and `hue`.

- **`scrub`.** A 2px track (toggle off; 4px under the redesign). The thumb appears on hover or focus, so a progress
  bar does not grow a knob until someone means to move it. `readOnly` draws the
  same fill with `role="progressbar"` and no thumb: that is the bar a person
  without `MANAGE_MUSIC` sees. `indeterminate` is the same track with no fill,
  used while duration is still unknown.
- **`volume`.** A slightly thicker track with the thumb always visible.
- **`hue`.** A colour wheel: the `--accent-track` gradient is the whole
  track, there is no fill, and the thumb wears the current accent with an
  `on-accent` rim. For the accent picker; it replaces the old native range
  and its `.accent-hue-slider` CSS once Aparência moves to it.
- **States (toggle off).** The fill is `accent` on `surface-3`. Focus uses
  the usual ring. Disabled is 40% opacity.
- **Under the redesign.** The track is a text tint (16% in dark, 13% in
  light), so it shows on a pane, a card and a dialog alike. Scrub is 4px and
  thickens to 6px under a pointer or focus; volume is 6px; hue is 10px. The
  knob is 16px with no edge and a soft shadow in dark, a white knob with a
  hairline in light, and it grows 12% while the slider is held anywhere.
  Hue's knob is 20px; `edge` keeps its 12px knob. A read-only scrub never
  thickens. Focus rings in the solid accent with a transparent offset, as
  IconButton does. Disabled is 0.5, as on Button, and the light knob turns
  grey so it stays visible. Every value is a `--slider-*` token with the old
  value as its fallback.
- **Use it** for playback position and volume. **Do not** use a native
  `<input type="range">` for those; it draws OS chrome and cannot share the
  read-only treatment.
- **Accessibility.** The caller passes `aria-label`. A read-only slider is a
  progress bar, not a slider, so a screen reader does not offer a value change
  that cannot happen.

### SectionRail

`section-rail.tsx`. The settings navigation: a real `role="tablist"` with arrow,
Home and End keys, a vertical rail on desktop and a horizontal strip on phones.
Supports a danger tint and an unsaved-changes dot per section.

### Banner

`banner.tsx`. A strip that states something about the whole app or the
conversation and stays until it stops being true or is dismissed: the
connection dropped, an error, the idle hangup warning, a notice, a timeout.

- **Props.** `tone` (`warning`, `danger`, `success`, `accent`), `edge` (`top`
  under the header, `bottom` above the composer), `icon` (a Phosphor icon,
  drawn only under the redesign). `BannerText` is the message: it takes the
  room the actions leave and, under the redesign, keeps 10rem, so two
  actions wrap under it on a phone. `BannerAction` is its button: `fill` for
  the main way out, `quiet` for a second action, `link` (the default) for
  dismiss; `BannerActions` holds two of them.
- **Toggle off.** The full-width bar each strip drew: a 10% tone fill, a 40%
  tone rule on the inner edge, tone text. A strip whose bar differed passes
  those classes and keeps them.
- **Redesign.** An inset card (16px from the column, 8px on a phone) on the
  look's soft tone fill, with a `--banner-edge` tone border, the message in
  the text colour, and the icon and pill actions in the tone's ink.
- **Use it** for a state of the app or the conversation. **Do not** use it
  for news that arrives on its own (a toast) or for the result of a write
  the person just made (`InlineStatus`).

### BetaTag

`beta-tag.tsx`. The pill next to the wordmark. Two variants: `default` on app
chrome, `hero` on a photograph, where the token colours are invisible and white
at low alpha is the only thing that works. Its copy is not a catalogue key,
because "beta" is the same word in both of this product's languages.

### Badge

`badge.tsx`. A short status word on a card or beside a name: "Novo",
"Resolvido", "Fixado", "Fechado", "OP", "BOT", the "Staff" marker on a forum
tag.

- **Variants.** `new` (solid accent, something the viewer has not seen),
  `accent`, `success`, `warning`, `danger` (the soft pairs), `neutral`
  (`surface-3` with `text-secondary`) and `muted` (the same fill, tertiary
  text: gone, removed). Every variant is a pair the bench already measures;
  there is no opacity wash.
- **Sizes.** `md` (18px, the badge on a card or row) and `tag` (the smaller
  one beside a name in a message header: OP, BOT, AutoMod, Webhook).
- **`icon`.** An optional lucide icon before the word, decorative.
- **Toggle off.** 10px uppercase bold on `--radius-tick`, the geometry each
  caller drew. **Redesign.** A pill in sentence case, 11px semibold
  (`--badge-*`; `md` 20px, `tag` 18px), the variant's pair whatever the
  caller painted (`neutral` and `muted` a step stronger, so 11px clears
  4.5:1 in every look), so every
  tag on a message header is the same shape. The `BetaTag` beside a bot's
  BOT takes the tag's shape there.
- **Use it** for a state. **Do not** use it for a count (`CountBadge`) or
  for the product's own "beta" (`BetaTag`).
- **Accessibility.** The word is the meaning, so colour is never the only
  signal; the icon is `aria-hidden`.

### Card

`card.tsx`. `CARD_SURFACE` is a bounded group inside a pane or a dialog: a
bot's summary, a list of checks, an empty note. The element and padding are
the caller's, beside it in `cn`. Not a popover: a card does not float.

- **Toggle off.** The card radius, the plain border, `surface-card`.
- **Redesign.** In dark the fill and edge are tints of the text
  (`--card-bg` 4%, `--card-border` 8%), so one card lifts a little on a pane
  and on a dialog alike. In light a text tint would darken into a grey tray,
  so the fill is a white wash (`surface-0` at 60%) with a 10% text edge: it
  lifts on a grey dialog, and on the white pane the edge alone sets it off.
- **A list in a card.** Put `CARD_LIST` beside `CARD_SURFACE`: rules between
  rows in the card's edge (the plain border with the toggle off), clipped
  to the corners.
- **Rows.** A row that opens something takes `CARD_ROW_HOVER`; a static row
  (a check, an activity line) takes no hover at all, never a bare
  `hover:bg-surface-2`.
- **Padding** is the caller's, on one scale: `p-3` compact, `p-4` default,
  `px-6 py-8` an empty note, `p-2.5` only inside the profile popover.
- **Between cards** a 12px gap (`gap-3` or `space-y-3`).
- **A row that opens something** inside a card adds `CARD_ROW_HOVER` beside
  its own hover: a text tint over the card's fill, the same on any surface.
- **Body copy** in a card is secondary text under the redesign; tertiary at
  12px on the light card is near the floor.
### UserAvatar

`components/user/user-avatar.tsx`. Every person's picture goes through it:
the URL rules, the monogram fallback and a server bot's live face are in one
place. `StatusDot` (`status-dot.tsx`) draws presence on its corner.

- **Toggle off.** The caller's shape (`rounded`: `md`, `lg`, `full`) and its
  monogram colours (`fallbackClassName`).
- **Redesign.** A person is always a circle, and the monogram sits on one
  neutral disc (`surface-3`, body text, semibold, measured at 4.5:1 in
  every look by the bench); the caller still
  sets its size. A bot keeps its own shape. `ownPalette` keeps the caller's
  colours for an avatar drawn inside a story, which paints in its own
  palette.
- **Presence dot.** Under the redesign a caller puts `StatusDot` at
  `redesign:bottom-0 redesign:right-0`, so its centre sits on the circle's
  edge at 45 degrees instead of hanging off a square's corner.
- **Light.** The monogram disc takes a 1px inner edge (`--avatar-edge`), so
  it stays a disc on the white pane.
- **Dimmed** (offline, muted): under the redesign the letter dims to
  tertiary text and the disc stays, so it still reads on a white pane.
- **Dot cutout.** A pane call site's `StatusDot` ring reads
  `--avatar-dot-ring`: the side pane's colour by default, the conversation
  pane's inside `main`.
- **Stacks** cut their overlap with the same token
  (`ring-[color:var(--avatar-dot-ring)]`).
### CountBadge

`count-badge.tsx`. A number in a pill: unread messages, mentions,
conversations or friend requests waiting. Draws nothing at zero and caps at
"99+".

- **Props.** `count`, `tone` (`danger` default, `accent`), `size` (`md`
  18px, `sm` 16px), `pop` (the arrival animation, re-played for each new
  number). A corner position and a ring against the surface behind it are
  the caller's `className`.
- **Redesign.** 11px semibold with tabular figures (`--count-badge-*`); the
  16px `sm` keeps its height and takes 10px type, so "99+" fits.
- The server rail's and the channel list's counts are drawn in place for
  now; they move here with their shell elements.

### EmptyState

`empty-state.tsx`. What is not here yet, and what to do about it. `page`
fills a pane (an empty channel, a forum with no posts); `inline` sits in a
group or a list (no results, nothing saved; the settings kit's
`SettingsEmpty` is this).

- **Props.** `icon`, `title`, `body`, `actions` (one or two buttons), `role`
  (`status` or `alert` when it replaces content that failed), `data-*`.
- **Toggle off.** Each caller passes the classes it always drew
  (`className`, `iconClassName`, `titleClassName`, `bodyClassName`,
  `actionsClassName`); a caller that drew no icon hides it with
  `hidden redesign:flex`.
- **Redesign.** A page empty state leads with its glyph on a soft disc
  (`--empty-icon-disc` 56px, `--empty-icon-bg` `surface-3`), a Gabarito
  title at `--empty-title-size` (20px), a body line in secondary text, the
  actions 20px under it. An inline one is a quiet glyph, a 14px label in
  secondary text and a 12px line.
- **Failure.** A load that did not come back is a `role="alert"` empty
  state with the retry as its action; under the redesign its disc takes the
  warning tone (`warning-soft`, `on-warning-soft`), so it reads apart from
  an empty list. A page failure with no glyph gets `WarningCircle` there.
- **Copy.** Say what is missing and the next step, in the casual voice.

### Spinner and Skeleton

`spinner.tsx`, `skeleton.tsx`. A spinner says something is on its way (a
send, a save, a search); a skeleton holds the shape of content that is
loading (the channel list, the message log, a settings row).

- **Spinner.** Takes the caller's classes for size, colour and motion, as
  the Lucide `Loader2` it replaces did. With the toggle off that glyph
  draws. Under the redesign a ring draws: a faint track
  (`--spinner-track-opacity` 0.25, 0.3 in light) and an arc in the icon
  stroke. It owns its motion: it turns, and under reduced motion it fades
  in and out instead, because a still arc reads as progress. The ring drops
  any `animate-*` class the caller passes, so that never depends on CSS
  order, and it is 14px at the smallest: below that the stroke is about a
  pixel and the track disappears. `label` adds a screen reader name when
  nothing beside it says "loading".
- **Skeleton.** Toggle off: `surface-3` at 50%, pulsing. Redesign: a text
  tint (`--skeleton-bg`, 8%, 10% in light), so it reads on a pane, a card or a dialog,
  and still under reduced motion. The channel skeleton's rows are the row
  pill at the row height; the message skeleton's avatars are round.
- **Do not** hand-build a spinner (`animate-spin` on a bordered span) or a
  placeholder (`animate-pulse` on a fill).
### PaneHeader and SectionLabel

`section-header.tsx`. `PaneHeader` is the title of a pane that switches by
section (user settings, server settings): the title, one line under it, and
actions on the title line (`actions`, or a slot other code portals into
through `actionsRef`). `SectionLabel` is the small heading over a group in a
list, a popover or a dialog ("Recentes", "Convites ativos", a danger zone).

- **Toggle off.** Each caller passes the classes it always drew
  (`className`, `titleClassName`, `descriptionClassName`) and keeps its look.
- **Redesign.** The redesign classes come last and win. A pane title is
  Gabarito (`--type-title-font`) at `--pane-header-title-size` (20px), the
  line under it body size in secondary text, `--pane-header-gap` (24px)
  below. A section label is semibold sentence case with no tracking, in one
  of two variants (below). `tone="danger"` keeps a danger zone's heading in
  the danger colour on either.
- **Two variants.** `list` (the default) heads rows in a popover, a picker
  or a panel: `--section-label-size` (13px), secondary text,
  `--section-label-gap` (6px) to the first row. `group` heads a group in a
  settings pane: `--section-group-size` (15px) semibold in the text colour,
  a step over the 14px rows and flush with the group's edge. The settings
  kit's `SettingsGroup` title and server settings' group titles are `group`.
- **The face.** Both labels are the sans face with no tracking, and a pane
  title is Gabarito at -0.012em. The unlayered `.font-display` rule outranks
  every utility, and callers pass `font-display` as a toggle-off class, so
  the primitive sets the face and the tracking with `!`.
  `e2e/section-label-face.spec.ts` checks the computed face.
- **Copy.** Write a label in sentence case. The old look upper-cases it with
  CSS (on a span or heading, never on a button, which resets it).
- **Not these.** A field's label over an input is the input's; a channel
  category is a fold control (`ChannelSectionHeader`, `s-category`).
### ListRow

`list-row.tsx`. A row in a list: a channel, a person, a conversation, a
thread, a follow. `leading` (an icon or an avatar), the label, `detail` (a
second line), `trailing` (a time or a mark, inside the row's button, so
nothing interactive), `count` (a `CountBadge`; it replaces the pip) and `action` (a control of its own: the row becomes a
wrapper with the button and the action side by side). Sizes `sm` (a
channel), `md` (a person), `lg` (a person or conversation with a second
line).

- **States.** Hover is a fill; `selected` is the row-selected role with its
  own label colour and `aria-current` (a selected row is the one being
  read, so it drops the unread look); `unread` is weight 600 plus the
  indicator pip at the end, 8px under the redesign (a `count` replaces it; a `trailing` time keeps either beside it, or over it on an `lg` row); `muted` fades
  the row (0.5, 0.6 under the redesign, so it stays above disabled at 0.4).
- **Tokens.** Every value is `--list-row-*` with the old value as its
  fallback. Under the redesign: a pill, 36/44/52px tall, 12px inside, on
  `row-hover` and `row-selected`.
- **Adopting it.** A shell row passes its old colours through `className`,
  so the toggle off draws what it drew. The channel, member, conversation
  and friend rows move onto it with their shell elements.
- **Muted** also passes a mark in `trailing` (`BellSlash`, `sm`), so it is
  not told apart from disabled by opacity alone.
- **Selected.** The second line and a trailing time take the selected
  label's colour under the redesign (tertiary falls under 4.5:1 on the
  selected fill in several looks), and so does the action; the pip and a
  count are not drawn.
- **Focus** is a 2px inset ring in the solid accent (`--list-row-ring`).
- **Unread for a screen reader.** The pip is `aria-hidden`; put the state in
  the row's name (an `sr-only` "não lida"), once, in the row that adopts it.
- **Unread mark.** The end pip (or a count) is the one unread mark; the
  sidebar's left-edge bar goes when the channel row adopts `ListRow`.
- **Navigation.** A channel or a conversation row passes
  `aria-current="page"`; the default `"true"` gives way to it.
- **Disabled with an action.** The action is `inert`, out of pointer and
  keyboard reach.

## Planned primitives

Not built. Do not invent a local one; add it here instead, in `ui/`, with a
variant set, and then use it everywhere.

- **Toast.** The animations (`animate-toast-in`, `animate-toast-out`) exist in
  `index.css` and each caller draws its own container.

## Rules

1. **Every value is a token.** A colour, a radius, a duration or a shadow in a
   component is a token reference, not a literal.
2. **No colour literal outside `index.css`.** Not in a `.ts`, `.tsx`, `.css` or
   `.html` file under `client/src/`. If a value has to be computed, put the
   colour in `index.css` and the arithmetic with the component, the way
   `--community-tint-*` and `--hero-tint-*` already split.
3. **New UI composes `ui/`.** A screen does not hand-roll a button, a field or a
   modal.
4. **The deprecated aliases are forbidden in new code.** `ink`, `ink-2`,
   `ink-3`, `ink-4`, `paper`, `paper-muted`, `signal`, `signal-dim`,
   `background`, `foreground`, `muted`, `panel`, `panel-hover`, `channel`, and
   now `text-muted` and `text-subtle`, still resolve, so the rest of the app
   keeps working, but nothing new may use them. The alias block at the top of
   `index.css` is the mapping.
5. **UI copy is a catalogue key.** i18next, flat dotted keys, single-brace
   `{slots}`, `_one` / `_other` families, and both `en` and `pt-BR`. See
   `docs/I18N.md`. No em dash reaches a user, in either language.

### How the bench enforces this

`pnpm --filter @pqp/client bench:tokens` runs `client/bench/theme-tokens.mjs` in
CI (`.github/workflows/ci.yml`). It writes `bench/results/theme-tokens.json` and
reports seven numbers.

| Number | Rule | Behaviour |
|---|---|---|
| `contrast` | 20 foreground and background pairs in every theme, plus 20 pairs for the redesign's roles on every `redesign-*` theme (each look with the toggle on). 106 theme combinations in all | Always fails on a regression |
| `steps` | 8 pairs of fills that must stay visibly apart, as an OKLab distance (canvas to pane, hover to pane, selected to hover, selected to pane, mention to pane, chip to mention), on every `redesign-*` theme | Always fails, and an unmeasurable step fails too |
| `order` | The pane rule as an order: canvas darker than the side pane, conversation at least as bright as the side pane (OKLab lightness), on every `redesign-*` theme | Always fails. A distance alone let a look swap its panes and pass |
| `leaks` | Rule 2, counted across `client/src` | Ratchet, pinned by `BENCH_MAX_LEAKS`. It is 0 today |
| `uiAliases` | Rule 4, counted inside `client/src/components/ui/` | Gate at 0. `BENCH_MAX_UI_ALIASES` is an escape hatch for a half-finished migration, not a setting |
| `uiStatics` | Rule 1, counted inside `client/src/components/ui/`: Tailwind's own static radius, duration and shadow utilities (`rounded-md`, `duration-150`, `shadow-2xl`). `rounded-full` is exempt, because the pill is documented above as a static utility | Gate at 0, with `BENCH_MAX_UI_STATICS` as the same kind of escape hatch |
| `tokenDrift` | Every role token in `index.css` is listed in `client/src/lib/design-tokens.ts`, and every name listed there is still defined in the CSS | Always fails. The sheet is a hand-written mirror, so drift means `/qa/ui` quietly stopped showing part of the system |

A contrast pair whose colour cannot be parsed is reported as "not defined yet"
and does **not** fail the run. The bench reads a plain `oklch()` and
`color-mix(in oklab, …)` (nested, with `var()` filled in). Any other form sails
through unmeasured, so write a scored value in one of those two. Read the
`contrast: X/X pass` line and check that it grew, not the missing count.

The alias and static-utility counts are scoped to `ui/` because the rest of the app still carries
hundreds of them and codemodding it is a separate change. The primitives are the
reference every other surface is copied from, so an `ink` or `signal` name there
teaches the wrong name to the next component.

The contrast maths lives in `bench/lib/color.mjs`, dependency-free so a library
upgrade cannot silently change what a ratio means.

## Reference page

`/qa/ui` renders the whole system: the redesign switch (the same one as
Settings > Beta), a theme, look and contrast switcher that flips the same
attributes Settings does, a specimen of the app shell built from tokens only
(canvas, rail, side pane with every row state, conversation with a mention,
composer), every colour role with its live WCAG
ratio against `surface-0` and `surface-1`, a chip per soft fill showing its
`on-` foreground and the pair's own ratio, the type ramp, the spacing, radius,
elevation and shadow-ladder samples, the icon set at each size, the motion
samples, the control ladder,
every primitive in every variant, and the settings kit
(`client/src/components/settings/kit/`): every block a Settings tab is built
from, on the pane surface the dialog uses. Light and dark cannot render side by
side, because the role tokens live on `:root`; the theme switcher at the top
flips the kit with the rest of the page.

It reads every value from the live document with `getComputedStyle`, so it
scores the theme the viewer actually has on and holds no second copy of the
palette.

It renders only when `VITE_DEV_AUTH_BYPASS` is `true`. On any other build it
redirects the way an unknown path does. There is no client-side instance
moderator signal to check instead; if one is added, this gate should take it too.

The route is `/qa/ui`, a sibling of `/app/*` in `client/src/main.tsx`, not a path
inside the app shell. `/app` has no react-router children, it parses its own path
in `lib/app-route.ts`, and the sheet has to render without an account, a socket
or a bootstrapped shell. It sits outside the `DarkRoutes` layout, because
switching brightness is half of what the page is for.
