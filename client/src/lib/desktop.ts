export interface PqpDesktop {
  platform: string;
  isElectron: true;
  hasCustomTitleBar: boolean;
  onToggleMute(cb: () => void): () => void;
  /** In-app path under `/app` (main process maps `pqp://` → `/app/...`). */
  onDeepLink(cb: (appPath: string) => void): () => void;
  getPendingDeepLink(): Promise<string | null>;
  /** Older shells predate theming, so this may be absent. */
  setTheme?(theme: "dark" | "light"): void;
  /** Persist the UI locale in the main process and rebuild the app menu. */
  setLocale?(locale: "en" | "pt-BR"): Promise<string | null>;
  /** Dock / taskbar mention count. Older shells predate notifications. */
  setBadgeCount?(count: number): void;
  /**
   * Show an OS notification from the main process rather than the renderer,
   * which is the only side that can raise the window when it is clicked.
   */
  notify?(payload: {
    title: string;
    body: string;
    /** Collapses repeats from the same channel onto one notification. */
    tag: string;
    /** In-app path under `/app` to open on click. */
    path: string;
  }): void;
  onNotificationClick?(cb: (appPath: string) => void): () => void;
}

export function getDesktop(): PqpDesktop | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.pqpDesktop;
}

export function isDesktopApp(): boolean {
  return getDesktop()?.isElectron === true;
}

/** i18next `context` for permission copy that must not say "browser" in Electron. */
export function desktopContext(): { context: "desktop" } | undefined {
  return isDesktopApp() ? { context: "desktop" } : undefined;
}

/**
 * Normalize a deep-link payload to an `/app` path.
 * Accepts either a mapped path (`/app/...`) or a raw `pqp://` URL.
 */
export function deepLinkToAppPath(input: string): string {
  if (!input) {
    return "/app";
  }
  if (input.startsWith("/app")) {
    return input;
  }
  if (input.startsWith("/")) {
    return `/app${input === "/" ? "" : input}`;
  }
  if (!input.startsWith("pqp://")) {
    return `/app/${input.replace(/^\/+/, "")}`;
  }
  try {
    const parsed = new URL(input);
    const host = parsed.hostname;
    const rest = parsed.pathname.replace(/^\/+|\/+$/g, "");
    const segments = [host, rest].filter(Boolean).join("/");
    if (!segments || segments === "open" || segments === "app") {
      return "/app";
    }
    if (segments.startsWith("app/")) {
      return `/${segments}`;
    }
    return `/app/${segments}`;
  } catch {
    return "/app";
  }
}
