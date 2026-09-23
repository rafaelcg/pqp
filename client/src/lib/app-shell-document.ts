import { useLayoutEffect } from "react";

/**
 * The attribute `index.css` keys the app shell's document rules on.
 *
 * `/app` is a fixed frame whose panes scroll; the document under it must never
 * scroll, not by a wheel that chains past the end of a pane and not by script.
 * The marketing pages (`/`, `/vem`, `/c/<slug>`, `/@handle`) are ordinary
 * scrolling documents, so the rule cannot live on `html` unconditionally: it is
 * switched on while the app route is mounted and off again when it leaves.
 */
export const APP_SHELL_ATTRIBUTE = "data-app-shell";

export function useAppShellDocument(): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute(APP_SHELL_ATTRIBUTE, "");
    return () => root.removeAttribute(APP_SHELL_ATTRIBUTE);
  }, []);
}
