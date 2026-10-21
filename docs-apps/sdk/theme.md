# Theme

```ts
function applyTheme(theme: BridgeTheme, root?: ThemeRoot): void;

interface ThemeRoot {
  style: { setProperty(name: string, value: string): void };
}

type BridgeTheme = Record<string, string>; // CSS custom property name to value
```

Writes pqp's design tokens onto `root` (the document element by default) as CSS custom properties. Your stylesheet then reads them with `var(--color-text)` and your app matches the theme the person picked.

```ts
import { applyTheme, connect } from "@pqp/app-sdk";

const app = await connect();
applyTheme(app.hello.theme);                 // now
app.on("theme", (theme) => applyTheme(theme)); // and whenever they change it
```

It goes through the CSSOM (`style.setProperty`), which a frame under `style-src 'self'` is allowed to do, so it needs no inline style and no `unsafe-inline`. Pass your own `root` to scope the tokens to one element.

## The tokens

`hello.theme` and every `theme` push carry up to 64 properties: an allowlist of the design tokens in pqp's design system, read as the browser resolved them (so a `var()` alias arrives as the colour it points at), plus one that pqp adds for you.

| Group | Tokens |
|---|---|
| Surfaces | `--color-surface-0` `-1` `-2` `-3`, `--color-surface-card`, `--color-rail` |
| Borders | `--color-border`, `--color-border-strong` |
| Text | `--color-text`, `--color-text-secondary`, `--color-text-tertiary` |
| Accent | `--color-accent`, `--color-accent-hover`, `--color-on-accent` |
| Status | `--color-danger`, `--color-on-danger`, `--color-warning`, `--color-success` |
| Soft pairs | `--color-accent-soft` and `--color-on-accent-soft`, and the same for `danger`, `warning` and `success` |
| Focus | `--color-focus-ring`, `--color-selection` |
| Shape | `--radius-tick`, `--radius-control`, `--radius-card`, `--radius-panel`, `--radius-pill` |
| Type | `--font-sans`, `--font-display` (names of fonts; the font files are not sent, so keep a fallback) |
| Scheme | `--pqp-color-scheme`: `light` or `dark`, so you can set your own `color-scheme` |

Use the role tokens, not colours: `--color-surface-1` is "a panel" in every theme, while its value changes with brightness, skin, contrast and accent. Always give a fallback for the moment before the first push and for a page that does not send a token:

```css
body {
  background: var(--color-surface-0, #14181d);
  color: var(--color-text, #ece9de);
  border-radius: var(--radius-card, 0.5rem);
}
button {
  background: var(--color-accent, #b8ee3c);
  color: var(--color-on-accent, #14181d);
}
```

Pair them as the design system does: text on a surface, `on-accent` on `accent`, an `on-*-soft` on its `*-soft` fill. Every such pair is measured for contrast in pqp's own themes.

## Reduced motion

`app.hello.reducedMotion` is the operating system's setting. It is sent once, with the hello; honour it for any animation you start.
