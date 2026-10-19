import { bridgeThemeSchema, type BridgeTheme } from "@pqp/shared";

/**
 * The design-system custom properties an app is told about (docs/DESIGN.md:
 * the role tokens, not the reference values). An allowlist, not "every custom
 * property": the app is untrusted and the page defines hundreds of names, some
 * of which are not for anybody else.
 */
export const APP_THEME_TOKENS = [
  "--color-surface-0",
  "--color-surface-1",
  "--color-surface-2",
  "--color-surface-3",
  "--color-surface-card",
  "--color-rail",
  "--color-border",
  "--color-border-strong",
  "--color-text",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-accent",
  "--color-accent-hover",
  "--color-on-accent",
  "--color-danger",
  "--color-on-danger",
  "--color-warning",
  "--color-success",
  "--color-accent-soft",
  "--color-on-accent-soft",
  "--color-danger-soft",
  "--color-on-danger-soft",
  "--color-warning-soft",
  "--color-on-warning-soft",
  "--color-success-soft",
  "--color-on-success-soft",
  "--color-focus-ring",
  "--color-selection",
  "--radius-tick",
  "--radius-control",
  "--radius-card",
  "--radius-panel",
  "--radius-pill",
  "--font-sans",
  "--font-display",
] as const;

/** `light` or `dark`, so an app can set its own `color-scheme`. Not a pqp token: the host adds it. */
export const APP_COLOR_SCHEME_TOKEN = "--pqp-color-scheme";

const MAX_VALUE_CHARS = 256;

/**
 * Reads the allowlisted tokens from `root` as the browser resolved them (so a
 * `var()` alias arrives as the colour it points at). A token that is unset, or
 * longer than the bridge allows, is left out. At most 64 tokens.
 */
export function readThemeTokens(
  root: HTMLElement = document.documentElement,
  getStyle: (el: Element) => CSSStyleDeclaration = (el) => getComputedStyle(el),
): BridgeTheme {
  const style = getStyle(root);
  const theme: Record<string, string> = {};
  for (const name of APP_THEME_TOKENS) {
    const value = style.getPropertyValue(name).trim();
    if (value !== "" && value.length <= MAX_VALUE_CHARS) theme[name] = value;
  }
  theme[APP_COLOR_SCHEME_TOKEN] = root.dataset.theme === "light" ? "light" : "dark";
  const parsed = bridgeThemeSchema.safeParse(theme);
  return parsed.success ? parsed.data : {};
}

export function sameTheme(a: BridgeTheme, b: BridgeTheme): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

export interface ThemeSource {
  read(): BridgeTheme;
  /** Calls `onChange` when the page's theme may have changed. Returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
  reducedMotion(): boolean;
}

/** The page's real theme: the root element's attributes and style, and the OS motion setting. */
export function domThemeSource(): ThemeSource {
  return {
    read: () => readThemeTokens(),
    reducedMotion: () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    subscribe(onChange) {
      // brightness, skin, contrast and the custom accent are attributes (and a
      // style for the custom hue) on <html>; a change is one mutation
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-appearance", "data-contrast", "data-accent", "style", "class"],
      });
      const motion =
        typeof window.matchMedia === "function"
          ? window.matchMedia("(prefers-reduced-motion: reduce)")
          : null;
      motion?.addEventListener("change", onChange);
      return () => {
        observer.disconnect();
        motion?.removeEventListener("change", onChange);
      };
    },
  };
}
