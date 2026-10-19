import type { BridgeHello } from "@pqp/shared";
import { createApp, type PqpApp } from "./app.js";
import { PortClient, REQUEST_TIMEOUT_MS } from "./client.js";
import { PqpAppError } from "./errors.js";

/** The platform API version this SDK speaks (`APP_PLATFORM_API` in `@pqp/shared`). */
const PLATFORM_API = 1;

/** How often the hello is sent again until the host answers. The host answers only the first. */
const HELLO_RETRY_MS = 1000;

/** The slice of `window` the handshake needs, so a test can stand in for it. */
export interface HandshakeWindow {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface ConnectOptions {
  /** Time allowed for the handshake and for each later request. Default 15 000 ms. */
  timeoutMs?: number;
  /** Defaults to `window`. */
  window?: HandshakeWindow;
}

const inFlight = new WeakMap<object, Promise<PqpApp>>();

function isHello(data: unknown): data is BridgeHello {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Record<string, unknown>;
  return (
    message.type === "hello" &&
    message.platformApi === PLATFORM_API &&
    typeof message.app === "object" &&
    message.app !== null &&
    typeof message.self === "object" &&
    message.self !== null
  );
}

/**
 * Connects the app to the pqp page that is hosting it.
 *
 * 1. Posts `{ pqp: "app-hello", platformApi: 1 }` to `window.parent` with
 *    target `*`: the frame's origin is opaque, so the parent cannot be
 *    addressed by origin.
 * 2. Accepts exactly one `app-port` message, and only when `event.source` is
 *    `window.parent`. Anything else (a sibling frame, an extension) is ignored.
 * 3. Waits for the host's `hello` push on the port and resolves with the app.
 *
 * Call it once, early, and register `on` listeners right after it resolves;
 * use the `get` calls for the values from before. A second call from the same
 * window returns the first call's promise. If the host never answers within
 * `timeoutMs` the promise rejects with a `PqpAppError` whose code is
 * `unavailable`, also when the page is not framed by pqp at all.
 */
export function connect(options: ConnectOptions = {}): Promise<PqpApp> {
  const host: HandshakeWindow = options.window ?? (globalThis as unknown as { window: HandshakeWindow }).window;
  if (!host) {
    return Promise.reject(new PqpAppError("unavailable", "connect() needs a browser window"));
  }
  const existing = inFlight.get(host);
  if (existing) return existing;
  const attempt = handshake(host, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  inFlight.set(host, attempt);
  attempt.catch(() => inFlight.delete(host));
  return attempt;
}

function handshake(host: HandshakeWindow, timeoutMs: number): Promise<PqpApp> {
  const parent = host.parent;
  if ((parent as unknown) === (host as unknown)) {
    return Promise.reject(new PqpAppError("unavailable", "this page is not inside a pqp frame"));
  }
  return new Promise<PqpApp>((resolve, reject) => {
    let settled = false;
    let port: MessagePort | undefined;

    const cleanup = () => {
      host.removeEventListener("message", onMessage);
      clearInterval(retry);
      clearTimeout(timer);
    };
    const fail = (error: PqpAppError) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (port) port.close();
      reject(error);
    };

    function onMessage(event: MessageEvent) {
      if (settled || port) return;
      if (event.source !== parent) return;
      const data = event.data as Record<string, unknown> | null;
      if (typeof data !== "object" || data === null) return;
      if (data.pqp !== "app-port" || data.platformApi !== PLATFORM_API) return;
      const received = event.ports?.[0];
      if (!received) return;
      port = received;
      clearInterval(retry);
      host.removeEventListener("message", onMessage);

      const client = new PortClient(received, timeoutMs);
      const stop = client.on("hello", (push) => {
        stop();
        if (settled) return;
        if (!isHello(push)) {
          fail(new PqpAppError("unavailable", "pqp host sent an unusable hello"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(createApp(client, push));
      });
    }

    host.addEventListener("message", onMessage);
    const hello = { pqp: "app-hello", platformApi: PLATFORM_API };
    parent.postMessage(hello, "*");
    const retry = setInterval(() => parent.postMessage(hello, "*"), HELLO_RETRY_MS);
    const timer = setTimeout(
      () => fail(new PqpAppError("unavailable", "pqp did not answer the handshake")),
      timeoutMs,
    );
  });
}
