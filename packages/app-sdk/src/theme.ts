import type { BridgeTheme } from "@pqp/shared";

/** The part of an element `applyTheme` writes to; `document.documentElement` fits. */
export interface ThemeRoot {
  style: { setProperty(name: string, value: string): void };
}

/**
 * Writes the host's theme tokens (CSS custom properties) onto `root`, the
 * document element by default. It goes through the CSSOM, which a frame under
 * `style-src 'self'` may use, so it needs no inline style.
 */
export function applyTheme(theme: BridgeTheme, root: ThemeRoot = document.documentElement): void {
  for (const [name, value] of Object.entries(theme)) root.style.setProperty(name, value);
}
