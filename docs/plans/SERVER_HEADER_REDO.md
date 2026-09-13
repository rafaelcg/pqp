# Server header redo

> Status: spec, not built. Written 2026-09-13 against `origin/main` after
> PR #542 was merged and reverted the same hour.
>
> **This spec assumes PR #547 (the revert) has landed.** Its baseline is the
> pre-#542 header. If #547 is still open when you pick this up, land it first;
> do not build this on top of #542.

The surface: the block at the top of the channel column, above `Pinados`.
`client/src/components/layout/channel-list.tsx` draws it,
`client/src/components/layout/server-identity.tsx` supplies the pictures.

---

## 1. What is wrong today, and what #542 got wrong

**The pre-#542 header says the server's name three times.** Once inside the
banner artwork (owners put the name in the picture, because that is what a
banner is for), once again in white text over the bottom of that banner, and a
third time in the row below it, truncated, next to the icon and a raw
untranslated `owner` that CSS uppercased into `OWNER`.

**#542 fixed the repetition and broke the row.** It collapsed the two blocks
into one by drawing the banner as the *background* of the identity row. The
result, in the owner's words, was awful, and for four separate reasons worth
writing down so they are not re-invented:

| What it did | Why it failed |
|---|---|
| Name rendered over the banner photo | Contrast against an arbitrary photograph is not something any token can promise. Every fix is a scrim, and a scrim over somebody's artwork is a worse banner. |
| `line-clamp-2` on the name, sharing the row with a chip and a badge | At a narrow column the name's flex child collapsed and clamped to `PQ`. Two letters. |
| `COMUNIDADE` chip beside the name, `DONO` stacked under it | Three pieces of text competing for one 80px column, none of them the thing you came to read. |
| Four unlabelled icon buttons on the right | 4 × 28px plus gaps is ~120px of a 216px content box, taken from the name. |

The lesson that shapes everything below: **this row has roughly 80 to 160
horizontal pixels for the one string that matters.** Anything else that wants
to live in it is taking those pixels from the server's name.

### How Discord and Slack solve it

- **Slack.** Workspace name, one line, ellipsis, a chevron. No image in the
  sidebar at all. The chevron opens the workspace menu, which is where every
  secondary action lives.
- **Discord.** Guild name, one line, ellipsis, a chevron that rotates to an `×`
  on hover; the whole strip is the dropdown trigger. A guild banner, when there
  is one, is a **separate band above** the name strip — Discord does overlay
  its name on that band, but it also gives the band ~135px and the column a
  fixed 240px, and the name is the only thing on it.

Both converge on: **one name, one line, one chevron, everything else in the
menu.** That is what this spec builds.

---

## 2. The three decisions

### Decision 1 — the banner is a short decorative strip, never a text backdrop

A fixed **72px** band above the identity row, `object-fit: cover`, rendered
**only** when the server has a banner that has loaded. No text over it, no
scrim, no gradient, `aria-hidden`. The row below it keeps the column's own
background and never changes shape whether the band is there or not.

Rejected: dropping the banner from the sidebar entirely and showing it only in
Server Settings and on the public `/c/<slug>` page. It is the cleaner column,
and if the owner prefers it the change is deleting one component call (see
§8). It is not the default because a banner an owner uploaded would then be
invisible to everybody who is actually in the room, which makes the upload
pointless.

Rejected: keeping the `1024 × 480` aspect ratio (120px at a 256px column). 72px
is a decoration; 120px is a second header competing with the channel list for
the fold.

### Decision 2 — the role and the community state leave the header

- **Role.** `DONO` / `Dono` / `owner` does not appear in the header at all. It
  is already on the member card: `user-profile-popover.tsx` draws cargo chips
  through `cardRoleChips` / `displayRoleName`. **No new code is needed for
  this** — it is a deletion. Your own role is one click away on your own card,
  which is where a fact about *you* belongs, not pinned above a channel list
  you look at all day.
- **Community.** No chip beside the name. A non-interactive **`Público`** row
  at the top of the dropdown, above the separator. The dropdown is where a
  fact about the server's visibility can be spelled out in full without
  costing the name a single pixel.

Rejected: a pill under the name "when there is room". "When there is room" is a
container query plus a breakpoint plus a test matrix, to show a word that is
already in the menu.

### Decision 3 — the name is `--type-body-size` in `--font-display`, one line

`font-display text-sm font-bold tracking-tight`, i.e. 14px Gabarito bold. One
line, `truncate`, `min-w-0` on the flex child, tooltip with the full name only
when it actually overflows.

`--type-title-size` (18px, "section headings inside a panel") is the nominal
sidebar-title role and **does not fit this column**: at 18px the name box at a
240px sidebar holds about six characters. 14px in the display family at bold,
against `text-sm` regular in the sans family on every channel row below it, is
still unmistakably the heading of the column.

Rejected: `text-base` (16px), which is what shipped for a year. It is off the
five-role type ladder in `docs/DESIGN.md` and buys about one extra character.
If the owner wants it back it is one class.

---

## 3. Prerequisite: a click-triggered menu primitive

`docs/DESIGN.md` § Planned primitives lists this, in as many words:

> **Menu.** A click-triggered dropdown. Only the context menu exists.

The chevron needs one. Build it before the header.

1. Add `@radix-ui/react-dropdown-menu` to `client/package.json` (the repo
   already depends on `@radix-ui/react-context-menu`, `-tooltip`, `-slot`,
   `-scroll-area`; this is the sibling package, same primitives, ~4kB gz).
2. Extract the row renderer from `client/src/components/ui/context-menu.tsx` —
   the `items.map(...)` block at the bottom of the file, the separator branch,
   the `reserveIcon` computation and the `Check` tick — into
   `client/src/components/ui/menu-items.tsx`, parameterised over the Radix
   `Item` / `Separator` components so both menus render byte-identical rows.
   **Do not copy-paste it.** The two menus show the same `ContextMenuItemDef[]`
   for this header and must never drift.
3. `client/src/components/ui/menu.tsx` exports:

```tsx
export function Menu({
  items,            // ContextMenuItemDef[], the exact type ContextMenu takes
  children,         // the trigger, rendered `asChild`
  align = "start",  // DropdownMenu.Content align
  side = "bottom",
  disabled = false,
  onOpenChange,
}: MenuProps): ReactElement
```

   Content classes are the no-strip branch of `ContextMenu`'s, verbatim:

```
elevation-3 z-[100] max-h-[var(--radix-dropdown-menu-content-available-height)]
overflow-y-auto overscroll-contain rounded-[var(--radius-card)] p-1
animate-fade-in min-w-[11.5rem]
```

   plus `sideOffset={6}`, `collisionPadding={8}`, `data-server-menu=""` on the
   content so a test can address it without matching translated labels.

4. `items.length === 0 || disabled` renders `children` alone, same as
   `ContextMenu` does.

The bench (`pnpm --filter @pqp/client bench:tokens`) gates `uiAliases` and
`uiStatics` at **0** inside `components/ui/`. Both new files are inside `ui/`,
so: no `ink-*`, `paper*`, `signal`, `channel`, `panel*`, `text-muted`,
`text-subtle`; no `rounded-md`, no `duration-150`, no `shadow-2xl`. Write
`rounded-[var(--radius-control)]` and `duration-[var(--duration-fast)]`.

---

## 4. The layout

### Structure

```
<aside>                                  (unchanged)
  <SidebarResizeHandle/>                 (unchanged)
  <ServerBannerStrip/>                   ← new, only when bannerUrl resolves
  <ContextMenu items={headerItems}>      ← right-click, unchanged behaviour
    <div data-server-header>             ← the identity row
      <Menu items={headerItems}>
        <button data-server-menu-trigger> ← icon + name + chevron, ONE control
          <ServerIcon/>  <p>{name}</p>  <ChevronDown/>
        </button>
      </Menu>
      <div data-server-header-actions>
        <Tooltip><button>Users</button></Tooltip>          ← members
        <Tooltip><button>PanelLeftClose</button></Tooltip>  ← collapse, md: only
        <button aria-label=…>X</button>                     ← close, md:hidden
      </div>
    </div>
  </ContextMenu>
```

The banner strip sits **outside** the `ContextMenu`, so a right-click on the
picture does nothing. The whole identity row stays inside it, because
right-click on a server header opening the server menu is behaviour the app
already has and nobody asked to remove.

### The pixel budget

Every number below is fixed except the name, which takes what is left. This is
the whole of the layout maths; there is nothing to eyeball.

| Piece | Class | Width |
|---|---|---|
| Header side padding | `px-3` | 12 + 12 = 24 |
| Server icon | `h-8 w-8` | 32 |
| Icon → name | `gap-2` | 8 |
| **Name** | `min-w-0 flex-1 truncate` | **what remains** |
| Name → chevron | `gap-1` | 4 |
| Chevron | `h-4 w-4 shrink-0` | 16 |
| Trigger inner padding | `px-1 py-1` | 4 + 4 = 8 |
| Trigger → actions | `gap-2` | 8 |
| Action button (desktop) | `h-7 w-7` | 28 |
| Action button (below `md`) | `h-8 w-8` | 32 |
| Between actions | `gap-0.5` | 2 |

Resulting name box, `name = W − 24 − 8 − actions − 8 − 32 − 8 − 16 − 4`:

| Column | Actions | Name box |
|---|---|---|
| 200px (`CHANNEL_SIDEBAR_MIN_WIDTH`) | 28 + 2 + 28 = 58 | **42px** |
| 240px | 58 | **82px** |
| 256px (default) | 58 | **98px** |
| 320px | 58 | **162px** |
| 420px (`CHANNEL_SIDEBAR_MAX_WIDTH`) | 58 | **262px** |
| 256px drawer, 390px phone | 32 + 2 + 32 = 66 | **90px** |

> **The brief said 240–320px. The real range is 200–420px.**
> `client/src/lib/channel-sidebar-width.ts` clamps to
> `[CHANNEL_SIDEBAR_MIN_WIDTH=200, min(CHANNEL_SIDEBAR_MAX_WIDTH=420, 40% of
> the viewport)]`, default 256, dragged by a resize handle and remembered in
> `localStorage`. QA must exercise 200 and 420, not only 240 and 320.

> **The phone drawer is 256px wide, not 390px.** The `<aside>` is
> `w-[min(100%-72px,16rem)]` below `md`, sitting to the right of the 72px
> rail. On a 390px phone that resolves to 256px. It gets a *bigger* name box
> than a 240px desktop column, because it swaps the collapse button (desktop
> only) for the close `×` and gains nothing else.

---

## 5. Wireframes

### 5a. Desktop, 240px, server with a banner

```
├─ 240px ────────────────────────────────────────────┤

┌─────────────────────────────────────────────────────┐
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│ ▲
│▒▒▒  banner, object-cover, object-center  ▒▒▒▒▒▒▒▒▒▒▒│ │ h-18 = 72px
│▒▒▒  aria-hidden, NO text, NO scrim       ▒▒▒▒▒▒▒▒▒▒▒│ │ shrink-0
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│ ▼
├─────────────────────────────────────────────────────┤ border-b border-border
│                                                     │ ▲
│ ╭───────────────────────────────────╮ ╭───╮ ╭───╮   │ │ py-2, min-h-12
│ │ ▪▪ QG do pqp                  ⌄  │ │ 👥│ │ ◧ │   │ │
│ │ 32  ← 82px, truncate →    16     │ │28 │ │28 │   │ │
│ ╰───────────────────────────────────╯ ╰───╯ ╰───╯   │ │
│  ^ data-server-menu-trigger            ^      ^     │ ▼
├─────────────────────────────────────────────────────┤ border-b border-border
│  ┌ Buscar mensagens ─────────────────────────────┐  │
│  └───────────────────────────────────────────────┘  │
│  PINADOS                                            │
│    # broder-do-role                                 │
```

`👥` = `Users` (lucide), tooltip **Membros** / *Members*.
`◧` = `PanelLeftClose`, tooltip **Encolher a lista de canais** / *Collapse the
channel list*, `md:` only.

### 5b. Desktop, 320px, server with no banner

```
├─ 320px ─────────────────────────────────────────────────────────────┤

┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│ ╭──────────────────────────────────────────────────╮ ╭───╮ ╭───╮     │
│ │ ▪▪ Comunidade dos Amigos do R…               ⌄  │ │ 👥│ │ ◧ │     │
│ │ 32   ←        162px, truncate        →  16      │ │   │ │   │     │
│ ╰──────────────────────────────────────────────────╯ ╰───╯ ╰───╯     │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
```

No banner → **no band at all**, not an empty 72px of `surface-2`, not a
placeholder gradient. The column starts at the identity row, exactly as it did
before banners existed.

### 5c. The dropdown, open

```
│ ╭──────────────────────────────────╮
│ │ ▪▪ QG do pqp                 ⌃  │   chevron rotated 180°,
│ ╰──────────────────────────────────╯   trigger held at bg-surface-2
├────────────────────────────────────┐
│  Público                           │ ← only when server.isCommunity.
│  ──────────────────────────────────│    Non-interactive, text-text-tertiary.
│  👤+  Convidar pessoas             │
│  👥   Membros                      │
│  ──────────────────────────────────│ ← only when canManage ||
│  ⚙    Configurações da comunidade  │    canManageMessages
└────────────────────────────────────┘
  min-w-[11.5rem], elevation-3, align="start", sideOffset 6
```

The item list is **`headerItems`, exactly as it is today** — the same array the
right-click context menu already receives, in the same order, with the
`Público` row prepended when the server is a community. Invite and Settings
are no longer buttons in the row; this menu is now their only home in the
header, which is the point of Decision 2's pixel argument.

### 5d. Phone drawer, 390px viewport / 256px drawer

```
├─ 72px rail ─┤├─────────── 256px drawer ────────────────────┤

┌────────────┐┌──────────────────────────────────────────────┐
│  ◉  ◉  ◉   ││▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│ 72px banner
│            ││▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
│  ▪▪  ← the ││▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
│      icon  │├──────────────────────────────────────────────┤
│      is    ││ ╭──────────────────────────╮ ╭────╮ ╭────╮   │
│      also  ││ │ ▪▪ QG do pqp         ⌄  │ │ 👥 │ │ ✕  │   │ min-h-12
│      here  ││ │ 32  ← 90px →     16     │ │ 32 │ │ 32 │   │ 32px targets
│            ││ ╰──────────────────────────╯ ╰────╯ ╰────╯   │
│            │├──────────────────────────────────────────────┤
│            ││  PINADOS                                     │
```

Below `md` the collapse button is gone (`md:block`) and the close `×` appears
(`md:hidden`), so the action count is two either way. Both are **32px** here,
not 28: a 28px target is under the 24px WCAG 2.2 floor only in theory, but a
thumb is not a pointer.

**The server icon stays in the header on phone.** #542's predecessor hid it
below `md` to buy the name pixels; it does not need to any more, because two
buttons left instead of four, and a header whose icon appears and disappears
with the viewport is a header that has to be tested twice.

---

## 6. Every class, by element

Tokens only. `docs/DESIGN.md` Rule 4: `ink-*`, `paper*`, `signal`, `channel`,
`panel*`, `text-muted`, `text-subtle` are **forbidden in new code** even though
they still resolve. The existing header writes several of them; this is a
rewrite, so none survive.

### 6.1 `ServerBannerStrip` (new, in `server-identity.tsx`)

```tsx
export function ServerBannerStrip({
  bannerUrl,
}: { bannerUrl: string | null | undefined }) { … }
```

- Returns `null` when `resolveUploadedImageUrl(bannerUrl)` is falsy **or** the
  URL is currently in the failed set. Reuse `useRetryableImageFailure` from
  #542's `server-identity.tsx` (20s retry so a CDN blip does not permanently
  lose the banner for the session) — recover it from
  `git show bf3d75f6:client/src/components/layout/server-identity.tsx`.
- Container: `<div data-server-banner-strip class="h-18 w-full shrink-0
  overflow-hidden border-b border-border bg-surface-2">`
  (`h-18` = 72px on Tailwind v4's dynamic spacing scale; `h-[72px]` if your
  build does not emit it.)
- Image: `<img src alt="" aria-hidden="true" loading="lazy"
  referrerPolicy="no-referrer" class="h-full w-full object-cover object-center"
  onError={…}>`
- **Nothing else is inside this element.** No `<p>`, no gradient span, no
  absolutely positioned anything. That is the fix; a reviewer should be able to
  confirm it by counting children.
- `bg-surface-2` is what shows for the instant before the image paints, and
  behind a transparent PNG. It is not a placeholder for a missing banner —
  there is no element at all in that case.

`ServerBanner` (the tall one with the name over it, used by the settings-dialog
preview) **stays exactly as it is**. It is a preview of an image, not a header.

### 6.2 Identity row

```
data-server-header
flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-3 py-2
```

`min-h-12` (48px), not `min-h-16`: one line of 14px text beside a 32px icon
needs 48, and the 16px this gives back goes to the channel list.

### 6.3 Menu trigger

```tsx
<button
  type="button"
  data-server-menu-trigger=""
  className="
    flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)]
    px-1 py-1 text-left
    transition-colors duration-[var(--duration-fast)]
    hover:bg-surface-2
    focus-visible:outline-none focus-visible:ring-2
    focus-visible:ring-focus-ring focus-visible:ring-offset-2
    data-[state=open]:bg-surface-2
  "
>
```

- `min-w-0 flex-1` is **load-bearing**. Without `min-w-0` a flex child refuses
  to shrink below its content's intrinsic width, the `truncate` on the name
  never engages, and the row overflows instead. This is not the `PQ` bug —
  that one came from clamping a name that was sharing its box with a chip and
  a badge — but it is the other half of the same family, and both are fixed by
  "one string, `min-w-0`, `truncate`".
- No `focus-visible:ring-offset-*` override is needed: `--color-ring-offset`
  already follows `--color-surface-1`, and `--color-channel` (the column's
  background) *is* `--color-surface-1`. See `client/src/index.css` line 106.
- No `active:scale-*`. `docs/DESIGN.md` § Focus and states: "Active.
  `active:scale-[0.98]` on Button. Nothing else presses."

### 6.4 Server icon

```tsx
<span className="flex h-8 w-8 shrink-0 items-center justify-center
                 overflow-hidden rounded-[var(--radius-control)]
                 bg-surface-2 font-display text-[11px] font-bold text-text">
  <ServerIcon name={server.name} iconUrl={server.iconUrl} />
</span>
```

`ServerIcon` is unchanged: it renders the uploaded image, or
`serverMonogram(name)` (first two characters, uppercased) when there is none or
it fails to load.

### 6.5 The name

```tsx
<p
  ref={nameRef}
  data-server-name=""
  className="min-w-0 flex-1 truncate font-display text-sm font-bold
             tracking-tight leading-tight text-text"
>
  {server.name}
</p>
```

- `truncate` = `overflow-hidden text-ellipsis whitespace-nowrap`. One line,
  always.
- **Never `line-clamp-2`.** Two lines is what put a chip and a badge back in
  play and what made `PQ` possible.
- **Never a `title` attribute.** `docs/DESIGN.md` § Iconography and
  `ui/tooltip.tsx`'s own header explain why: the native tooltip waits a
  second, cannot be styled, and never appears on keyboard focus.

### 6.6 The overflow tooltip

The name gets a `Tooltip` **only when it is actually truncated**, so a short
name does not sprout a bubble that repeats what is already on screen.

Add `client/src/lib/use-is-truncated.ts`:

```ts
/** True while the element's content is wider than its box. */
export function useIsTruncated(
  ref: RefObject<HTMLElement | null>,
  dep: string,
): boolean
```

Implementation is the measure block already proven in
`client/src/components/ui/marquee-text.tsx`: `useLayoutEffect`, compare
`el.scrollWidth > el.clientWidth + 1`, re-measure through a `ResizeObserver` on
the element, disconnect on cleanup, re-run when `dep` (the name) changes. The
`+ 1` is not cosmetic — sub-pixel layout makes `scrollWidth` exceed
`clientWidth` by a fraction on boxes that fit perfectly.

Then:

```tsx
{truncated
  ? <Tooltip label={server.name} side="bottom">{nameNode}</Tooltip>
  : nameNode}
```

`Tooltip` sets `aria-label` on its trigger, so a screen reader hears the full
name in the truncated case and the rendered text (which is the full name) in
the other. Either way the complete name is available; it is never only
`QG d…`.

### 6.7 Chevron

```tsx
<ChevronDown
  aria-hidden="true"
  className="h-4 w-4 shrink-0 text-text-tertiary
             transition-transform duration-[var(--duration-fast)]
             group-data-[state=open]:rotate-180"
/>
```

Put `group` on the trigger button so `group-data-[state=open]` reaches it.
`prefers-reduced-motion` is handled globally for keyframed animations only, and
a 150ms transform is inside the budget the rest of the app already uses.

### 6.8 Action buttons

Both visible actions are the same control, differing only in icon, label and
breakpoint.

```tsx
<Tooltip label={…} detail={…}>
  <button
    type="button"
    className="
      flex h-8 w-8 shrink-0 items-center justify-center
      rounded-[var(--radius-control)] text-text-tertiary
      transition-colors duration-[var(--duration-fast)]
      hover:bg-surface-2 hover:text-text
      focus-visible:outline-none focus-visible:ring-2
      focus-visible:ring-focus-ring focus-visible:ring-offset-2
      md:h-7 md:w-7
    "
  >
    <Icon className="h-4 w-4" aria-hidden="true" />
  </button>
</Tooltip>
```

| Control | Icon | Shown | `aria-label` source |
|---|---|---|---|
| Members | `Users` | always (with a server) | `Tooltip label={t("chrome.members")}` |
| Collapse | `PanelLeftClose` | `md:flex`, `hidden` below | `Tooltip` label + `detail={t("chrome.collapseChannelListHint")}`, plus `aria-pressed={iconsOnly}` and `data-channel-sidebar-toggle=""` |
| Close drawer | `X` | `md:hidden` | plain `aria-label={t("chrome.closeChannelList")}` — no `Tooltip`, because a tooltip is inert on touch by design and the drawer is touch-only |

The actions wrapper is `<div data-server-header-actions class="flex shrink-0
items-center gap-0.5">`. `shrink-0` because these are fixed-width controls;
letting flex squeeze them only shrinks tap targets while the name is already
truncating.

### 6.9 The loading / no-server state

When `server` is undefined the row still renders, with:

- no banner strip,
- no server icon,
- the name replaced by `isLoading ? t("common.loading") : t("chrome.noServer")`
  in `text-text-tertiary`, **not** a menu trigger (a plain `<p>`, no chevron,
  no `Menu` wrapper — `headerItems` is empty and `Menu` would render its child
  bare anyway, but being explicit is cheaper than relying on that),
- no members and no collapse button,
- **the close `×` still present below `md`.** This is the bug Farol caught on
  #542: the whole action group had been moved inside the `server &&` branch, so
  a drawer opened while the server was still loading had no way to close. There
  is a regression test for it in
  `git show bf3d75f6:client/src/components/layout/channel-list-header.test.tsx`
  — recover it.

---

## 7. Copy

English is the source of truth; both files get every key.
`client/src/locales/en/translation.json` and `.../pt-BR/translation.json`.
Flat dotted keys, single-brace slots, no em dash in either language
(`docs/I18N.md`).

### Reused, unchanged

| Key | en | pt-BR |
|---|---|---|
| `chrome.members` | Members | Membros |
| `chrome.invitePeople` | Invite people | Convidar pessoas |
| `chrome.communitySettings` | Community settings | Configurações da comunidade |
| `chrome.collapseChannelList` | Collapse the channel list | Encolher a lista de canais |
| `chrome.collapseChannelListHint` | Icons only, and everything on the right gets the width. | Só os ícones, e o resto da janela fica maior. |
| `chrome.closeChannelList` | Close channel list | Fechar a lista de canais |
| `chrome.noServer` | No server | Nenhuma comunidade |
| `common.loading` | (existing) | (existing) |

### New, two keys

| Key | en | pt-BR |
|---|---|---|
| `chrome.serverMenu` | Server menu | Menu da comunidade |
| `chrome.publicCommunity` | Public | Público |

`chrome.serverMenu` is the trigger's accessible name. The trigger's *visible*
content is the server's name, which is not a description of what the button
does, so it needs `aria-label={t("chrome.serverMenu")}` — and then the name
must be reachable another way, which is what §6.6's tooltip and the rendered
text already provide. Do **not** wrap the trigger in a `Tooltip`: it would
fight the dropdown for the same hover.

`Público` is the community row in the menu. `Comunidade` was rejected: on an
instance where `COMMUNITIES_ENABLED` is on, every server in the sidebar is
already called a comunidade in Portuguese chrome (`chrome.noServer` is
"Nenhuma comunidade"), so the word carries no information. What the row is
actually telling you is that the address is public and anyone with the link
walks in.

### Deleted

`chrome.role.member` ("Member" / "Membro") was added by #542 for the role badge
this spec removes. If the revert has already taken it out, leave it out. If it
is still present and nothing else references it,
`pnpm --filter @pqp/client i18n:check` will not complain about an unused key —
remove it by hand and check `git grep chrome.role.member` comes back empty.

`communityHome.communityBadge` stays in the catalogue; it has other callers.
It is simply no longer used by this header.

---

## 8. Truncation, with the three sample names

At 14px Gabarito bold, an average lowercase glyph is roughly 7.5–8px and the
ellipsis about 5px. The numbers below are indicative; the **rules** are exact.

| Name | 200px (42px box) | 240px (82px) | 256px (98px) | 320px (162px) | 256px drawer (90px) |
|---|---|---|---|---|---|
| `PQP` | `PQP` | `PQP` | `PQP` | `PQP` | `PQP` |
| `QG do pqp` | `QG d…` | `QG do pqp` | `QG do pqp` | `QG do pqp` | `QG do pqp` |
| `Comunidade dos Amigos do Rafael Que Gostam de Filmes` | `Comu…` | `Comunidad…` | `Comunidade …` | `Comunidade dos Amigos …` | `Comunidade …` |

Rules, which are what QA checks rather than the table:

1. **One line, always.** The identity row's height never depends on the name.
2. **The cut is `text-overflow: ellipsis`, produced by the browser.** No
   JavaScript slices the string, no `line-clamp`, no manual `…`.
3. **A truncated name always ends in `…`** (U+2026, the browser's own), so
   "the name is longer than this" is never ambiguous.
4. **Never fewer than three characters before the ellipsis at any width the
   column can reach (≥ 200px).** If a build ever violates this, the cause is
   something new in the row taking the name's pixels, and the fix is to remove
   that thing, not to shrink the font.
5. **Never a mid-glyph clip.** `overflow: hidden` on a box with
   `white-space: nowrap` cuts at the pixel unless `text-overflow` is set;
   `truncate` sets it. A test that asserts `overflow-hidden` without
   `text-ellipsis` passes on the broken version.
6. **The full name is always reachable**: rendered in full when it fits, in the
   tooltip and the trigger's accessible name when it does not.
7. **Emoji and combining marks.** The browser breaks on grapheme clusters, so
   `truncate` cannot split a flag or a skin-tone modifier. `serverMonogram`
   (used for the icon fallback, not here) still slices by code unit and can;
   that is a pre-existing, separate issue and is **out of scope** — do not
   touch it in this PR.

---

## 9. Acceptance criteria

A QA agent can check every line of this without opening a design file.

### Layout and truncation

1. At sidebar widths **200, 240, 256, 280, 320, 360 and 420px**, and in the
   390px phone drawer, with each of the three sample names: the server name
   occupies **exactly one line**, and the identity row's height is the same at
   every width (`min-h-12`, 48px, unless a translated action label somehow
   grows it — it cannot, there are none).
2. At every width above, a name that does not fit ends with `…` and shows **at
   least three characters** before it. No width produces `PQ`, `P…`, or a
   letter cut down its middle.
3. The name element resolves to `overflow: hidden`, `text-overflow: ellipsis`
   **and** `white-space: nowrap` in the computed style. All three.
4. The name's parent flex child has `min-width: 0`.
5. Nothing in the header overflows its column at 200px: the row's
   `scrollWidth` equals its `clientWidth`, and no descendant's right edge
   exceeds the `<aside>`'s.
6. Dragging the resize handle from 420 to 200 and back never reflows the row to
   a second line and never changes its height.

### The banner

7. A server **with** a banner: exactly one element matching
   `[data-server-banner-strip]`, its height is **72px**, and it contains
   **exactly one child**, an `<img>`. No text node, no `<p>`, no gradient
   element anywhere inside it.
8. That `<img>` has `object-fit: cover` and `aria-hidden="true"`, and its
   accessible name is empty.
9. A server **without** a banner: `[data-server-banner-strip]` is absent from
   the DOM. Not present-and-empty, not present-with-a-placeholder.
10. `[data-server-name]` is **not** a descendant of `[data-server-banner-strip]`
    at any width, in either state. This is the #542 regression, stated as a
    DOM assertion.
11. A banner URL that 404s: the strip disappears (the `onError` path) and the
    identity row is unchanged. The column does not jump by anything other than
    the 72px the band occupied.

### The name is said once

12. The rendered text of the whole header block contains the server's name
    **exactly once**. Count text nodes matching the name across
    `[data-server-banner-strip]` and `[data-server-header]`.
13. No element inside the header carries an uppercase role word (`DONO`,
    `OWNER`, `ADMIN`, `MEMBER`, `Dono`, `Adm`) at any width or for any role.
14. No `COMUNIDADE` / `Comunidade` / `Community` chip inside
    `[data-server-header]` for a server with `isCommunity: true`.

### The menu

15. Clicking `[data-server-menu-trigger]` opens `[data-server-menu]`. Pressing
    `Escape` closes it and returns focus to the trigger.
16. `Enter` and `Space` on the focused trigger open it; `ArrowDown` from the
    trigger opens it with the first item focused (Radix does this; assert it
    still happens).
17. With the menu open, the trigger has `data-state="open"` and a
    `surface-2` background, and the chevron is rotated 180°.
18. For a member with neither Manage Server nor Manage Messages, the menu
    contains **Convidar pessoas** and **Membros** and **not** Configurações da
    comunidade. For an owner, all three, with a separator before settings.
19. For a server with `isCommunity: true`, the menu's first row reads
    **Público** / *Public*, is not focusable and does not close the menu when
    clicked. For `isCommunity: false` the row is absent.
20. Right-clicking `[data-server-header]` still opens the context menu with
    the same items in the same order. The two menus' item arrays are
    `toEqual`-identical (assert on the shared `headerItems`).

### Actions and a11y

21. `[data-server-header-actions]` contains **exactly two** buttons at every
    width: members + collapse at `md` and above, members + close below it.
22. Every button in the header has a non-empty accessible name. Run the check
    at both breakpoints; the `md:hidden` close button is only in the DOM below
    `md`.
23. Hovering the members button shows a tooltip reading **Membros** in pt-BR
    and **Members** in en, and the button's `aria-label` says the same string.
24. Keyboard `Tab` order through the header is: trigger → members → collapse
    (or close). Every stop shows a visible focus ring, and the ring does not
    fuse with the control's own edge (that is the `ring-offset-2`).
25. The collapse button carries `aria-pressed` reflecting the icons-only state,
    and `data-channel-sidebar-toggle=""` so the existing tests still address
    it.
26. No element in the header has a `title` attribute.

### Loading and empty states

27. With `server` undefined and `isLoading` true: the row shows
    `common.loading`, no icon, no chevron, no members button — and, below `md`,
    **the close `×` is present and closes the drawer**.
28. With `server` undefined and `isLoading` false: same, with
    `chrome.noServer`.

### Gates

29. `pnpm --filter @pqp/client bench:tokens` passes, with `uiAliases` and
    `uiStatics` still **0** — `ui/menu.tsx` and `ui/menu-items.tsx` are inside
    the scope those two count.
30. `pnpm --filter @pqp/client i18n:check` passes: both new keys in both
    catalogues, no stale Portuguese, no leftover shell English.
31. `git grep -n "ink-\|paper-muted\|text-paper\|signal\b" -- client/src/components/layout/server-identity.tsx` and the header block of
    `channel-list.tsx` return nothing. The rest of `channel-list.tsx` is not
    this PR's problem.
32. `pnpm lint`, `pnpm typecheck`, `pnpm test` green.

---

## 10. What stays untouched

Do not open these files, or these parts of these files. A header PR that
touches them is doing two things at once.

- **`ServerBanner`** in `server-identity.tsx` — the tall banner with the name
  over it. Its only caller is the Server Settings preview, where a name over
  the artwork is correct, because the artwork is the subject.
- **`ServerIcon`** and **`serverMonogram`** — unchanged, including the
  code-unit slice in the monogram (§8 rule 7).
- **The server rail** (the 72px column of round server icons on the left) and
  its own context menu.
- **`headerItems`'s contents and order.** You prepend one non-interactive row
  when `isCommunity`; you do not reorder, rename, or add actions. "Leave
  server" is not in this menu today and does not join it here.
- **The search button, `PINADOS`, the category headers, every channel row, the
  voice occupant list, and the footer** below the header.
- **The resize handle** and `client/src/lib/channel-sidebar-width.ts`. The
  200px minimum was measured against the *old* header; this one is narrower, so
  200 could in principle come down. It should not, in this PR, and the constant
  has its own test.
- **The icons-only (collapsed) rail** at `channel-list.tsx` ~line 516. It draws
  its own expand button and never had a server header.
- **`user-profile-popover.tsx`.** Decision 2 moves the role "to the member
  card" and the member card already draws cargo chips. This is a deletion from
  the header, not an addition anywhere.
- **`docs/DESIGN.md`** — except one line: move **Menu** out of § Planned
  primitives once `ui/menu.tsx` exists, because a planned-primitives list that
  lists a built primitive is worse than no list.
- **Every server, iOS and Android surface.** This is client-only. The PR does
  **not** restart `pqp-api`.

---

## 11. Suggested order of work

1. `ui/menu-items.tsx` extraction + `ui/menu.tsx`, with `ContextMenu`
   refactored to consume the extraction. Prove it by running the existing
   context-menu tests unchanged.
2. `ServerBannerStrip` + `useRetryableImageFailure` in `server-identity.tsx`.
3. `lib/use-is-truncated.ts`.
4. The header block in `channel-list.tsx`.
5. Copy, both catalogues.
6. `channel-list-header.test.tsx`, recovering the two regression tests from
   `bf3d75f6` (mobile close button with no server; no `overflow-hidden` trap on
   the banner box) and adding §9's DOM assertions.
