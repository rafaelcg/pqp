import { signedOutRedirectPath } from "@/lib/app-route";

const STASH_KEY = "pqp:desktop-login";

export const DESKTOP_LOGIN_MIN_PORT = 1024;
export const DESKTOP_LOGIN_MAX_PORT = 65535;

export type DesktopLoginMode = "sign-in" | "sign-up";

export interface DesktopLoginParams {
  mode: DesktopLoginMode;
  returnUrl: string | null;
  state: string | null;
  next: string | null;
  done: boolean;
}

/**
 * The only URL the browser page may send a ticket to.
 *
 * Parsed, then checked field by field. "Looks like loopback" is how
 * `127.1` and `0x7f.0.0.1` sneak through a string prefix. `localhost` and
 * `[::1]` are refused on purpose: Electron bound 127.0.0.1 and nothing else.
 */
export function parseDesktopLoopbackReturn(value: string | null): string | null {
  if (!value) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") {
    return null;
  }
  if (parsed.hostname !== "127.0.0.1") {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  if (parsed.pathname !== "/callback") {
    return null;
  }
  if (parsed.search || parsed.hash) {
    return null;
  }
  const port = Number(parsed.port);
  if (
    !Number.isInteger(port) ||
    port < DESKTOP_LOGIN_MIN_PORT ||
    port > DESKTOP_LOGIN_MAX_PORT
  ) {
    return null;
  }
  return `http://127.0.0.1:${port}/callback`;
}

export function parseDesktopLoginSearch(search: string): DesktopLoginParams {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const mode = params.get("mode") === "sign-up" ? "sign-up" : "sign-in";
  const nextRaw = params.get("next");
  return {
    mode,
    returnUrl: parseDesktopLoopbackReturn(params.get("return")),
    state: params.get("state"),
    next: nextRaw ? signedOutRedirectPath(nextRaw) : null,
    done: params.get("done") === "1",
  };
}

export function stashDesktopLoginParams(params: DesktopLoginParams): void {
  try {
    sessionStorage.setItem(STASH_KEY, JSON.stringify(params));
  } catch {
    // Storage denied. The URL query is still there on this document.
  }
}

export function readStashedDesktopLoginParams(): DesktopLoginParams | null {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<DesktopLoginParams>;
    return {
      mode: parsed.mode === "sign-up" ? "sign-up" : "sign-in",
      returnUrl: parseDesktopLoopbackReturn(parsed.returnUrl ?? null),
      state: typeof parsed.state === "string" ? parsed.state : null,
      next:
        typeof parsed.next === "string"
          ? signedOutRedirectPath(parsed.next)
          : null,
      done: parsed.done === true,
    };
  } catch {
    return null;
  }
}

export function clearStashedDesktopLoginParams(): void {
  try {
    sessionStorage.removeItem(STASH_KEY);
  } catch {
    // ignore
  }
}

export function resolveDesktopLoginParams(search: string): DesktopLoginParams {
  const fromUrl = parseDesktopLoginSearch(search);
  if (fromUrl.done) {
    return fromUrl;
  }
  if (fromUrl.returnUrl || fromUrl.state) {
    stashDesktopLoginParams(fromUrl);
    return fromUrl;
  }
  return readStashedDesktopLoginParams() ?? fromUrl;
}

export function desktopLoginHandoffHref(origin: string, params: DesktopLoginParams): string {
  const url = new URL("/desktop-login", origin);
  url.searchParams.set("mode", params.mode);
  if (params.returnUrl) {
    url.searchParams.set("return", params.returnUrl);
  }
  if (params.state) {
    url.searchParams.set("state", params.state);
  }
  if (params.next && params.next !== "/app") {
    url.searchParams.set("next", params.next);
  }
  return url.toString();
}

export function loopbackHandoffUrl(
  returnUrl: string,
  ticket: string,
  state: string | null,
): string {
  const url = new URL(returnUrl);
  url.searchParams.set("ticket", ticket);
  if (state) {
    url.searchParams.set("state", state);
  }
  return url.toString();
}
