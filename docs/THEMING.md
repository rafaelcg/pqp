# Theming — scope

> Produced 2026-08-01 against `main`. Grounded in `client/src/index.css`,
> `client/src/components/layout/settings-modal.tsx`, `client/src/main.tsx` and
> `server/src/schema.sql` as they actually are, not as the docs describe them.

Recommended cut line: **stages 1–3, about 1.5–2 weeks.** Stages 4–6 are upside. Stage 7 is a
trap and should stay off the roadmap permanently.

## Why now

Two visible bugs already come from the dark-only assumption:

- Clerk's sign-in modal renders in Clerk's default light theme inside our dark shell.
  `<ClerkProvider>` in `client/src/main.tsx` passes no `appearance`, and `@clerk/themes` is not
  a dependency.
- Every native `<select>`, range slider and scrollbar draws light OS chrome, because nothing in
  `client/` sets `color-scheme`. **One line fixes this today**, independent of everything else.

pqp also does not honour the OS light/dark setting at all, and user settings never leave the
browser — `LocalSettings` lives only in `localStorage` under `pqp-local-settings`, and
`PATCH /api/me` syncs only `displayName`, `username` and `avatarUrl`.

## What exists today

One dark theme, defined once, in `client/src/index.css`: an `@theme` block with 11 raw OKLCH
values (`ink`/`ink-2`/`ink-3`/`ink-4`, `paper`/`paper-muted`, `signal`/`signal-dim`,
`danger`/`warning`/`success`), 9 semantic aliases, and 3 font families.

The problem is not the palette, it is the naming and the leaks:

- **Components consume the raw names, not the aliases.** `text-paper-muted` ×113,
  `text-paper` ×47, `border-ink-4` ×33, `bg-ink-3` ×32, `text-danger` ×31 — versus
  `text-muted` ×4. The semantic layer exists and is essentially unused.
- **Zero** `dark:` variants, `prefers-color-scheme` queries, or `color-scheme` declarations.
- **Eight places bypass tokens entirely:** the body gradients and `::selection` in `index.css`,
  `.legal-prose`, the emoji-mart rgb-triplet bridge, a popover shadow repeated verbatim in four
  component files, the speaking-ring glow in `voice-avatar.tsx`, a hardcoded `theme="dark"` in
  `emoji-picker-panel.tsx`, and `backgroundColor: "#1a1f2a"` on the Electron `BrowserWindow`.

## Three Tailwind v4 facts this plan depends on

1. `@theme` emits `:root, :host` inside `@layer theme`. An **unlayered** `:root[data-theme=…]`
   block anywhere in `index.css` therefore wins without specificity hacks.
2. Alias indirection (`--color-accent: var(--color-signal)`) survives to runtime rather than
   being resolved at build time — which is what makes runtime theme switching possible at all.
3. `@theme` tree-shakes unused variables. Role tokens are consumed at runtime, not by the
   utility scanner, so the block must become **`@theme static`** — a one-word change.

Never use `@theme inline`: it inlines values and structurally kills runtime overriding. Leave a
comment in `index.css` saying so, because it is the obvious-looking wrong turn.

---

## Stage 1 — role tokens (1–2 days, no visible feature)

Rename colour-named tokens to elevation/role names, and keep the old names as deprecated
aliases pointing at the new ones (`--color-ink-3: var(--color-surface-2)`). All 200+ existing
class names keep working and **no component file changes**. Codemod the class names later; do
not block light mode on it.

Target set: `surface-0..3`, `border`/`border-strong`, `text`/`text-muted`, `indicator`,
`accent`/`accent-hover`/`on-accent`, `danger`/`warning`/`success`, `code-bg`/`code-text`,
`overlay`, `selection`, `focus-ring`, `ring-offset`.

Four of these renames are load-bearing rather than cosmetic:

- The ink ramp runs darkest→lightest and **must invert** for light mode.
- `ink-4` is a border token wearing a surface name — 33 `border-ink-4` uses vs 3 `bg-ink-4`.
- `bg-signal text-ink` appears 5× and needs a real `on-accent` token.
- Code background must be a role, not an alias. In dark, `--color-ink` sits *below* the message
  list; in light it is the page itself, so code blocks would vanish.

Also in this stage: put `--shadow-popover`, `--shadow-speaking` and `--gradient-app-*` in a
plain unlayered `:root` (not `@theme`, which would try to generate utilities for them) and
replace the eight inline literals. Convert the body `background:` shorthand to
`background-color` + `background-image` longhands so a theme can override the colour without
clobbering the gradients. Set `color-scheme: dark` — that alone fixes the native-control bug.

## Stage 2 — Light and System (3–4 days)

A `:root[data-theme="light"]` override block. Light is not an inversion; four things need real
decisions:

- The accent must darken. The current `oklch(0.88 …)` chartreuse fails contrast on white.
- Glows become solid rings — the speaking indicator reads as a smudge on light backgrounds.
- `--color-overlay` is deliberately **not** overridden. A modal scrim must darken in both themes.
- Skeletons need `surface-3` darker than the panel, or every loading state disappears.

New `client/src/lib/theme.ts` and `client/src/hooks/use-theme.ts` with a `matchMedia` listener
for System. A theme radio in `settings-modal.tsx` writing its own `pqp-theme` key — *not* inside
the audio-device blob, because the boot script must not have to parse that.

Anti-flash needs all three of:

1. An inline blocking script in `client/index.html` `<head>`. Vite injects `main.tsx` at the end
   of `<body>`, so a head script paints first. There is no CSP in the repo today; if one is
   added later it needs a hash for this script.
2. Never gate render on `/api/me`.
3. `electron/main.js` reads the persisted theme before `new BrowserWindow` to set
   `backgroundColor` and `nativeTheme.themeSource`.

Add `@clerk/themes` and a `<ClerkThemeBridge>` passing `baseTheme` plus `variables` read from
the resolved custom properties in a `useLayoutEffect`. Pass `theme={resolved}` to emoji-mart
along with hand-written `--rgb-*` triplets per theme.

Force `data-theme="dark"` on the four marketing routes. Those are compositions over a hero
photograph, not app chrome; light-moding them is scope creep.

## Stage 3 — server-side preferences (~2 days)

This absorbs the separate "settings don't follow the user" gap.

```sql
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

JSONB validated by a `userPreferencesSchema` in `packages/shared/src/api.ts` (theme,
`muteOnJoin`, `compactPeers`, volumes, notification prefs). A column per preference means a
migration per preference, and this set will churn.

`inputDeviceId` / `outputDeviceId` **must stay local**: a device id from another machine is
meaningless, and `getUserMedia({ audio: { deviceId: { exact } } })` throws on it.

Fold reads into `toPublicUser` so `GET /api/me` carries preferences at zero extra round-trips.
Add `PATCH /api/me/preferences` (upsert, shallow merge, last-write-wins), debounced ~500ms
because `patchLocal` fires on every slider tick. Server wins on read, user action wins on
write — never reconcile-and-write on boot, or a stale tab clobbers the phone.

## Worth pulling forward

**High-contrast preset.** Roughly a 22-line block once the token layer exists, mapped to
`prefers-contrast: more`. It is the one later-stage item with a real accessibility need behind
it.

## Later stages (upside, not scoped here)

- **Accent picker.** Users choose an accent hue; everything else derives. Cheap once roles exist.
- **User custom themes** as a constrained set of token values — a form, not a stylesheet.
- **Per-server branding.** Tempting, but it fights the user's own theme choice and needs a clear
  rule about who wins. Do not start it without that rule.

## Not doing: free-form CSS themes

User-authored CSS is untrusted input in the same document as the app. It enables UI redress
(an invisible overlay over the Leave Server button), exfiltration via attribute selectors and
`background-image: url(...)`, and spoofing of system dialogs. It also turns every bug report
into "disable your theme and retry".

The safe subset is **CSS custom property values only**, validated against a known token list,
each parsed as a colour rather than passed through as a string. That is a form with colour
inputs — which is stage 5, and it is enough.

## Effort summary

| Stage | Scope | Effort | Ships on its own |
|---|---|---|---|
| 1 | Role tokens, extract literals, `color-scheme` | 1–2 days | Fixes native-control chrome |
| 2 | Light + System, Clerk bridge, anti-flash | 3–4 days | The actual feature |
| 3 | `user_preferences`, settings sync | ~2 days | All settings follow the user |
| 3.5 | High-contrast preset | ~half a day | Accessibility |
| 4–6 | Accent picker, custom themes, server branding | — | Upside |
| 7 | Free-form CSS | — | Never |
