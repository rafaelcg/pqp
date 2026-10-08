# Settings redesign spec

Written October 3, 2026 against `feat/settings-redesign` (commit `65a93c07`,
which split the dialog into one file per section). Every tab follows this one document. If a tab brief and a general rule disagree,
the general rule wins.

Scope: the account Settings dialog ("Configurações"). Server and channel
settings are out of scope, except where a shared primitive changes
(`ui/section-rail.tsx`, section D; the `surface-card` token, section E).

Target: one product, not ten pages. Every tab uses the same grammar: a short
title, a few grouped boxes of rows, one clear action at most, and controls that
apply the moment they are touched.

| Item | Status |
|---|---|
| Save model (C) | Decided: option 1, instant controls plus a sticky unsaved bar for the profile. |
| Open questions (J) | All five decided by André, October 3, 2026. |
| Design review | Applied in full. Review date October 3, 2026, approved by André. |
| Everything else | Decided here. |

---

## A. Diagnosis

Verified in code and in the running app (1280x820 and 390x844, dark theme, dev
bypass). Line numbers are on this branch.

1. The save model is mixed, and the footer is mostly fake. Cancelar and Salvar
   show on every tab (`settings-modal.tsx` 566-579). Outside Perfil, Salvar only
   closes. Every `LocalSettings` change already persisted when it was made:
   `patchLocal` (497-514) calls `onAudioSettingsLive`, and
   `handleAudioSettingsLive` (`App.tsx` 7173 onward) calls `saveLocalSettings`.
   `handleSave` (516-555) writes the same values again. Cancelar reverts
   nothing. Two paragraphs explain this: `settings.profile.saveNote` and
   `settings.appearance.languageHint`.
2. Profile drafts are lost silently. The seeding effect (417-424) runs on
   `[open, user]`, so any `onUserUpdated` (banner upload, avatar upload, a DM
   privacy change) overwrites an edited display name.
3. Two primary buttons per screen. The footer Salvar is `default`, and so are
   Feedback's Enviar, Ajuda's "Escrever e-mail", Conexões' Conectar and
   Notificações' "Ativar".
4. The same job uses different controls. On/off is a native checkbox (Voz,
   Notificações, Aparência link previews), `ui/Switch` (music rows, start at
   login), or `SwitchRow` (`settings/ui.tsx` 71-99, which draws a checkbox).
   One-of-many is chips, a segmented control, a native radio (input mode) or a
   native select. Volumes are native ranges in `--color-signal` while
   `ui/Slider` exists.
5. The hierarchy is flat. Every label is the same uppercase eyebrow (`Field`,
   `ui.tsx` 5-23). Nothing is grouped. Voz is one 1,616px column of 20
   controls. In Perfil the display name is last, under an empty 3:1 banner box.
6. The copy explains the UI: a 90-word video quality hint, two intro paragraphs
   in Conexões, four free paragraphs in Ajuda, "Clique em um tom para ouvir",
   and the Atalhos description printed twice.
7. Redundant controls: the push-to-talk binding in Voz and Atalhos, the legal
   links in Seus dados and Ajuda, six "Ouvir" buttons in one stack.
8. Shell defects. The pane keeps its scroll position across tabs (measured:
   Perfil at 100, switch to Voz, Voz opens at 136). The shell has its own rail
   copy (175-267) in deprecated aliases while `ui/section-rail.tsx` draws the
   same tablist in tokens. The pane sits on `surface-2`, where `Switch`'s
   `hover:bg-surface-2` is invisible and the bench does not measure
   `text-tertiary` (`bench/theme-tokens.mjs` 49-62). The ten tab files and the
   shell hold 160 deprecated alias uses; the delete confirm uses `bg-danger
   text-white`.
9. Phone. At 390x844 the header (81px), tab strip (53px) and footer (65px)
   take 199px of 820. The strip is 1,275px wide inside 388px, seven of ten tabs
   are off screen, and the selected tab is not scrolled into view.
10. Configuration states are drawn as content: "Este servidor não tem
    armazenamento de arquivos" under an empty box, six dead "Em breve" provider
    cards.

Keep: the Aparência chat preview and its segmented rows (`appearance-section.tsx`
591-721), the theme cards with a live miniature, the real tablist, mic
permission only while Voz is visible, and the delete flow that makes you type
your tag.

---

## B. Principles

Each rule is testable on one screen.

1. Instant by default. A control applies and persists on change. A Save button
   appears only when something on screen is staged and dirty. Test: change
   anything outside Perfil, press Escape, reopen; it stuck, and no Save button
   was visible.
2. One primary per pane. At most one `Button variant="default"` is visible in
   the pane and the unsaved bar together.
3. Same job, same control.
   - On/off: `SettingsSwitchRow` (role `switch`).
   - One of two to four short options: `RadioGroup variant="segmented"`.
   - One of many, or tag-like options: `RadioGroup variant="chips"`.
   - A visual choice: `SettingsChoiceGrid`.
   - A long or dynamic list (devices, qualities): `SettingsSelect` (native).
   - A number: `SettingsSliderRow` (`ui/Slider`).
   - Two to four options that each need a description (Privacidade): `RadioGroup variant="list"`.
   - A checklist: `CheckRow`. No native checkbox or radio anywhere.
4. Group, then row. Every control sits in a `SettingsRow` inside a
   `SettingsGroup`. The only text outside a group is the pane header.
5. Copy budget (limits in F). Nothing explains how the UI works.
6. Show, don't tell. A setting that changes something visible or audible has a
   preview or a test control in the same group.
7. State lives where it changed. Async status and errors show in the row that
   caused them (`SettingsInlineStatus`), never at the bottom of the pane.
8. Phone parity. At 390px: no horizontal page scroll, rows stack, interactive
   rows at least 40px tall, nothing needs hover.

---

## C. Save model

Decided: option 1. Controls apply and persist the moment they are touched. The
profile is the only staged state, and it gets a sticky unsaved bar.

Facts: only four values are staged today (display name, username, public
handle, avatar URL from a preset or a pasted link). Uploads, DM privacy,
unblock, connections, notifications, theme and language apply on the spot. All
of `LocalSettings` already persists on change. The public handle locks for 30
days after a claim (`canRenameHandle`), so it must never auto-save.

Rejected: a footer that shows only while the profile is dirty (the pane height
jumps and sign out still shares the footer) and per-field edit and confirm
(three edit states and more clicks for a rename).

### The model, exactly

Footer and sign out:

- Remove the `footer` prop from the settings `Dialog`. Cancelar and Salvar are
  gone everywhere.
- The footer carried `safe-pb`. Put `safe-pb` on the bottom of the pane column
  (the bar wrapper when visible, the scroller's bottom padding otherwise), or
  the last row sits under the iOS home indicator on the phone bottom sheet.
- `SignOutButton` moves to the rail footer on `sm` and up, as the ghost action
  of the account card (D). Below `sm` it is the last group of Perfil ("Sessão",
  `sm:hidden`). The component is unchanged.

The bar (`UnsavedChangesBar`, E):

- Shell level, a sibling under the `tabpanel` scroller, so it never scrolls and
  shows on every tab. The Perfil tab shows the existing dirty dot
  (`SectionRailItem.dirty`). While the bar is visible the scroller gets `pb-24`,
  so the last group can scroll clear of it.
- `profileDirty` compares trimmed drafts with `user`, normalizing
  `user.handle ?? ""` and `user.avatarUrl ?? ""` first. A `null` compared with
  `""` must not read as dirty.
- Descartar resets the drafts to `user`. Salvar alterações calls
  `saveProfile()`: "Salvando…" and disabled while in flight; "Salvo" for 1.5s on
  success, then hide; on error the bar stays, shows the message in `text-danger`
  with `role="alert"`, and keeps the drafts.
- Cmd+S on macOS and Ctrl+S elsewhere does the same as Salvar alterações while
  the bar is visible. The shell handles the key on the dialog, calls
  `preventDefault`, and takes the same path as the button (including the handle
  confirm below). With no dirty draft the key does nothing.
- Never auto-save the username on blur. Saving it regenerates the discriminator,
  so a blur would change the tag without a decision. The same holds for the
  public handle.

Handle change confirm:

- When Salvar alterações would change the public handle (a claim or a change),
  a `ConfirmDialog` opens first. Title "Trocar seu link pra pqp.gg/@{handle}?".
  Body "Só dá pra trocar de novo em 30 dias." Confirm "Trocar link". Cancel
  "Manter". For the first claim (no handle yet) the title is "Pegar seu link pra
  pqp.gg/@{handle}?" and the confirm is "Pegar link"; the body and the cancel
  are the same. Cancel keeps the drafts and the bar.
- The 30-day lock is the only irreversible thing on the tab. Nothing else in
  Perfil asks for a confirm.

Close with unsaved edits (Escape, X, backdrop):

- The attempt does not close. The shell switches to Perfil, the bar message
  becomes "Salve ou descarte antes de fechar", the bar wrapper gets a
  `border-danger` edge (a wrapper, because an `elevation-*` border cannot be
  overridden on the same element), and focus moves to Salvar alterações. Every
  attempt while dirty does the same. Descartar or Salvar is the way out.
- Implement as `requestClose()` wrapping `onClose`. This needs nothing in
  `Dialog`.
- The language picker reloads the page. While `profileDirty` it is disabled and
  says "Salve ou descarte as alterações do perfil antes." It reads
  `profileDirty` from `SettingsShellContext` (E).

Shell logic:

1. Seed the four drafts only on the open transition, through a ref, like
   `draftLocal`. Never reseed from `user` while open, with one exception:
   after a successful `saveProfile`, reseed from the returned user.
2. `AvatarPicker`'s `onUploaded(user)` also sets the avatar draft to
   `user.avatarUrl ?? ""`, so a later Save cannot revert the upload.
3. Extract the payload into a pure `buildProfilePatch(user, drafts)` in
   `client/src/components/settings/profile-patch.ts` with a unit test. Keep
   today's semantics: `displayName` only when changed, `username` as
   `trim() || undefined`, `avatarUrl` as `trim() || null`, `handle` only when
   non-empty.
4. `handleSave` becomes `saveProfile()`: validate the display name (empty shows
   `settings.profile.displayNameRequired` in the bar and on the row), call
   `updateMe`, call `onUserUpdated`, do not close. It no longer calls
   `onLocalSave` or `saveLocalSettings`.
5. `patchLocal` must still persist when `onAudioSettingsLive` is absent
   (`all-reports-gate.test.tsx` mounts without it): fall back to
   `onLocalSave(next)` and `saveLocalSettings(next)`. `SettingsModalProps` does
   not change.

Tests: `settings-sections.spec.ts` uses "Cancel" (becomes "Close dialog"),
`push-to-talk.spec.ts` line 263 uses "Cancel" (becomes Escape). Add a unit test
for `buildProfilePatch` and a jsdom test that a dirty draft survives
`onUserUpdated` while open.

Keys to delete (grepped: used only in `settings-modal.tsx`): `settings.save`,
`settings.cancel`, `settings.eyebrow`, and `settings.profile.saveNote`. Keep
`settings.saving` and `settings.saveFailed`.

---

## D. Shell spec

Files: `layout/settings-modal.tsx`, `ui/section-rail.tsx`.

### Dialog and layout

- Keep `<Dialog size="xl" fill>`. Title "Configurações". No eyebrow. No footer
  (C).
- The title band is 56px tall, down from 74px. It stays on desktop; it is not
  dropped. Measure it after the eyebrow is gone. If `Dialog` cannot reach 56px,
  add an optional header-class prop to `Dialog` (other dialogs unchanged). That
  touches `ui/dialog.tsx`.

```
Dialog body (fill, overflow hidden)
└─ div.flex.h-full.min-h-0.flex-col.sm:flex-row
   ├─ rail column            inherits surface-2, sm:w-60, sm:border-r border-border
   │  ├─ SectionRail (role=tablist, grouped)
   │  └─ rail footer (sm and up): account card + build line
   └─ pane column            flex min-w-0 flex-1 flex-col bg-surface-1
      ├─ #settings-panel role=tabpanel   the only scroller
      │  └─ div.@container.mx-auto.w-full.max-w-[40rem].px-4.py-5.sm:px-8.sm:py-8
      │     ├─ SettingsPaneHeader
      │     └─ tab content (space-y-6)
      └─ UnsavedChangesBar (outside the scroller) + safe-pb
```

- Pane `bg-surface-1`: the surface the bench measures secondary and tertiary
  text on, and the one `--color-ring-offset` follows.
- Content max width 40rem. Moderação may set `wide: true` on its `SectionDef`
  (`max-w-none`) for its report list.
- The `tabpanel` keeps `id="settings-panel"`, `aria-labelledby`, `tabIndex={0}`,
  `overflow-y-auto overscroll-contain [scrollbar-gutter:stable]`. The dialog
  body must never scroll (`dialog-mobile-layout.spec.ts`).
- Set the scroller's `scrollTop = 0` on every section change.

### Rail

Adopt `ui/SectionRail`, delete the local copy (`settings-modal.tsx` 175-267).
Extend the primitive with optional fields only, so server and channel settings
render as today:

```ts
export interface SectionRailItem<Id extends string = string> {
  id: Id;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
  dirty?: boolean;
  /** Key into `groupLabels`. Items of one group must be adjacent. */
  group?: string;
}
// New optional SectionRail props:
groupLabels?: Record<string, string>;
footer?: ReactNode;   // rendered after the tablist, outside it
className?: string;   // width and strip height; settings passes sm:w-60 and h-14, others keep sm:w-56
fadeEnd?: boolean;    // phone strip: fade the right edge while more tabs are off screen
```

- Group headings sit inside the tablist as `<div role="presentation"
  aria-hidden="true" className="hidden px-3 pb-1 pt-4 text-xs font-medium
  text-text-tertiary first:pt-0 sm:block">`. Arrow keys address
  `[role="tab"]` only, so they are unaffected.
- On `active` change: `tabs[index]?.scrollIntoView?.({ block: "nearest",
  inline: "nearest" })`. The optional call matters: jsdom has no
  `scrollIntoView`.
- Tab recipe stays the primitive's (`rounded-[var(--radius-control)] px-3 py-2
  text-sm`, selected `bg-accent/12 font-medium text-text`, idle
  `text-text-tertiary hover:bg-surface-2 hover:text-text`, standard focus ring).
- Run `e2e/server-settings-sections.spec.ts` after the change.

Rail footer (settings passes it through `footer`; outside the `role="tablist"`,
above `border-t border-border`, `sm` and up only):

1. Account card. `UserAvatar` at 24px and the display name from the saved `user`
   (never the draft). `SignOutButton` ("Sair da conta") is its ghost action. Under
   the dev bypass `SignOutButton` renders nothing, so the card shows without it.
2. Build line, below the card: `text-[11px] text-text-tertiary tabular-nums`,
   "pqp web · 2026.10.03 · a1b2c3d" (the shell label, "pqp web" in a browser and
   "pqp desktop" in the Electron app, then `BUILD_TIME` as
   `YYYY.MM.DD`, then the first seven characters of `BUILD_ID`). Both come from
   `lib/build-info.ts`; `VITE_PQP_BUILD_ID` only overrides the id Vite bakes in.
   Under `vite dev` the id is `dev` and the time is 0: show "pqp web · dev". The
   line is a button. Click copies it and the text reads "Copiado" for 1.5s
   (`role="status"`). The same line shows in Ajuda (G10).

| Group key `settings.nav.group.*` | pt-BR | Tabs, in order |
|---|---|---|
| `account` | Conta | Perfil, Conexões, Privacidade, Seus dados |
| `app` | App | Voz e vídeo, Notificações, Aparência e idioma, Atalhos |
| `support` | Suporte | Feedback, Ajuda e contato |
| none, after a divider | | Moderação (moderators only) |

This keeps both keyboard facts the e2e asserts: ArrowDown from Perfil lands on
Conexões, End lands on Ajuda e contato for a non-moderator. Icons stay as
today (`settings-modal.tsx` 2, 93-163).

### Pane header

```tsx
<header className="mb-8 flex items-start justify-between gap-4">
  <div className="min-w-0">
    <h3 className="font-display text-xl font-bold text-text">{title}</h3>
    {description && <p className="mt-1 text-sm text-text-secondary text-pretty">{description}</p>}
  </div>
  {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
</header>
```

- The h3 text is the tab label. `actions` takes secondary or ghost buttons only.
- `settings-sections.spec.ts` finds `heading` by tab name without `exact`, which
  also matches any h4 that contains the name. The spec asserts
  `{ name, level: 3 }`. Rule for every tab: no group title
  contains its tab's label in any language.

### Phone (below `sm`, 640px)

- The rail stays a horizontal scrolling tablist above the pane (the 390px e2e
  stays valid). Group headings hide; the selected tab scrolls into view. Icons
  stay. The strip is 56px tall including padding.
- The right edge fades over the last 32px (`mask-image` with a linear gradient)
  while more tabs are off screen, so the hidden tabs are discoverable. The fade
  goes away when the strip is scrolled to its end. Settings passes `fadeEnd`;
  server and channel settings keep their hard edge.
- The strip stays for now (J4). A drill-in list is planned for when the dialog
  becomes a full-screen page on phone. A strip of ten is a web compromise.
- Pane padding `px-4 py-5`. Rows stack through the container query (E).
- With no footer and no eyebrow, the pane gains about 85px.

### Contract that does not change

Tablist `aria-label={t("settings.nav.label")}`; tabs `id="settings-tab-<id>"`,
`aria-selected`, `aria-controls="settings-panel"`, roving `tabIndex`, arrows on
both axes, Home, End. `requestedSection`, the sticky last section, the
moderation gate and its bounce to Perfil, `voiceVisible` gating the mic, and
`DeleteAccountDialog` replacing settings while open. `dialog-body.test.ts` keys
`FULL_BLEED` on the path `layout/settings-modal.tsx`. The re-exports that
`settings-local.test.ts` imports from `settings-modal` stay.

---

## E. Page grammar (the kit)

Tabs compose these blocks and nothing else. A missing block is added to the
kit; no local copies.

### Where things live

| File | Status |
|---|---|
| `ui/radio-group.tsx` | New generic primitive (DESIGN.md "Planned: Radio group") |
| `ui/textarea.tsx` | New generic primitive (DESIGN.md "Planned: Textarea") |
| `settings/kit/*.tsx` and `settings/kit/index.ts` | New settings composition |
| `settings/ui.tsx` | Deleted. Its helpers are replaced by the kit. |
| `docs/DESIGN.md` | Radio group and Textarea move from Planned to Components |

`ui/` is gated by the bench (`uiAliases` and `uiStatics` at 0). Do not copy
`segmentClass` there: it uses `rounded-md` and `shadow-sm`.

Reused as is: `Button`, `Input`, `Switch`, `CheckRow`, `Slider`, `Dialog`,
`ConfirmDialog`, `Tooltip`, `Skeleton`, `UserAvatar`.

### Group surface (`surface-card`)

In dark the group box (`surface-1`) is one step above the pane only by its
border. In light the pane (`surface-1`) and the group box are nearly the same
warm grey, so groups read as faint outlines. Apple and Discord light both put
white groups on a grey page. No existing role token does this: `surface-0` is the
app background in dark and `surface-1` is the pane.

Add a role token, never a hard-coded colour:

- `--color-surface-card: var(--color-surface-1);` in `@theme static` (dark).
- `--color-surface-card: var(--color-surface-0);` once in
  `:root[data-theme="light"]`. Every light look (`harmony`, `hearth`, `night`)
  also sets `data-theme="light"`, and `var()` resolves against that look's own
  `surface-0`. In every light look `surface-0` is lighter than `surface-1`, so
  one declaration covers all four and the card is lighter than the pane. Check
  each look in a screenshot.
- `SettingsGroup` draws `elevation-1 bg-surface-card` (DESIGN.md allows a
  different background written after the level). Group hover stays
  `hover:bg-surface-2`.
- `surface-card` is added to the DESIGN.md surfaces table. The token
  always equals `surface-0` or `surface-1`, which the bench already measures text
  on, so it needs no new pair.

### Keycaps (`SettingsKeycap`, `SettingsKeyCombo`)

The Atalhos tab is mostly keycaps, so they must be the most visible thing on it.

- Cap: `h-6 min-w-6 rounded-[var(--radius-control)] border border-border-strong
  bg-surface-2 px-1.5 font-mono text-xs text-text` (24px tall, 12px glyph). Use
  `bg-surface-3` when the field behind it is `surface-2`.
- Modifier caps (Ctrl, Shift, Alt, Cmd) use `text-text-secondary`. The letter or
  key uses `text-text`.
- A whole combo sits in one field: `inline-flex items-center gap-1
  rounded-[var(--radius-control)] bg-surface-0 p-1`. Caps inside it do not each
  get their own box.
- `KeyBindingField` shows the combo through `SettingsKeyCombo`. It is the only
  place that draws keys.

### Rhythm and tokens

| Thing | Value |
|---|---|
| Pane padding | `px-4 py-5 sm:px-8 sm:py-8` |
| Header to first group | `mb-8`; between groups `space-y-6`; group title to surface `mt-2` |
| Row | `px-4 py-3`, `min-h-12` with a description, `min-h-11` without; label to description `mt-0.5` |
| Pane title | `font-display text-xl font-bold text-text` |
| Group title | `text-sm font-semibold text-text`. No uppercase eyebrows in a pane. |
| Row label / description | `text-sm text-text` / `text-xs text-text-tertiary text-pretty` |
| Readouts | `text-xs tabular-nums text-text-secondary` |
| Monospace | Keys, handles, tags and links only |
| Radius | Controls `--radius-control`; groups, previews, notices `--radius-card`; chips and switch `rounded-full` |
| Elevation | Pane `bg-surface-1`; groups `elevation-1 bg-surface-card` (below); unsaved bar `elevation-2`; nothing else casts a shadow |
| Hover | Interactive rows `hover:bg-surface-2` |
| Focus in a group | `focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring focus-visible:ring-offset-0` (the group clips an outer ring) |
| Focus elsewhere | The four-part ring in DESIGN.md |
| Disabled | The control's own disabled style plus a description that says why |
| Motion | Color transitions `duration-[var(--duration-fast)] ease-[var(--ease-standard)]`; bar entrance `animate-pop-in`; spinners `motion-safe:animate-spin`; the 1s
`bg-accent-soft` row flash from `openSection`; nothing else. `animate-copy-flash` is forbidden on persistent UI (it ends at opacity 0). |
| Icons | `lucide-react`; `h-4 w-4` in rows, `h-3.5 w-3.5` in small buttons; decorative ones `aria-hidden` |

### `RadioGroup` (ui)

```ts
export interface RadioOption<T extends string | number> {
  value: T; label: string; description?: string; disabled?: boolean;
}
export interface RadioGroupProps<T extends string | number> {
  value: T;
  onValueChange: (next: T) => void;
  options: readonly RadioOption<T>[];
  label: string;                       // accessible name; e2e finds groups by name
  variant?: "segmented" | "chips" | "list";
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
  status?: ReactNode;                  // list only: under the checked option
  activation?: "auto" | "manual";      // manual: arrows move focus, Enter/Space select
  fit?: "equal" | "content";           // segmented only: content-sized cells that wrap
}
/** Roving tabindex and arrow keys; shared with SettingsChoiceGrid. Skips disabled options. */
export function useRovingRadio<T>(values: readonly T[], value: T, onChange: (v: T) => void,
  isDisabled?: (v: T) => boolean, options?: { activation?: "auto" | "manual" }):
  { onKeyDown: (e: KeyboardEvent<HTMLElement>) => void; tabIndexFor: (v: T) => 0 | -1 };
```

- Markup: `div role="radiogroup" aria-label`; options are `button role="radio"
  aria-checked`. The disabled-skip logic is today's `ThemePicker`
  (`appearance-section.tsx` 209-232).
- Segmented track `grid auto-cols-fr grid-flow-col gap-0.5
  rounded-[var(--radius-control)] border border-border bg-surface-0 p-0.5`.
  Item `h-8 rounded-[var(--radius-control)] px-3 text-sm` (`sm`: `h-7 px-2.5
  text-xs`). Selected `bg-surface-2 font-medium text-text`; idle
  `text-text-tertiary hover:text-text`; disabled `cursor-not-allowed
  opacity-40`.
- Chips `flex flex-wrap gap-2`; item `h-8 rounded-full border px-3 text-sm`;
  selected `border-accent bg-accent-soft text-on-accent-soft`; idle
  `border-border text-text-secondary hover:bg-surface-2 hover:text-text`.
- List (`variant="list"`): the control for two to four options that each need a
  description (Privacidade). The group is `div role="radiogroup" aria-label`
  with `divide-y divide-border`, so it sits as one child of a `SettingsGroup`.
  Each option is a full-width `button role="radio" aria-checked` row, `flex
  min-h-12 items-center gap-3 px-4 py-3 text-left hover:bg-surface-2` with the
  inset focus ring. Label `text-sm text-text`; description `mt-0.5 text-xs
  text-text-tertiary text-pretty`. The indicator is custom, never a native
  input: a `h-4 w-4 rounded-full border border-border-strong` ring on the right
  (`shrink-0`), and when selected `border-accent` with a `h-2 w-2 rounded-full
  bg-accent` dot. Disabled rows use `opacity-40` and are skipped by the arrows.
- Options with a `description` cannot be segmented. Use list, chips or a choice
  grid.
- `status` (list only) draws under the checked option's description, for the
  write that option started: `status={<SettingsInlineStatus state={save.state} />}`.
  It is a sibling of the radio, never inside it, and every list option keeps
  the same wrapper whether or not a status shows, so focus survives the
  "Salvando…" appearing. The option gives its bottom padding to the status.
- `activation="manual"` is for a change that is expensive or disruptive (the
  language switch reloads the app): the arrows step focus from the focused
  option and select nothing; Enter or Space selects. A click still selects.
- `fit="content"` (segmented only) sizes each cell to its label and never
  truncates; when the row is too narrow the track wraps onto a second line.
  Use it when one label is much longer than the rest ("Só @menções"). Pair it
  with `SettingsRow wideControl` when the row should keep it inline.

### `Textarea` (ui)

`forwardRef<HTMLTextAreaElement>`, the `Input` recipe with `min-h-28 py-2
resize-y` in place of the fixed height. Renders no label.

### `SettingsGroup`

```ts
interface SettingsGroupProps {
  id?: string;                      // data-settings-row, an openSection target; not registered
  title?: string;
  description?: string;
  action?: ReactNode;               // one ghost or secondary sm button, or a link
  surface?: "card" | "plain";       // plain: the children are their own boxes
  children: ReactNode;
  className?: string;
}
```

```tsx
<section aria-labelledby={title ? titleId : undefined}>
  {title && (
    <div className="flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h4 id={titleId} className="text-sm font-semibold text-text">{title}</h4>
        {description && <p className="mt-1 text-xs text-text-tertiary text-pretty">{description}</p>}
      </div>
      {action}
    </div>
  )}
  <div className="mt-2 elevation-1 bg-surface-card overflow-hidden rounded-[var(--radius-card)] divide-y divide-border">{children}</div>
</section>
```

### `SettingsRow`

```ts
interface SettingsRowProps {
  id: string;            // required, see "Row ids" below
  label: string;
  description?: ReactNode;
  htmlFor?: string;
  control?: ReactNode;   // right on a wide pane, under the label on a narrow one
  stacked?: boolean;     // always under the label (select, slider, input, meter)
  badge?: ReactNode;     // for example the NOVO chip
  status?: ReactNode;    // a SettingsInlineStatus
  disabled?: boolean;
  children?: ReactNode;  // extra content under the row
  leading?: ReactNode;   // avatar, tile or icon before the label column
  searchable?: boolean;  // false: never registered (rows built from data)
  keepInline?: boolean;  // control stays beside the label on a phone (sm button)
  wideControl?: boolean; // control may pass 55% (select plus button); wraps when it cannot fit
  [data: `data-${string}`]: string | number | boolean | undefined; // passed to the root
}
```

```tsx
<div data-settings-row={id}
  className={cn("flex flex-col gap-3 px-4 py-3", description ? "min-h-12" : "min-h-11",
  !stacked && "@lg:flex-row @lg:items-center @lg:justify-between @lg:gap-6")}>
  <div className="min-w-0 flex-1">
    <div className="flex items-center gap-2">
      <label htmlFor={htmlFor} className="text-sm text-text">{label}</label>{badge}
    </div>
    {description && <p className="mt-0.5 text-xs text-text-tertiary text-pretty">{description}</p>}
    {status}
  </div>
  {control && <div className={cn("shrink-0", stacked ? "w-full" : "@lg:max-w-[55%]")}>{control}</div>}
  {children}
</div>
```

`@lg` (32rem) is a container query on the pane content (`@container`), already
used in `friends/friends-view.tsx`. A narrow desktop window and a phone stack
the same way.

Recipes for the options:

- `leading`: `flex items-center gap-3` around the slot and the text column, so
  an avatar or tile is centred on the label and description. It is inside the
  row, so the `openSection` flash covers it, and disabled dims it with the
  text. Blocked people: `leading={<UserAvatar ... className="h-8 w-8" rounded="full" />}`.
  Connections: the `h-9 w-9` provider tile.
- `searchable={false}`: the row renders and carries `data-settings-row` but
  never enters the registry. Every row built from data (a blocked person, a
  linked account, a device) uses it, so phase 2 search lists settings only.
- `keepInline`: the row is `flex-row flex-wrap items-center justify-between`
  at every width. For a small control (an `sm` button) in a list row, so a
  20-person list does not double in height on a phone. `stacked` wins.
- `wideControl`: the control loses the `@lg:max-w-[55%]` cap and the label
  column keeps `@lg:min-w-40`, so a select plus a button sits inline when it
  fits and wraps under the label when it does not.
- `data-*`: any `data-` attribute lands on the row's root, so a tab's e2e hook
  (`data-profile-banner`) needs no wrapper div.

### Row ids and the registry

Every row component takes a required `id` (`SettingsRow`, `SettingsSwitchRow`,
`SettingsSliderRow`, `SettingsLinkRow`). It is kebab-case, stable, and unique
within its tab (`ptt`, `input-device`). It renders as `data-settings-row`.

The kit keeps a module-level registry of `{ id, section, label }`. A row
registers itself on render; the section comes from a `SettingsSectionContext`
that the shell sets around each tab. `searchable={false}` on `SettingsRow`,
`SettingsSwitchRow`, `SettingsSliderRow` or `SettingsLinkRow` keeps a row out. The registry exists now so no tab
ships rows without ids. It feeds `openSection` (below) and, in phase 2, search.

### `SettingsSwitchRow`

```ts
interface SettingsSwitchRowProps {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  status?: ReactNode;    // under the row, for example a notice
  trailing?: ReactNode;  // a secondary action beside the switch, for example an icon-only "Ouvir"
  searchable?: boolean;
}
```

Renders `ui/Switch` with `className="rounded-none px-4 py-3"` plus the inset
focus ring, so the row is the hit target and the role is `switch`. With
`trailing`, the row is a flex container: the `Switch` takes `flex-1` and the
trailing button sits beside it (never a button inside a button).

Disabled dims the whole row: the kit passes `Switch dimRowWhenDisabled`, which
puts `opacity-60` on the row and drops the track's own `opacity-50`, so label,
description and track read as one disabled thing (like a disabled
`SettingsRow`). With a `status`, the switch gives up its bottom padding
(`pb-0`) and the status block is `px-4 pb-3`, so the status sits `mt-1.5`
under the description.

### `SettingsSelect`

Native `<select>`, kept native on purpose: there is no Select primitive, and
`viewer-video-quality.spec.ts` locates `select:has(option[value="1080p"])`.

```ts
export const SettingsSelect = forwardRef<HTMLSelectElement, ComponentProps<"select">>(...);
// "h-[var(--control-lg)] w-full rounded-[var(--radius-control)] border border-border bg-surface-0 px-3
//  text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
//  focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50"
```

### `SettingsSliderRow`

```ts
interface SettingsSliderRowProps {
  id: string;
  label: string; description?: string;
  value: number; min: number; max: number; step?: number;
  format: (value: number) => string;     // readout, e.g. t("settings.voice.percent", { percent })
  onValueChange: (value: number) => void;
  onValueCommit?: (value: number) => void;
  disabled?: boolean;
  searchable?: boolean;
}
```

A stacked row whose control is `Slider variant="volume" className="flex-1"`
with `aria-label={label}` and `aria-valuetext={format(value)}`, and a readout
`w-12 text-right text-xs tabular-nums text-text-secondary`.

### `SettingsChoiceGrid`

```ts
interface SettingsChoiceGridProps<T extends string> {
  label: string;
  value: T;
  onValueChange: (next: T) => void;
  options: readonly { value: T; label: string; badge?: string; description?: string; preview: ReactNode; disabled?: boolean }[];
  columns?: 2 | 3 | 4;   // at @lg; 2 below
}
```

`role="radiogroup"` with `useRovingRadio`; grid `grid grid-cols-2 gap-3`. Card
`flex flex-col gap-2 rounded-[var(--radius-card)] border p-2 text-left
transition-colors duration-[var(--duration-fast)]`. Selected `border-accent
bg-surface-2` plus a `Check` in `h-4 w-4 rounded-full bg-accent text-on-accent`
at the top right; idle `border-border hover:border-border-strong`. Badge
`rounded-[var(--radius-control)] bg-surface-1 px-1.5 py-0.5 text-[11px]
text-text-secondary`, on a second line under the name, never beside it (at 40rem
a card is about 130px wide and "Só escuro" crowds "Noite"). Use inside
`SettingsGroup surface="plain"`.

`description` is one `text-xs text-text-tertiary text-pretty` line under the
name (above the badge), for cards that must be read before choosing (Voz's
input modes). With a description the radio is named by its label (and badge)
through `aria-labelledby` and described through `aria-describedby`.

### `SettingsPreview`

```ts
interface SettingsPreviewProps {
  summary?: string;      // sr-only sentence in place of the drawing
  children: ReactNode;   // the aria-hidden drawing
  controls?: ReactNode;  // rows that drive it, under a divider
  decorative?: boolean;  // default true; false keeps the drawing in the a11y tree
}
```

`decorative={false}` is for a drawing that holds a control operated in place:
Voz's sensitivity handle on the live meter. The caller then marks the purely
visual parts `aria-hidden` itself and names the control (`Slider aria-label`
plus `aria-valuetext`).

`overflow-hidden rounded-[var(--radius-card)] border border-border`; drawing on
`bg-surface-0`; controls under `border-t border-border`. This generalizes
`ChatDisplayPicker` (`appearance-section.tsx` 672-718).

### `SettingsInlineStatus` and `useInlineSave`

```ts
type InlineSaveState =
  | { kind: "idle" } | { kind: "saving"; label?: string } | { kind: "saved" }
  | { kind: "error"; message: string };
function SettingsInlineStatus({ state, savingLabel }: { state: InlineSaveState; savingLabel?: string }): JSX.Element | null;
/** Runs an async write, tracks its state, clears "saved" after 2s. */
function useInlineSave(options?: { savingLabel?: string; showSaved?: boolean }):
  { state: InlineSaveState; run: (fn: () => Promise<unknown>, fallbackError: string) => Promise<void> };
/** The line under a row for a failed write: a 4xx sentence as is, else the fallback. */
function inlineErrorMessage(error: unknown, fallback: string): string;
```

`mt-1.5 flex items-center gap-1.5 text-xs`. Saving: `Loader2 h-3.5 w-3.5
motion-safe:animate-spin`, "Salvando…" (or `savingLabel` / `state.label`:
"Preparando…" for a download, "Enviando…" for an upload), `text-text-tertiary`,
`role="status" aria-live="polite"`. Saved: `Check text-success`, "Salvo",
`text-text-secondary`, `animate-fade-in`. Error: `CircleX h-3.5 w-3.5`,
`text-danger`, `role="alert"`, the message.

`useInlineSave({ showSaved: false })` goes from saving straight back to quiet,
for an action whose result is its own proof (a download starting). Errors still
show. The error text is `inlineErrorMessage(error, fallback)`: an `ApiError`
4xx with a real sentence is shown as is; a 5xx (`database_unavailable`), a
network failure (status 0, a client-built English line) or a bare "Request
failed" shows the tab's localized fallback; any other `Error` keeps its
message, so a tab can throw its own localized one.

### `SettingsNotice`

For permission, configuration and capability states.

```ts
interface SettingsNoticeProps {
  tone: "info" | "warning" | "danger" | "success";
  title?: string;
  children: ReactNode;
  action?: ReactNode;    // one secondary sm button
  inGroup?: boolean;     // a row inside a SettingsGroup
  icon?: LucideIcon;     // replaces the tone icon (Feedback's Bug)
  role?: "status" | "alert" | "note"; // default alert for danger, status otherwise
}
```

`flex items-start gap-3 rounded-[var(--radius-card)] px-4 py-3 text-xs`. Info:
`border border-border text-text-secondary` on the pane surface (a measured
pair). Others: `bg-<tone>-soft text-on-<tone>-soft` (measured pairs). Icons
`Info`, `TriangleAlert`, `CircleX`, `CircleCheck`. `role="status"`, or
`role="alert"` for danger; `role="alert"` on another tone for a refusal that
answers what the person just pressed, `role="note"` for a static notice that
must not be announced as news. Inside a group it is a row (`rounded-none`) and
sets no border width of its own, so the group's `divide-y` line under it stays.
It replaces `border-warning/40 bg-warning/10` (`voice-section.tsx` 339, 461).

### `SettingsLinkRow`

```ts
interface SettingsLinkRowProps {
  id: string;
  label: string; description?: ReactNode; // phrasing content only
  value?: ReactNode;                     // current value before the icon (a SettingsKeyCombo)
  href?: string; external?: boolean;     // target=_blank rel=noreferrer, ExternalLink icon
  onClick?: () => void;                  // in-app jump, ChevronRight icon
  searchable?: boolean;
}
```

`value` sits right of the label, `text-xs text-text-secondary`, `gap-3` before
the icon. The whole row is an `<a>` or `<button>`, so `value` and
`description` must be phrasing content (`<span>`, `<kbd>`), and both are part
of the row's accessible name. Atalhos' push-to-talk row:
`value={<SettingsKeyCombo keys={formatBinding(key).split(" + ")} label={...} />}`.

The whole row is the `<a>` or `<button>`: `flex w-full items-center
justify-between gap-4 px-4 py-3 text-left text-sm text-text hover:bg-surface-2`
plus the inset focus ring; `min-h-12` with a description, `min-h-11` without;
icon `h-4 w-4 text-text-tertiary`.

### `SettingsEmpty`

`px-4 py-6 text-center`; optional icon `h-5 w-5 text-text-tertiary`; title
`text-sm text-text-secondary`; description `text-xs text-text-tertiary`. For an
empty list inside a group.

### `SettingsResult`

```ts
interface SettingsResultProps {
  tone: "success" | "danger" | "info";
  title: string;            // one line: what happened
  description?: ReactNode;
  action?: ReactNode;       // one button for what comes next
  icon?: LucideIcon;
}
```

The outcome of a one-shot action, in place of the form that produced it
(Feedback after a send). Centred like `SettingsEmpty`: `flex flex-col
items-center gap-3 px-4 py-6`, tone icon `h-5 w-5` (`text-success`,
`text-danger`, `text-text-tertiary`), title `text-sm text-text`. Not a live
region; move focus to the action (`Button` forwards its ref) or to the title,
which is `tabIndex={-1}` and carries `data-settings-result-title`.

### `SettingsActionRow`

```ts
function SettingsActionRow(props: { id?: string; note?: ReactNode; noteId?: string; children: ReactNode }): JSX.Element;
```

A group's closing row with no label: a tertiary note on the left and one
button on the right (Feedback's "Vai junto: …" beside "Enviar"). `flex
min-h-11 flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3`;
the note is `min-w-0 flex-1 basis-48 text-xs text-text-tertiary`, so on a
phone the button wraps under it. Point the button's `aria-describedby` at
`noteId`. Not registered; `id` is still an `openSection` target.

### `SettingsSkeletonRow` and `SettingsSkeletonRows`

```ts
interface SettingsSkeletonRowProps {
  leading?: "tile" | "avatar"; description?: boolean; control?: "button" | "switch" | "none";
}
function SettingsSkeletonRows(props: SettingsSkeletonRowProps & { label: string; count?: number }): JSX.Element;
```

A loading stand-in at a real row's height (`ui/Skeleton` bars). Use
`SettingsSkeletonRows` inside a `SettingsGroup` in place of the rows: one
`role="status" aria-busy` wrapper with `divide-y`, an sr-only `label`
("Carregando conexões"), and `count` rows that are each `aria-hidden`.

### `SettingsBadge`

`inline-flex rounded-full px-1.5 py-0.5 text-[10px] leading-none
font-semibold uppercase tracking-wide`; `accent` (default) `bg-accent-soft
text-on-accent-soft`, `neutral` `bg-surface-2 text-text-secondary`. The NOVO
chip, in `SettingsRow badge`. The copy stays "Novo"; CSS uppercases it.

### `SettingsCopyButton` and `useCopyText`

```ts
interface SettingsCopyButtonProps {
  text: string; label: string; copiedLabel?: string; // default "Copiado"
  showLabel?: boolean; disabled?: boolean; className?: string;
}
const SETTINGS_COPIED_MS = 1500;
function useCopyText(text: string): { copied: boolean; copy: () => void };
```

The one copy affordance in Settings. Icon-only by default: `Button
variant="ghost" size="sm"` square (`w-[var(--control-sm)] px-0`) inside a
`Tooltip` whose `label` is also the accessible name (needs the app's
`TooltipProvider`; the dialog's unit tests mount one). `showLabel`: a
secondary `sm` button with the icon and the label as text, swapping to
`copiedLabel`, no tooltip (Perfil's "Copiar link"). `Copy` turns into `Check
text-success animate-icon-swap` for `SETTINGS_COPIED_MS`; every copy restarts
the clock; an always-mounted sr-only `role="status"` says `copiedLabel`. No
clipboard: nothing happens.

### `SettingsBuildLine`

`variant?: "rail" | "row"`, both on `useCopyText`, the copy icon after the
text. `rail` (default): `text-[11px] text-text-tertiary`, truncates, "Copiado"
replaces the line for a moment. `row`: Ajuda's "Versão do app" control,
`font-mono text-xs text-text-secondary`, `break-all`, the line stays and only
the icon turns into a check.

### Danger

No red box. A destructive action is a row in its own group, with `<Button
variant="danger" size="sm">`. The button carries the signal. Confirms use
`ConfirmDialog` or a `Dialog` with `Button variant="danger"`.

### `UnsavedChangesBar` (shell only)

```ts
interface UnsavedChangesBarProps {
  visible: boolean;
  saving: boolean;
  saved?: boolean;
  blocked?: boolean;       // a close was refused: guard copy and border-danger wrapper
  error?: string | null;
  onDiscard: () => void;
  onSave: () => void;
}
```

Wrapper `safe-pb px-4 pb-4 sm:px-8` (with `rounded-[var(--radius-card)]
border border-danger` on an inner wrapper when `blocked`). Bar `mx-auto flex
w-full max-w-[40rem] flex-wrap items-center gap-3 rounded-[var(--radius-card)]
px-4 py-3 elevation-2 animate-pop-in`. Message `min-w-0 flex-1 text-sm
text-text`. `Button variant="ghost" size="sm"` Descartar, `Button size="sm"`
Salvar alterações.

### `SettingsShellContext`

```ts
interface SettingsShellValue {
  profileDirty: boolean;
  /** Switches tab. With `rowId`, scrolls that row into view and flashes it. */
  openSection: (section: SettingsSectionId, rowId?: string) => void;
  /** The profile save lost the public link (409), localized. Perfil draws it under the field. */
  profileHandleError?: string | null;
}
export function useSettingsShell(): { profileDirty; openSection; profileHandleError: string | null };
```

Provided by the shell. `HelpSection`'s `onOpenFeedback` prop keeps working.

`openSection("voice", "ptt")` is how a hint or a link row in another tab reaches
a row. It looks the row up by `data-settings-row`, calls `scrollIntoView({
block: "center" })` and gives the row `bg-accent-soft` for 1s
(`duration-[var(--duration-base)]` in, plain removal after). A missing `rowId`
only switches the tab. A `rowId` that is not on screen is not an error: the
pane lands at the top of the section at once, and the row still flashes if it
renders within a second. `SettingsGroup id` makes a whole group a target
(Voz gives its input-mode group the id "ptt" while voice activity is
selected, so Atalhos' jump always lands somewhere).

A taken public link: `PATCH /api/me` claims the handle first and answers 409
"That handle is already taken". The shell recognises it
(`isHandleTakenError` in `settings/profile-patch.ts`: 409, a handle in the
patch, the sentence names the handle and not the username), goes to Perfil,
puts `settings.unsaved.handle.taken` ("Esse link já tem dono. Tenta outro.")
in the bar and in `profileHandleError`, and clears it when the link draft
changes, on Descartar and on a good save. The server's English sentence is
never shown for this case.

### Settings search (phase 2, not in the first build)

An `Input` at the top of the rail, above "Conta". It filters the registry to a
flat list of matching rows across tabs (label and section name). Enter opens the
first match through `openSection(section, rowId)`. The registry only holds tabs
that have rendered, so phase 2 either mounts every panel hidden once or adds a
static manifest per tab. Decide then. The first build only guarantees the ids and the
registry.

---

## F. Copy rules (pt-BR first)

The audience is mostly Brazilian. Write the Portuguese first, then English and
Spanish. Follow `docs/I18N.md`: você-imperative in Settings, the loanword list,
"tú" in Spanish, no em dash in any language.

Tone:

- Short, warm, plain. Say what the setting does, never how the UI works (no
  "Clique em", "A linha no medidor", "Esta seção").
- Loanwords stay: call, mute, push-to-talk, DM, app, Watch party, link.
- Spoken contractions ("pra", "tá") are fine where the app already uses them.
  Be consistent inside a tab.

| Element | Max |
|---|---|
| Rail tab | 22 characters |
| Pane description | 90 characters, one sentence |
| Group title | 28 characters, never containing the tab's label |
| Group description | 140 characters |
| Row label | 40 characters |
| Row description | 120 characters, one or two short sentences |
| Button | 3 words, verb first |
| Notice | 2 sentences |

- Buttons: a button that opens a dialog or asks a follow-up ends in an
  ellipsis ("Apagar…", "Restaurar…"). A button that acts at once does not
  ("Baixar", "Enviar").
- Action groups (one row, one button): the three say different things. The
  title names the topic ("Conta"), the row says what you get ("Apagar sua
  conta"), the button is only the verb ("Apagar…"). The button never repeats a
  noun from the title or the row.
- Toggles: the label names what is on ("Sons de mensagem", "Abaixar a música
  quando alguém fala"). Never a question, never "Ativar X". The description
  gives the effect or the trade-off, not both.
- Choices: one or two words per option ("Claro", "Escuro", "Sistema").
- Destructive confirms: the title names the act ("Apagar sua conta?"); the body
  says what is lost and whether it can be undone, in two sentences at most;
  the confirm repeats the verb ("Apagar conta"); the cancel says what stays
  ("Manter conta"). Never "OK" or "Sim".
- Errors: what failed, then what to do ("Não deu pra salvar. Tenta de novo.").
  No codes, no blame, no exclamation marks. `ApiError.message` may show as is.
- Success: one or two words, inline ("Salvo", "Link copiado"). No toasts.
- Configuration states: neutral, no apology, no operator instructions ("Capa
  indisponível neste servidor.").
- Notices: a notice never explains where something is on screen ("fica embaixo
  à esquerda", "na barra de cima"). It states the fact or the next step.
- One register per tab. Feedback says "Enviar" and "Enviar outro", not a mix of
  "Enviar" and "Manda".

Keys:

- Flat dotted keys under the tab's prefix (G). New shell keys:
  `settings.nav.group.*`, `settings.unsaved.*`, `settings.status.*`,
  `settings.rail.*` (account card, build line).
- Name by role: `settings.voice.group.input.title`.
- A new meaning gets a new key. A wording change keeps the key.
- Every key in `en`, `pt-BR` and `es`.
- Before deleting or rewording a key, grep `client/src`, `electron` and
  `client/e2e`. The e2e specs match English accessible names ("Compact peer
  list", "Copy link", /Push to talk/, the theme options). If you reword an
  English string a spec uses, update the spec in the same commit.
- Frozen keys (used outside the owning tab; change them only together with their other users):
  `settings.appearance.language.*`, `settings.connections.completing`,
  `settings.connections.completeFailed`, `settings.voice.obsVirtualCameraHint*`,
  `settings.voice.videoQuality.*` option and readout keys,
  `settings.voice.screenFrameRate.auto`, `settings.data.privacy`,
  `settings.data.terms`, `settings.data.cookies`, `settings.voice.pttKeyOrMouse`,
  `settings.voice.pttNoKeyboard`. Each `settings.<tab>.description` is read by
  the shell; the tab owns its value.
- What CI catches: `i18n:check` fails on keys missing or stale in pt-BR and es
  relative to en, and on placeholder mismatch. `typecheck` fails on a code
  reference to a key missing from en (`MessageKey`). Nothing catches an unused
  en key. Deleting orphans is part of every change and a review item.

Locale placement (every tab touches the same three files):

- Keys are not sorted. Add a key directly after the last existing key with your
  prefix, at the same position in `en`, `pt-BR` and `es`.
- Do not reorder, reformat or re-indent. 2-space JSON, trailing newline kept.
- Run `i18n:check` after every merge that touches the locale files.

---

## G. Per-tab briefs

Risk, highest first: Voz e vídeo, Perfil, Notificações, Aparência e idioma,
Atalhos. The other five are low.

Every tab: compose the kit; root `<div className="space-y-6">`; every row has a
stable `id` (E); no `Field`, `SettingBlock`, `SwitchRow`, `chipClass`,
`segmentClass`; no native checkbox or radio; no deprecated alias. "Wrong today"
items are in A unless noted. Quoted pt-BR is exact. A reworded string keeps its
key (F).

### 1. Perfil (`profile`)

- For: how you appear and how people find you. Jobs: change name and avatar;
  claim or copy the public link.
- Wrong today: name last, banner box dominates, the tag drawn as a fake input,
  link actions as underlined text, the save note.
- Structure:
  1. `SettingsPreview` profile card, `summary` "Prévia da sua página pública".
     Banner strip (the real banner when one exists, the accent gradient only as
     the empty state), `UserAvatar`, display name, `@handle` or tag. It reads
     the drafts, so it updates while typing. Phone: banner 96px, avatar 64px
     overlapping the banner by half, the info line below.
  2. Group "Nome e foto":
     - Nome de exibição (`Input`, stacked).
     - Avatar (`AvatarPicker`, stacked): upload first, then all eight
       `AVATAR_PRESETS`, then "Usar um link" as a disclosure. When an avatar is
       set, a ghost "Remover" button sits beside the upload button. It keeps the
       key `settings.profile.avatar.clear` (today "Limpar"); only the wording
       changes, to match the Capa row.
     - Capa: Enviar uma capa or Trocar, Remover as ghost. The description keeps
       the size hint (`settings.profile.banner.hint`, "{width}×{height} fica
       melhor"). Storage off shows a neutral `SettingsNotice` and no buttons.
  3. Group "Como te encontram":
     - Link público: the `pqp.gg/@` field. When the handle is claimed, show the
       link with "Copiar link" and "Abrir".
     - Nome de usuário: the `Input`, then under it a readout in `font-mono
       text-xs`, "Seu identificador: nome#4557" (key `settings.profile.handle`),
       with a copy icon button and `Tooltip`. The identifier is not its own row:
       one username, one tag, one place. At 390px the readout wraps under the
       input (`break-all`).
  4. Phone only: group "Sessão" with `SignOutButton`.
- Intentional changes: the identifier folds into the username row; saving a
  handle goes through the confirm in C.
- Keep: drafts live in the shell (props unchanged); uploads apply instantly;
  cooldown disables the field and shows the date; `normalizeHandle`; the
  username filter; `data-profile-banner`; no auto-save on blur (C). E2E
  (`handles.spec.ts`): placeholder `yourname`, text `pqp.gg/@`, button "Copy
  link", field disabled in cooldown.
- Edge states: no user, storage off, upload busy, upload failed, avatar set
  (Remover visible), banner set, cooldown, handle taken (inline), handle confirm
  open, empty name (blocked by the bar).
- Files: `settings/profile-section.tsx`, `user/avatar-picker.tsx` (keep the
  `AVATAR_PRESETS` and `avatarUploadEnabled` exports; onboarding imports them).
  Keys `settings.profile.*`.

### 2. Conexões (`connections`)

- For: linking game and streaming accounts. Jobs: connect; set who sees it;
  disconnect.
- Structure:
  1. Group "Contas ligadas", one-sentence description (prove it is yours; pqp
     never logs in). One row per enabled provider: the brand tile, name, linked
     name or "Não conectado". The tile is `ConnectionGlyph`
     (`connections/connection-badges.tsx`), which already draws the real marks on
     the `--color-connection-*` tokens; use it, not letters. Control: Conectar
     (`Button variant="secondary" size="sm"`) or a visibility `SettingsSelect`
     plus a Desconectar button.
  2. Group "Em breve": one compact row with the upcoming glyphs and names,
     `text-text-tertiary`, no buttons.
- Conectar is secondary for every provider. Several providers can be
  unconnected at once, and B2 allows one primary per pane.
- Visibility select: `aria-label` "Quem vê isso" (key
  `settings.connections.visibility.label`). Where the row stacks (phone) the same
  text also shows as a visible caption above the select. The longest option,
  "Também na minha página pública", fits a native select.
- Desconectar: `Button variant="ghost" size="sm"` at the normal button text size
  (small ghost text is under the contrast floor in dark). It asks through
  `ConfirmDialog`.
- Keep: `startConnection` redirect; the stashed callback error; visibility
  values `hidden | shared | public`.
- Edge states: loading (skeleton rows), nothing configured (info notice,
  `settings.connections.unconfigured`), load failed, connect failed, save failed,
  disconnect failed (each inline on its row or as a danger notice for the load),
  busy per provider, the confirm open.
- Files: `connections/connections-section.tsx`. Keys `settings.connections.*`
  (not the frozen two); `connections.provider.*` read only.

### 3. Voz e vídeo (`voice`)

- For: making mic, speakers and camera work and sound right. Jobs: pick
  devices; check the mic (meter, sensitivity); choose voice activity or push to
  talk.
- Header `actions`: "Testar conexão" (secondary, keeps
  `data-settings-check-connection`). The "Problemas de conexão" group is gone.
- Structure, in this order (a first visit picks a mic, picks speakers and checks
  both work, so those come first):
  1. Group "Microfone":
     - Device (`SettingsSelect`).
     - "Ouvir meu microfone": a secondary sm button beside the select. It
       loops the processed mic to the output for 5s, then stops by itself.
       Client-only WebAudio. In scope (decided in J6).
     - Volume de entrada (`SettingsSliderRow`, 0 to 200%).
     - Sensibilidade: the level meter as a stacked `SettingsPreview` (voice
       activity only). The meter is 12px tall. The sensitivity handle is a 2px
       marker with a grab target of at least 24px, so it is obviously
       draggable. The fill moves with the live level. Ends captioned "Mais
       sensível" and "Menos sensível" (left to right). The description is "Fale
       pra testar." (key `settings.voice.sensitivityHint`). It never points at the
       meter.
  2. Group "Saída": device (select, or the unsupported notice
     `settings.voice.outputUnsupported` on Safari and Firefox), Volume de saída.
  3. Group "Modo de entrada": `RadioGroup` chips or a two-card choice grid (Por
     voz, Push-to-talk). Under push to talk: `PttBindingField` (the one place to
     set the key; Atalhos links here, J3), release delay slider (desktop native
     only), global switch (desktop), beep switch with Testar as `trailing`, the
     macOS and Wayland permission notices, the one-line limit, the no-keyboard
     note.
  4. Group "Processamento": eco and ganho (switch rows), Redução de ruído
     (`SettingsSelect` with the NOVO badge; keep "Mudar isso reabre o microfone.
     Ninguém cai da call.").
  5. Group "Vídeo":
     - Câmera (select, OBS virtual camera hint below).
     - Vídeo que você envia (select plus `OutboundVideoReadout` while in a
       call). Description, exactly: "Vale pra câmera e pra tela, só no que sai
       daqui. Automático pede 720p e deixa a conexão decidir." The two facts are that the choice covers camera
       and screen, and what Automático does.
     - FPS da tela (select, one sentence: "Automático usa 60 fps quando dá.").
  6. Group "Na call": mute on join, compact list, music auto-join, music duck
     (switch rows).
- Target: the pane is under 1,500px tall at 1280x820 with voice activity
  selected.
- Keep: mic permission only while `voiceVisible`; camera permission only on
  focus of the camera select; `MicLevelMeter` math (`displayMicLevel`,
  `sliderToVadThreshold` are exported and tested); `patchLocal` for every
  value; `setPttBeepEnabled`; music prefs store.
- E2E: native select with `option[value="1080p"]`; a radio named /Push to
  talk/ that `.check()` selects; "Compact peer list" becomes a switch, so
  update `settings-sections.spec.ts` to `getByRole("switch")` (Playwright's
  `.check()` accepts `role="switch"` per `kAriaCheckedRoles` in playwright-core
  1.62.1; confirm on the first run). Keep the English label "Compact peer list"
  or update the spec. The pane must still overflow at 390px.
- Edge states: push to talk selected on desktop and on web, permission denied,
  no devices, output selection unsupported, OBS virtual camera hint, no
  keyboard, desktop-only rows on web, Wayland and macOS permission, in-call
  readout and live analyser.
- Files: `settings/voice-section.tsx`. Keys `settings.voice.*` minus frozen.
  `components/voice/*` read only.

### 4. Atalhos (`keyboard`)

- For: seeing and changing shortcuts. Jobs: find a key; rebind one; reset all.
- Wrong today: each shortcut is a label above a full-width field; reset has the
  weight of "Ver o mapa" and no confirm.
- Structure:
  1. Header `actions`: "Ver o mapa" (secondary sm).
  2. At the top, when the device has no keyboard, a `SettingsNotice` (the
     existing `settings.voice.pttNoKeyboard` text).
  3. One group per `SHORTCUT_GROUPS` entry (title from `GROUP_LABEL`); each
     action a `SettingsRow` with a compact `KeyBindingField` on the right,
     drawn as keycaps (E).
  4. Push to talk in the voice group is a `SettingsLinkRow` showing the binding,
     "Alterar em Voz e vídeo" (`openSection("voice", "ptt")`). Decided in J3.
  5. Group "Padrões": row "Voltar tudo ao padrão", description "Inclui a tecla
     e o atraso do push-to-talk.", button "Restaurar…" (secondary sm, key
     `settings.keyboard.reset`) behind a `ConfirmDialog`.
- Recording state: the field shows the existing `keyBinding.press` ("Aperte uma
  tecla… (Esc cancela)"), or `keyBinding.pressOrClick` where a mouse button can
  bind. Esc cancels. A reserved key shows `keyBinding.refused`.
- Conflict state: the existing `keyBinding.conflict` ("Em uso: {action}."),
  inline under the row in `text-danger`, `role="alert"`. The key is not saved.
- The action label for a new conversation is the existing `shortcuts.newDm`,
  "Nova conversa". Keep it.
- Keep: `findBindingConflict`; `bindableMap` exported from this file (Voz
  imports it); reset also resets the PTT key and release delay.
- Edge states: no keyboard (info notice), recording, conflict, reserved key,
  Apple modifiers, the confirm open.
- Files: `settings/keyboard-section.tsx`, `voice/key-binding-field.tsx` (owned
  here, consumed by Voz; styling changes only unless Voz changes with it). Keys
  `settings.keyboard.*`.

### 5. Notificações (`notifications`)

- For: what reaches you, where, with which sound. Jobs: turn notifications on;
  set the default level; silence or change sounds.
- Structure:
  1. Group "Neste dispositivo":
     - Notificações do sistema (switch row calling `enable()` or `disable()`).
       Description "Neste navegador." In the desktop app: "Neste computador."
       (the permission is per browser or device, never per account). Denied and unsupported become a `SettingsNotice`
       inside the row.
     - Push com o app fechado (same pattern). The iOS needs-install text becomes
       a short notice plus a "Como instalar" link row; it points at the
       existing download page.
  2. Group "Comunidades": row "Nível padrão" (`RadioGroup` segmented, "Tudo",
     "Só @menções", "Nada"). Description, exactly: "Vale onde a comunidade ou o
     canal não tiver ajuste próprio. Botão direito numa comunidade muda só ela."
  3. Group "Mensagens diretas": three switch rows. The third is "Mostrar quem
     mandou no push" (key `settings.push.dmDetails`). It is disabled while push
     is off, and its description then reads "Liga o push primeiro."
  4. Group "Sons": master switch; each cue a switch row with `trailing` Ouvir,
     an icon-only ghost `Volume2` button with a `Tooltip` "Ouvir" and an
     `aria-label` that names the cue. The row label already names the sound, and
     six text buttons were six identical faint targets. "Toque de saída" is now
     "Chamando alguém" (key `settings.notifications.sounds.outgoingCall`).
     Toque de chamada as chips that play on select, disabled when the master or
     the call cue is off.
  5. No Não Perturbe notice. The Sons description already says "Mudo no Não
     Perturbe." Delete `settings.notifications.dndHint` after the grep in F.
- Intentional change: the Ativar and Desativar buttons become switches.
- Keep: permission and push subscribe only from a click; the `touchedRef` race
  guard; `setDefaultLevel`.
- Edge states: permission default, granted, denied, unsupported; push
  needs-install (iOS Safari), unsupported, not configured, busy, failed; push
  off disables "Mostrar quem mandou no push"; master off disables children.
- Files: `settings/notifications-section.tsx`. Keys
  `settings.notifications.*`, `settings.push.*`.

### 6. Aparência e idioma (`appearance`)

- For: how the app looks and reads. Jobs: light or dark; look and accent; text
  size; language.
- Wrong today: the sync hint floats; `SettingBlock` reserves 2.5rem of hint
  height; link previews is a checkbox; start at login is buried.
- Structure:
  1. Group "Tema": Claridade (segmented), Visual (`SettingsChoiceGrid` with
     today's miniature; badges such as "Só escuro" on a second line under the
     name), Destaque (hue slider, swatches, ghost "Usar a do visual"), Contraste
     (segmented).
  2. Group "Chat": the existing preview with Layout, Tamanho do texto, Espaço
     entre grupos (segmented `sm`), link previews (switch row). "Voltar ao
     padrão" (key `settings.appearance.chatReset`) is the group `action`. It
     exists today and shows only when the chat display differs from
     `DEFAULT_CHAT_DISPLAY`; keep that rule.
  3. Group "Idioma": segmented; disabled while `profileDirty` (C).
  4. Group "App para computador" (desktop, macOS and Windows): start at login.
     Drop "Só macOS e Windows por enquanto." from its description; the row is
     hidden elsewhere.
  5. The sync fact becomes the pane description.
- Keep: theme, look, contrast and accent apply on click; night locks brightness
  to dark; the language reload drops `?lang=` and syncs `locale` (`es` stored as
  `en`); start at login hidden on Linux and web; `showLinkEmbeds` through
  `patchLocal`.
- E2E: radiogroups /brightness|claridade/ and /contrast|contraste/; radios
  /light|claro/, /dark|escuro/, /system|sistema/, /harmony|harmonia/,
  /night|noite/, /hearth/, /classic|clássico/, /high|alto/. Keep these labels.
- Edge states: night look (other brightness options disabled with the reason),
  custom accent with no swatch selected, synced value between presets, language
  disabled while the profile is dirty, chat display at default (no reset),
  desktop IPC failure.
- Files: `settings/appearance-section.tsx`. The `appearance-preview*` and
  `accent-hue-*` CSS in `index.css` is read only unless the change covers its other users. Keys
  `settings.appearance.*` minus `language.*`.

### 7. Privacidade (`privacy`)

- For: who can reach you. Jobs: choose who can start a DM; unblock someone.
- Pane description: "Quem consegue falar com você." (it says what the setting
  is for, not where it applies).
- Structure:
  1. Group "Mensagens diretas": who can DM you as `RadioGroup variant="list"`
     (a label and a description per option), `SettingsInlineStatus` on the row.
  2. Group "Bloqueados": one row per person (`UserAvatar`, name, tag,
     Desbloquear secondary sm). When empty, `SettingsEmpty` "Ninguém bloqueado."
     The group description carries the short fact: "Mensagens dessa pessoa não
     chegam até você e ficam escondidas nos canais em comum."
- Keep: `updateMe({ dmPrivacy })` on click with the busy guard;
  `onUnblockUser` with no confirm (it is reversible); default `server_members`.
- Edge states: saving, error, no user, empty list, a long list.
- Files: `settings/privacy-section.tsx`. Keys `settings.privacy.*`.

### 8. Seus dados (`data`)

- For: the two rights the privacy policy promises. Jobs: download my data;
  delete my account.
- Structure:
  1. Group "Sua cópia": row "Tudo que a gente guarda sobre você", description
     "Perfil, configurações, mensagens que você escreveu, comunidades e
     bloqueios. Mensagens dos outros não vêm.", button "Baixar" (secondary sm)
     with inline status ("Preparando…", then the error).
  2. Group "Conta": row "Apagar sua conta", description "É pra sempre. Não dá
     pra desfazer.", `Button variant="danger" size="sm"` "Apagar…".
  3. Untitled group: `SettingsLinkRow` Política de privacidade (external),
     "Como a gente trata os seus dados."
  4. `DeleteAccountDialog`: same flow, tokens only (`Button variant="danger"`,
     lists in `text-text-secondary`, blocking servers as a warning notice).
- Intentional change: terms and cookies links move to Ajuda only.
- Keep: export filename and blob flow; typing the tag
  (`deleteConfirmationMatches`); `closeOnBackdrop={false}`; `OwnedServersError`;
  reload on deletion.
- Edge states: exporting, export failed, owned servers, delete failed.
- Files: `settings/your-data-section.tsx`. Keys `settings.data.*` (minus the
  frozen three), `settings.delete.*`. Group titles must not contain "seus
  dados" or "your data".

### 9. Feedback (`feedback`)

- For: sending a bug, idea or gripe. Job: describe it and send.
- Structure:
  1. Untitled group: Tipo (chips: Bug, Ideia, Outro; at 390px the chips stack
     under the label); message (`Textarea`, stacked, counter `n / max` as a
     readout).
  2. Last row of the group: a one-line tertiary note of what is attached
     (lead-in "Vai junto") and "Enviar" (the one primary, right).
  3. Sent: `CircleCheck` (`text-success`), the thanks line, "Enviar outro"
     (secondary).
- Copy register: "Enviar" and "Enviar outro" replace "Manda" and "Mandar outro"
  (keys `settings.feedback.send` and `settings.feedback.again` keep their names).
- Keep: `sendFeedback` with `buildFeedbackContext(voice)`;
  `FEEDBACK_BODY_MAX_LENGTH`; send disabled on an empty body. The emoji in
  `settings.feedback.intro` is copy, allowed; never as a control.
- Edge states: empty (Enviar disabled), sending, error inline, sent.
- Files: `settings/feedback-section.tsx`. Keys `settings.feedback.*`.

### 10. Ajuda e contato (`help`)

- For: reaching the team, status, rules. Jobs: write an email; report a bug;
  see if pqp is down.
- Structure:
  1. Group "Falar com a gente", description "Somos dois irmãos, fazemos o pqp nas
     horas vagas e respondemos assim que dá." (`help.response`). Rows: the
     address (`text-sm`) with "Escrever e-mail" (the one primary, `Mail`) and
     Copiar as an icon-only ghost `Button size="sm"` (`Copy` to `Check` with
     `animate-icon-swap`) with a `Tooltip` (`help.email.copy`) and the same
     `aria-label`; then a row "Versão" that shows the build line from the rail
     footer (D) in `font-mono text-xs` with the same copy button. A person
     writing to the team can see and copy the version here.
  2. Group "Achou um bug?": link rows to Feedback (`openSection("feedback")`),
     GitHub and Status (external).
  3. Group "Regras e privacidade": three external link rows (privacy, terms,
     cookies).
  4. Info notice: abuse reports go through the message menu.
- Keep: `buildContactMailto` with diagnostics; `CONTACT_EMAIL`;
  `data-help-section`; `onOpenFeedback`.
- Edge states: no clipboard (Copiar is a no-op; the address stays selectable).
- Files: `layout/help-section.tsx`. Keys `help.*`. Group titles must not
  contain "ajuda" or "help".

### Moderação (moderators only)

Out of scope visually. The shell moves it after a divider, gives it
`bg-surface-1` and the `wide` flag. `all-reports-gate.test.tsx` stays green. No
one edits `all-reports-section.tsx`.

---

## H. Definition of done (every tab)

Copy this into the report and tick it.

Design system

- [ ] Role tokens, `ui/` primitives and the kit only. No deprecated alias
      (`ink*`, `paper*`, `signal*`, `text-muted`, `text-subtle`, `bg-channel`,
      `panel`, `muted`).
- [ ] No colour literal, no `text-white`, no opacity-modified status fills
      (`bg-warning/10`), no `accent-[var(--color-*)]` native controls.
- [ ] No native checkbox, radio or range. `<select>` only through
      `SettingsSelect`.
- [ ] Radius, durations and shadows by token. `rounded-full` is allowed.
- [ ] `lucide-react` icons only. No emoji as a control. Icon-only buttons have a
      `Tooltip` or `aria-label`.
- [ ] At most one `Button variant="default"` visible in the pane.

Copy

- [ ] All copy through `t()`, in `en`, `pt-BR` and `es`, placed per F.
- [ ] pt-BR written first. Limits in F met. No em dash or en dash.
- [ ] Orphan keys deleted in all three locales after grepping `client/src`,
      `electron` and `client/e2e`. Frozen keys untouched.

Behavior

- [ ] Behavior and persistence unchanged unless section C or the tab's brief
      says so. Every intentional change listed in the report.
- [ ] Side effects unchanged: mic only while Voz is visible, camera only on
      focus of its select, notification and push permission only from a click.
- [ ] Desktop-only rows hidden on web; Linux exclusions kept.
- [ ] A hint or coachmark never pushes layout. It floats (absolute, portal or
      `Tooltip`).

Accessibility

- [ ] Every control reachable by keyboard, with a visible focus ring, in a
      logical order.
- [ ] Radio groups and switches expose `role` and `aria-checked`; every group of
      options has an accessible name.
- [ ] Async status announced (`role="status"` or `role="alert"`).

Layout and evidence

- [ ] At 390px, `document.documentElement.scrollWidth <= innerWidth`. Rows
      stack. Interactive rows at least 40px tall.
- [ ] Screenshots at 1280x820 and 390x844, light and dark, top of the pane and
      scrolled to the end.
- [ ] Hard gate: every state in the tab's edge-state list (G) has a screenshot in
      both brightnesses, or the report says why it cannot be reached under the
      dev bypass. The happy path is the easy one to draw, and the untested path is
      the one production hits (CLAUDE.md pitfalls 9 and 12). A list item with no
      screenshot fails the review.
- [ ] Sign out cannot be seen under the bypass (`SignOutButton` returns null);
      say so. The account card and the build line still show.

Checks (paste the tail of each)

- [ ] `pnpm --filter @pqp/client typecheck`
- [ ] `pnpm --filter @pqp/client test`
- [ ] `pnpm --filter @pqp/client i18n:check`
- [ ] `pnpm --filter @pqp/client bench:tokens` (what CI runs) and
      `pnpm --filter @pqp/client bench` (adds the runtime theme check)
- [ ] `pnpm --filter @pqp/client e2e <spec>` for the tab's specs below, plus
      `settings-sections.spec.ts` and `dialog-mobile-layout.spec.ts`

Scope

- [ ] Only the brief's files plus locale lines under the tab's prefix. Changes to
      `ui/`, `settings/kit/`, the shell or another tab were made in the kit, not locally.

### Tests that pin Settings today

| File | What it pins | Updated by |
|---|---|---|
| `e2e/settings-sections.spec.ts` | exact English tab names; a heading per tab in the tabpanel (no `exact`); ArrowDown Perfil to Conexões; End to Ajuda; "Cancel"; checkbox "Compact peer list"; rail beside pane on desktop; stacked and no page scroll at 390 | Kit (Cancel, order, `level: 3`); Voz (switch) |
| `e2e/dialog-mobile-layout.spec.ts` | `panel.children[1]` is the body; Voz pane scrolls, body does not; dialog inside the viewport at 390x844 and 320x568 | Kit |
| `e2e/push-to-talk.spec.ts` | radio /Push to talk/; "Cancel" | Kit (Cancel); Voz keeps the radio |
| `e2e/theme-switching.spec.ts`, `e2e/theme-preferences.spec.ts` | radiogroup and radio names in Aparência | Aparência |
| `e2e/viewer-video-quality.spec.ts` | native select with a `1080p` option | Voz |
| `e2e/handles.spec.ts` | `yourname`, `pqp.gg/@`, "Copy link", disabled in cooldown | Perfil |
| `e2e/server-settings-sections.spec.ts` | the shared `ui/SectionRail` | Kit |
| `ui/dialog-body.test.ts` | `FULL_BLEED` path `layout/settings-modal.tsx` | Kit |
| `layout/all-reports-gate.test.tsx` | mounts without `onAudioSettingsLive`; `settings-tab-moderation` | Kit |
| `layout/settings-local.test.ts` | re-exports from `settings-modal` | Kit keeps them |

---

## J. Decided

André approved every recommendation and every item of the design review on
October 3, 2026.

1. Save model: option 1. No footer. A sticky unsaved bar for the profile fields,
   closing blocked until you save or discard. Added: Cmd/Ctrl+S on the bar, a
   confirm before a handle change, and no auto-save of the username on blur
   (C).
2. Sign out: at the rail bottom on desktop as the ghost action of an account
   card that also carries the build line (D), and as the last group of Perfil on
   phone.
3. Push-to-talk: set only in Voz e vídeo. Atalhos links there, and its reset
   still covers the PTT key and delay.
4. Phone navigation: keep the horizontal tab strip, with the right-edge fade and
   a 56px height. A drill-in list is planned for when the dialog becomes a
   full-screen page on phone.
5. Rail groups Conta, App, Suporte, with Privacidade and Seus dados next to
   Perfil. Order inside App: Voz e vídeo, Notificações, Aparência e idioma,
   Atalhos.
6. Follow-ups decided the same day: the copy rule is "the button never repeats a
   noun" (F); the first-claim handle confirm uses "Pegar seu link pra
   pqp.gg/@{handle}?" and "Pegar link" (C); the "Ouvir meu microfone" mic test
   ships with the Voz tab (G3).
