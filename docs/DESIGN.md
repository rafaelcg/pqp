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
   rule in this file that can be counted is counted by `bench/theme-tokens.mjs`.

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
| Surfaces | `surface-0`, `surface-1`, `surface-2`, `surface-3`, `rail` |
| Borders | `border`, `border-strong` |
| Text | `text`, `text-secondary`, `text-tertiary` |
| Accent | `accent`, `accent-hover`, `on-accent` |
| Status | `danger`, `warning`, `success` |
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
than the panel in light themes. `on-accent` exists because the accent is bright
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
| `--radius-control` | 6px | Button, Input, menu row, Skeleton, tooltip |
| `--radius-card` | 8px | Menu and tooltip containers, a card |
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
| `elevation-3` | `surface-2` | per theme | `--shadow-3` | Anything floating: popover, menu, dialog |

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

A theme that wants no edge at a level sets the border to `transparent` rather
than dropping it, so the 1px of geometry is the same in every theme. Light does
that at level 3, where `--shadow-3` already separates a floating panel from a
white page and a hairline on top reads as a box in a box. High contrast puts a
`border-strong` edge back at level 3, in both brightnesses.

Who is on which level today: `Dialog`, `ContextMenu` and the default `Tooltip`
bubble are level 3. `PromptDialog` renders a `Dialog` and inherits it. The
tooltip's `rail` tone keeps its own darker shell (`surface-0` with a `surface-2`
edge) and is a deliberate exception, not an un-migrated one. Nothing in `ui/`
draws a level 1 or 2 card yet.

`elevation-*` writes `box-shadow` directly, and so does a Tailwind ring. Do not
put a focus ring and an elevation level on the same element; put the ring on the
control inside.

The ladder itself is still `--shadow-1`, `--shadow-2` and `--shadow-3`, and all
three are theme values: a black shadow reads as dirt on a light page, so the
light block redefines them in the surface colour rather than in black.

`--shadow-popover` is an alias for `--shadow-2` and is kept because component
files outside `ui/` already spell it. Set the level in a theme and every consumer
follows. The purpose-built shadows that are not part of the ladder
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
  Text controls also lift `text-text-muted` to `text-text`.
- **Active.** `active:scale-[0.98]` on Button. Nothing else presses.
- **Disabled.** `disabled:pointer-events-none disabled:opacity-40` on Button,
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

Touch targets: a row control (Switch, CheckRow) makes the whole row the hit
target rather than shipping a 16px native tick. A tooltip is inert on touch by
design, so any explanation a phone user needs is said out loud on the surface.

## Components

Everything in `client/src/components/ui/`. Import from `@/components/ui/<name>`.

### Button

`button.tsx`. The one clickable primitive. Built on `class-variance-authority`,
so a variant and a size are props, not class strings.

- **Variants.** `default` (accent fill, semibold, the one primary action on a
  surface), `secondary` (raised surface with a border, for a second action),
  `ghost` (no fill until hover, for a control in a bar or a row), `danger` (the
  soft danger fill, for a destructive confirm).
- **Sizes.** `default` (h-9), `sm` (h-8, 12px text), `icon` (h-9 square).
- **States.** Hover, `active:scale-[0.98]`, `focus-visible` ring,
  `disabled:opacity-40` with pointer events off.
- **`asChild`.** Renders a Radix `Slot`, so a link can wear a button.
- **Use it** for anything that performs an action. **Do not** use it for
  navigation between routes without `asChild` and a real `<a>`, and do not use
  `default` twice on the same surface.
- **Accessibility.** An `icon` button has no text, so it must be wrapped in
  `Tooltip` or given an `aria-label`. A disabled button fires no hover, so its
  explanation cannot live in a native `title`.

### Input

`input.tsx`. A single-line text field, `forwardRef` so a form can focus it.

- One variant, one size (h-10). Error state is the caller's: pass
  `aria-invalid` and a `border-danger` class.
- **States.** Placeholder at `text-text-tertiary/70`, focus ring, disabled at 50%
  with `cursor-not-allowed`.
- **Use it** for every text field. **Do not** use it for a multi-line value;
  there is no Textarea yet (see Planned primitives).
- **Accessibility.** It renders no label. Wrap it in a `<label>` or point one at
  it. A placeholder is not a label.

### Switch

`switch.tsx`. An independent on/off bit, with the whole row as the hit target.

- Props are `checked`, `onCheckedChange`, `label`, and an optional
  `description` and `title`.
- **States.** Track goes accent when on, surface with an inset ring when off.
  Disabled dims the track and blocks the pointer.
- **Use it** for a list of independent settings. **Do not** use it for one of
  many; that is a radio group, which does not exist yet.
- **Accessibility.** `role="switch"` with `aria-checked`. A `title` is rendered
  on a wrapper, because a disabled button never fires the hover that would
  summon it.

### CheckRow

`check-row.tsx`. The same row shape as Switch with a square tick, plus an
optional colour dot. Switch is for a setting; CheckRow is for a checklist, which
is why cargos use it.

- **Accessibility.** `role="checkbox"` with `aria-checked`.

### Skeleton

`skeleton.tsx`. A pulsing block at `bg-surface-3/50`, plus three composed
shapes: `ChannelListSkeleton`, `MessageListSkeleton`, `ServerRailSkeleton`.

- **Use it** for a first load whose shape is known. **Do not** use it for an
  action in flight; that is a busy state on the control the user pressed.
- **Accessibility.** A bare `Skeleton` is `aria-hidden`. The composed ones carry
  `aria-busy` and a translated label.

### Tooltip

`tooltip.tsx`. `TooltipProvider` is mounted once at the root; every `Tooltip`
needs it as an ancestor.

- **Props.** `label` (the visible text and, by default, the control's accessible
  name), `detail` (a second quieter line, for a control that is genuinely
  non-obvious), `name` (an accessible name that differs from the visible text),
  `side`, `align`, `tone`.
- **Tones.** `default` is the compact label on an icon button. `rail` is the
  larger, darker bubble the server rail uses.
- **Behaviour.** 260ms before the first bubble of a group, then 500ms of no
  delay for its neighbours, so a control bar can be swept and read. Inert on
  touch, so a tap is never eaten. Portalled into the fullscreen element when one
  is open, or the tooltip would be painted where nothing can see it.
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
  (`sm` | `md` | `lg` | `xl`), `fill`, `closeOnBackdrop`, `dismissible`.
- **`fill`** gives the panel the layer's height and stops the body scrolling as
  one column, for a dialog whose content is its own layout.
- **`dismissible={false}`** removes the close button, Escape and the backdrop
  together. An X that does nothing reads as a bug.
- **Accessibility.** `role="dialog"`, `aria-modal`, labelled by its title and
  described by its description. Escape is stopped from reaching a menu inside.

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

- **Use it** for a right-click or long-press menu. There is no click-triggered
  dropdown menu (see Planned primitives).

### ScrollArea

`scroll-area.tsx`. Radix scroll area with a themed thumb. Use it where a native
scrollbar would draw OS chrome over the design.

### SectionRail

`section-rail.tsx`. The settings navigation: a real `role="tablist"` with arrow,
Home and End keys, a vertical rail on desktop and a horizontal strip on phones.
Supports a danger tint and an unsaved-changes dot per section.

### BetaTag

`beta-tag.tsx`. The pill next to the wordmark. Two variants: `default` on app
chrome, `hero` on a photograph, where the token colours are invisible and white
at low alpha is the only thing that works. Its copy is not a catalogue key,
because "beta" is the same word in both of this product's languages.

## Planned primitives

Not built. Do not invent a local one; add it here instead, in `ui/`, with a
variant set, and then use it everywhere.

- **Select.** Native `<select>` is used today. It draws OS chrome, which
  `color-scheme` now at least tints correctly.
- **Radio group.** Settings builds one out of `Button`s today, and so does the
  token sheet.
- **Checkbox.** A bare `<input type="checkbox">` with `accent-[var(--color-accent)]`
  in PromptDialog. `CheckRow` covers the row case only.
- **Textarea.** No multi-line field primitive exists.
- **Tabs.** `SectionRail` is a tablist, but it is settings-shaped and not
  general.
- **Toast.** The animations (`animate-toast-in`, `animate-toast-out`) exist in
  `index.css` and each caller draws its own container.
- **Badge.** `BetaTag` is one badge with one word. There is no general count or
  status badge.
- **Menu.** A click-triggered dropdown. Only the context menu exists.

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
reports three numbers.

| Number | Rule | Behaviour |
|---|---|---|
| `contrast` | 20 foreground and background pairs, in all 40 theme combinations | Always fails on a regression |
| `leaks` | Rule 2, counted across `client/src` | Ratchet, pinned by `BENCH_MAX_LEAKS`. It is 0 today |
| `uiAliases` | Rule 4, counted inside `client/src/components/ui/` | Gate at 0. `BENCH_MAX_UI_ALIASES` is an escape hatch for a half-finished migration, not a setting |

A contrast pair whose colour cannot be parsed is reported as "not defined yet"
and does **not** fail the run, so a `color-mix()` token would sail through
unmeasured. Every value the bench has to score is written as a plain `oklch()`.
Read the `contrast: X/X pass` line and check that it grew, not the missing count.

The alias count is scoped to `ui/` because the rest of the app still carries
hundreds of them and codemodding it is a separate change. The primitives are the
reference every other surface is copied from, so an `ink` or `signal` name there
teaches the wrong name to the next component.

The contrast maths lives in `bench/lib/color.mjs`, dependency-free so a library
upgrade cannot silently change what a ratio means.

## Reference page

`/qa/ui` renders the whole system: a theme, look and contrast switcher that
flips the same attributes Settings does, every colour role with its live WCAG
ratio against `surface-0` and `surface-1`, a chip per soft fill showing its
`on-` foreground and the pair's own ratio, the type ramp, the spacing, radius,
elevation and motion samples, the control ladder, and every primitive in every
variant.

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
