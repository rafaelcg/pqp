import { APP_PLATFORM_API, bridgeAppHelloSchema, type AppEndReason } from "@pqp/shared";
import { isOnAppsOrigin } from "./apps-origin";
import { BridgeHost, type BridgeHostOptions } from "./bridge-host";
import { ensureAppFramePolicy } from "./frame-policy";
import {
  AppTransportError,
  type AppErrorCode,
  type AppRuntimeConfig,
  type AppSessionTransport,
  type AppUserDirectory,
} from "./types";

export type AppFrameErrorReason =
  /** The entry URL is not on the apps origin, so nothing was framed. */
  | "bad-entry"
  /** The seat was refused (full, not allowed, ended): see `code`. */
  | "join-failed"
  /** The frame never said hello. */
  | "timeout"
  /** The frame loaded a second document: it navigated itself. It was removed. */
  | "frame-navigated"
  /** The app flooded the bridge. It was removed. */
  | "flood";

export type AppFrameStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; reason: AppFrameErrorReason; code?: AppErrorCode }
  | { kind: "ended"; reason: AppEndReason };

export interface AppFrameControllerOptions {
  /** Where the iframe goes. The controller owns its content. */
  container: HTMLElement;
  app: AppRuntimeConfig;
  /** From `GET /api/apps/config`, already through `parseAppsOrigin`. */
  appsOrigin: string;
  /** The iframe's accessible name. */
  title: string;
  transport: AppSessionTransport;
  users: AppUserDirectory;
  locale: () => string;
  asSpectator?: boolean;
  initialHeight?: number;
  /** Origins this deployment frames besides the built-in list (Clerk's frontend host). */
  extraFrameOrigins?: readonly string[];
  /** How long the frame has to say hello. Default 20 s. */
  helloTimeoutMs?: number;
  onStatus?: (status: AppFrameStatus) => void;
  /** Called with the height an app asked for through `ui.resize`. */
  onResize?: (height: number) => void;
  /** pqp's own screen share flow; resolves to whether the pane is shared now. */
  onShare?: (on: boolean) => Promise<boolean>;
  /** Forwarded to the bridge host (tests stand in for the picker, theme and fetch). */
  host?: Pick<BridgeHostOptions, "pickFile" | "theme" | "fetchImpl" | "now" | "log">;
}

export interface AppFrameController {
  /** Move focus to the frame (its one tab stop). */
  focus(): void;
  /** Remove the frame, release the seat, stop listening. Safe to call twice. */
  destroy(): void;
  readonly status: AppFrameStatus;
}

const DEFAULT_HELLO_TIMEOUT_MS = 20_000;
const DEFAULT_HEIGHT = 360;

/**
 * Puts one app in a sandboxed frame and runs its bridge. The React component
 * `AppFrame` is a thin wrapper; the end-to-end suite drives this directly.
 *
 * Order of events, and why:
 *
 * 1. The page's `frame-src` policy goes in BEFORE the frame exists
 *    (`ensureAppFramePolicy`), so a frame that navigates itself is stopped by
 *    the browser and not just noticed afterwards.
 * 2. The frame is `<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer">`:
 *    no `allow-same-origin` (an opaque origin: no cookies, no storage, no way to
 *    reach this page), no `allow-popups`, no `allow-forms`, no `allow-top-navigation`,
 *    and no permissions policy features.
 * 3. The seat is taken (`host.start`) while the frame loads. The frame's
 *    `app-hello` is answered only when it came from THIS frame's window
 *    (`event.source`, the only identity an opaque origin has) and only after the
 *    seat exists, with one end of a `MessageChannel` transferred.
 * 4. A SECOND `load` event of the frame means it left the document it was given
 *    (it navigated itself, or something reloaded it): the frame is removed and
 *    the failure is reported. A legitimate app never reloads itself.
 *
 * KEYBOARD CONTRACT. The frame is one tab stop and the page never traps focus:
 * no key handler on the page calls `preventDefault` or `stopPropagation` on
 * behalf of the frame, and the page installs no keyboard listener that captures
 * Escape. Focus enters the frame with Tab and leaves it the way it leaves any
 * iframe, with Tab or Shift+Tab past the app's first or last control; the page
 * cannot see keys pressed inside the frame, so an app that traps focus traps
 * the person and fails review. `focus()` puts focus on the frame from outside
 * (the UI around it uses that to hand focus back after a dialog closes).
 * Escape leaves fullscreen (the browser's own handling), and nothing else.
 */
export function mountAppFrame(options: AppFrameControllerOptions): AppFrameController {
  const { container, app } = options;
  let status: AppFrameStatus = { kind: "loading" };
  let destroyed = false;
  let answered = false;
  let loads = 0;
  let iframe: HTMLIFrameElement | null = null;
  const timers: { hello?: ReturnType<typeof setTimeout> } = {};

  const setStatus = (next: AppFrameStatus) => {
    if (destroyed) return;
    // an end of the session or a removal is final
    if (status.kind === "error" || status.kind === "ended") return;
    status = next;
    options.onStatus?.(next);
  };

  const host = new BridgeHost({
    app,
    transport: options.transport,
    users: options.users,
    locale: options.locale,
    ...options.host,
    ui: {
      resize: (height) => {
        if (iframe) iframe.style.height = `${height}px`;
        options.onResize?.(height);
      },
      fullscreen: async (on) => {
        if (!iframe) return false;
        const doc = iframe.ownerDocument;
        if (on && doc.fullscreenElement !== iframe) await iframe.requestFullscreen();
        if (!on && doc.fullscreenElement === iframe) await doc.exitFullscreen();
        return doc.fullscreenElement === iframe;
      },
      share: (on) => (options.onShare ? options.onShare(on) : Promise.reject(new Error("no share flow"))),
    },
    onViolation: () => remove("flood"),
    onEnded: (reason) => setStatus({ kind: "ended", reason }),
  });

  /** Take the frame out of the page and stop talking to it. */
  function remove(reason: AppFrameErrorReason, code?: AppErrorCode) {
    clearTimeout(timers.hello);
    window.removeEventListener("message", onMessage);
    iframe?.remove();
    iframe = null;
    host.detach();
    host.leave();
    setStatus({ kind: "error", reason, code });
  }

  let started: Promise<boolean> = Promise.resolve(false);

  function onMessage(event: MessageEvent) {
    const frame = iframe;
    // the only identity an opaque origin has is its window
    if (!frame || event.source !== frame.contentWindow) return;
    if (answered) return;
    if (!bridgeAppHelloSchema.safeParse(event.data).success) return;
    answered = true;
    clearTimeout(timers.hello);
    void started.then((joined) => {
      if (!joined || destroyed || iframe !== frame || !frame.contentWindow) return;
      const channel = new MessageChannel();
      host.attach(channel.port1);
      // an opaque origin cannot be named as a target, so '*' (the receiver
      // checks `event.source`, and only the frame's window is listening)
      frame.contentWindow.postMessage({ pqp: "app-port", platformApi: APP_PLATFORM_API }, "*", [channel.port2]);
      setStatus({ kind: "ready" });
    });
  }

  if (!isOnAppsOrigin(app.entry.url, options.appsOrigin)) {
    remove("bad-entry");
    return controller();
  }

  ensureAppFramePolicy(
    { appsOrigin: options.appsOrigin, extraOrigins: options.extraFrameOrigins },
    container.ownerDocument,
  );

  const element = container.ownerDocument.createElement("iframe");
  element.setAttribute("sandbox", "allow-scripts");
  element.setAttribute("allow", "");
  element.setAttribute("referrerpolicy", "no-referrer");
  element.setAttribute("title", options.title);
  element.setAttribute("data-app-frame", app.id);
  element.style.width = "100%";
  element.style.height = `${options.initialHeight ?? DEFAULT_HEIGHT}px`;
  element.style.border = "0";
  element.addEventListener("load", () => {
    loads += 1;
    if (loads >= 2) remove("frame-navigated");
  });
  iframe = element;
  window.addEventListener("message", onMessage);
  timers.hello = setTimeout(
    () => remove("timeout"),
    options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
  );
  // src BEFORE the frame joins the page: an iframe appended with no src loads
  // about:blank first and fires a `load` of its own, which would read as a second
  // document. The listeners, the policy and every attribute are in place already.
  element.setAttribute("src", app.entry.url);
  container.append(element);
  // the seat is taken while the frame loads
  started = (async () => {
    try {
      await host.start({ asSpectator: options.asSpectator });
      return true;
    } catch (error) {
      remove("join-failed", error instanceof AppTransportError ? error.code : "unavailable");
      return false;
    }
  })();

  function controller(): AppFrameController {
    return {
      focus: () => iframe?.focus(),
      destroy() {
        if (destroyed) return;
        clearTimeout(timers.hello);
        window.removeEventListener("message", onMessage);
        iframe?.remove();
        iframe = null;
        host.detach();
        host.leave();
        destroyed = true;
      },
      get status() {
        return status;
      },
    };
  }
  return controller();
}
