import { useCallback, useMemo, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { jamPath, parseJamLocation, mainSiteOrigin, type JamLocation, type JamView } from "./route";

/**
 * A router for two routes. `react-router-dom` is the app's and would be most of
 * this bundle for a home and a song, so the site reads the address itself and
 * moves with `pushState`. The shape of an address is `route.ts`'s; this file is
 * only the browser half: a store over `location`, `navigate`, and a `Link`.
 */

const EVENT = "pqp:jam-navigate";

function subscribe(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(EVENT, listener);
  };
}

const snapshot = () => `${window.location.pathname}${window.location.search}`;

export interface JamRoute extends JamLocation {
  search: URLSearchParams;
}

export function useJamRoute(): JamRoute {
  const href = useSyncExternalStore(subscribe, snapshot, () => "/");
  return useMemo(() => {
    const url = new URL(href, window.location.origin);
    const found = parseJamLocation({ hostname: window.location.hostname, pathname: url.pathname });
    // Mounted by the entry, which only runs on a jam address: a path that is not
    // one (a stale tab, a test) reads as the path mount's home.
    return { ...(found ?? { mount: "path" as const, view: { kind: "home" as const } }), search: url.searchParams };
  }, [href]);
}

export function navigateTo(path: string, options: { replace?: boolean; state?: unknown } = {}): void {
  if (options.replace) {
    window.history.replaceState(options.state ?? null, "", path);
  } else {
    window.history.pushState(options.state ?? null, "", path);
  }
  window.dispatchEvent(new Event(EVENT));
  window.scrollTo(0, 0);
}

/** Where the main site (the app) is, from the page we are on. */
export function mainOrigin(): string {
  return mainSiteOrigin({
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    port: window.location.port,
  });
}

/** Path of a view, for the mount we are on. */
export function useViewPath(mount: JamLocation["mount"]): (view: JamView) => string {
  return useCallback((view: JamView) => jamPath(mount, view), [mount]);
}

export function Link({
  href,
  state,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; state?: unknown }) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      rest.target === "_blank"
    ) {
      return;
    }
    event.preventDefault();
    navigateTo(href, { state });
  };
  return <a href={href} onClick={handle} {...rest} />;
}
