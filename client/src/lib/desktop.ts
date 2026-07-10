export interface PqpDesktop {
  platform: string;
  isElectron: true;
  hasCustomTitleBar: boolean;
  onToggleMute(cb: () => void): () => void;
  /** In-app path under `/app` (main process maps `pqp://` → `/app/...`). */
  onDeepLink(cb: (appPath: string) => void): () => void;
  getPendingDeepLink(): Promise<string | null>;
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
