import { getDesktop } from "@/lib/desktop";

/**
 * Slim drag region for Electron on macOS (hiddenInset title bar).
 * Traffic lights sit in the left inset; the rest of the bar is draggable.
 */
export function DesktopTitleBar() {
  const desktop = getDesktop();
  if (!desktop?.hasCustomTitleBar) {
    return null;
  }

  return (
    <header
      aria-hidden
      className="desktop-drag flex h-10 shrink-0 items-center border-b border-ink-4/50 bg-rail"
    >
      <div className="pointer-events-none pl-[76px] font-display text-[11px] font-semibold tracking-[0.18em] text-paper-muted uppercase">
        pqp
      </div>
    </header>
  );
}
