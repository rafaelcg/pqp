export interface PqpDesktop {
  platform: string;
  isElectron: true;
  hasCustomTitleBar: boolean;
  onToggleMute(cb: () => void): () => void;
  /** In-app path under `/app` (main process maps `pqp://` → `/app/...`). */
  onDeepLink(cb: (appPath: string) => void): () => void;
  getPendingDeepLink(): Promise<string | null>;
  /**
   * Present only in shells that answer display-media requests. Older shells
   * predate the handler, so absence means "too old to share a screen" rather
   * than "unknown" — see `desktopPredatesScreenShare`.
   */
  canShareScreen?: true;
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
  /**
   * Present only in shells that open Clerk in the system browser. Absence
   * means keep the in-app modal — the hosted client runs inside older
   * binaries, same as `canShareScreen`.
   */
  startDesktopAuth?(
    mode: "sign-in" | "sign-up",
  ): Promise<{ ok: boolean; url: string }>;
  cancelDesktopAuth?(): Promise<void>;
  getDesktopAuthStatus?(): Promise<{ active: boolean; url: string | null }>;
  getPendingDesktopAuthTicket?(): Promise<string | null>;
  onDesktopAuthTicket?(cb: (ticket: string) => void): () => void;
  onDesktopAuthEnded?(cb: (reason: "expired" | "cancelled") => void): () => void;
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
 * True in a desktop shell too old to capture a screen.
 *
 * WHY ABSENCE IS THE TEST. The shell gained
 * `setDisplayMediaRequestHandler` in 92ab7f7, which never reached a tagged
 * release — so every installed build was one that Chromium happily gave a
 * `getDisplayMedia` to and then had no embedder to answer it. The rejection
 * looks identical to a browser that cannot capture at all, and the client
 * said so, which was wrong and unactionable: the user's app *can* do this,
 * theirs is just old.
 *
 * The shell loads the live web client, so a client deployed today runs inside
 * a shell built weeks ago. Feature-detecting the shell is therefore the only
 * honest way to tell those two failures apart, and a missing key is a
 * perfectly good detector: old shells cannot have opted in to a flag that did
 * not exist when they were built.
 *
 * False in a browser. A browser that cannot share is genuinely unsupported and
 * already has its own wording; telling somebody on Firefox to update a desktop
 * app they do not have would be worse than the bug this replaces.
 */
export function desktopPredatesScreenShare(): boolean {
  const desktop = getDesktop();
  return desktop !== undefined && desktop.canShareScreen !== true;
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
