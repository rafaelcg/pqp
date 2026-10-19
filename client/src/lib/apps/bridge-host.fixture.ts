import type { JsonValue } from "@pqp/shared";
import { BridgeHost, type BridgeHostOptions } from "./bridge-host";
import type { ThemeSource } from "./theme-tokens";
import {
  type AppRuntimeConfig,
  type AppSessionHandlers,
  type AppSessionTransport,
  type AppUserDirectory,
  type SessionSnapshot,
} from "./types";

export const SELF_USER = "11111111-1111-4111-8111-111111111111";
export const BIA_USER = "22222222-2222-4222-8222-222222222222";
export const SELF_SEAT = "seat-selfselfselfself";
export const BIA_SEAT = "seat-biabiabiabiabia";

/** A 1x1 transparent png. */
export const PNG_BYTES = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

export function baseSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: "33333333-3333-4333-8333-333333333333",
    seatId: SELF_SEAT,
    role: "player",
    isHost: true,
    state: { rev: 0, value: null },
    participants: [
      { seatId: SELF_SEAT, userId: SELF_USER, role: "player", isHost: true, connection: "present" },
      { seatId: BIA_SEAT, userId: BIA_USER, role: "player", isHost: false, connection: "present", appUserId: "derived-id-1234567890" },
    ],
    ...overrides,
  };
}

export function baseApp(overrides: Partial<AppRuntimeConfig> = {}): AppRuntimeConfig {
  return {
    id: "pqp-eco",
    version: "1.0.0",
    entry: { url: "http://localhost:5175/pqp-eco/1.0.0/index.html" },
    capabilities: { share: "none", localFiles: { allowed: false } },
    state: { maxBytes: 64, maxWritesPerSecond: 10, writers: "participants" },
    events: { maxPerSecond: 5, maxBytes: 32 },
    assets: [],
    shareAllowed: false,
    ...overrides,
  };
}

export class FakeTransport implements AppSessionTransport {
  handlers: AppSessionHandlers | null = null;
  snapshot: SessionSnapshot;
  joinError: Error | null = null;
  patches: Array<{ patch: JsonValue; baseRev: number | undefined }> = [];
  patchError: Error | null = null;
  events: Array<{ name: string; data: JsonValue }> = [];
  left = 0;
  endCalls = 0;
  endError: Error | null = null;
  rev = 0;

  constructor(snapshot = baseSnapshot()) {
    this.snapshot = snapshot;
  }

  async join(): Promise<SessionSnapshot> {
    if (this.joinError) throw this.joinError;
    return this.snapshot;
  }
  leave(): void {
    this.left += 1;
  }
  async patchState(patch: JsonValue, baseRev: number | undefined): Promise<{ rev: number }> {
    if (this.patchError) throw this.patchError;
    this.patches.push({ patch, baseRev });
    this.rev += 1;
    return { rev: this.rev };
  }
  sendEvent(name: string, data: JsonValue): void {
    this.events.push({ name, data });
  }
  async end(): Promise<void> {
    this.endCalls += 1;
    if (this.endError) throw this.endError;
  }
  subscribe(handlers: AppSessionHandlers): () => void {
    this.handlers = handlers;
    return () => {
      this.handlers = null;
    };
  }
}

export class FakeTheme implements ThemeSource {
  theme: Record<string, string> = { "--color-text": "#eee", "--pqp-color-scheme": "dark" };
  motion = false;
  listener: (() => void) | null = null;
  read() {
    return { ...this.theme };
  }
  reducedMotion() {
    return this.motion;
  }
  subscribe(onChange: () => void) {
    this.listener = onChange;
    return () => {
      this.listener = null;
    };
  }
}

export const users: AppUserDirectory = {
  resolve: (userId) =>
    userId === SELF_USER
      ? { displayName: "Raf", avatarUrl: null }
      : userId === BIA_USER
        ? { displayName: "Bia", avatarUrl: "https://pqp.example/api/avatars/bia" }
        : null,
};

export function pngFetch(type = "image/png", body: Uint8Array = PNG_BYTES): typeof fetch {
  return (async () =>
    new Response(body as BodyInit, { status: 200, headers: { "content-type": type } })) as typeof fetch;
}

/** The app's end of the port, with request/response helpers. */
export class AppSide {
  readonly pushes: Array<Record<string, unknown>> = [];
  readonly responses = new Map<string, Record<string, unknown>>();
  private waiters = new Map<string, (value: Record<string, unknown>) => void>();
  private next = 0;
  readonly hello: Promise<Record<string, unknown>>;

  constructor(readonly port: MessagePort) {
    let resolveHello!: (value: Record<string, unknown>) => void;
    this.hello = new Promise((resolve) => (resolveHello = resolve));
    port.onmessage = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown>;
      if (typeof data.id === "string") {
        const waiter = this.waiters.get(data.id);
        if (waiter) waiter(data);
        else this.responses.set(data.id, data);
        return;
      }
      if (data.type === "hello") resolveHello(data);
      this.pushes.push(data);
    };
  }

  /** Sends a raw request and waits for the answer with its id. */
  call(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<Record<string, unknown>> {
    const id = typeof message.id === "string" ? message.id : `r${(this.next += 1)}`;
    const promise = new Promise<Record<string, unknown>>((resolve) => this.waiters.set(id, resolve));
    this.port.postMessage({ id, ...message }, transfer);
    return promise;
  }

  async settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export interface Rig {
  host: BridgeHost;
  transport: FakeTransport;
  theme: FakeTheme;
  app: AppSide;
  logs: Array<{ message: string; detail?: unknown }>;
  violations: string[];
  ended: string[];
}

/** A started host with its port attached and the hello delivered. */
export async function rig(
  options: {
    app?: Partial<AppRuntimeConfig>;
    snapshot?: SessionSnapshot;
    host?: Partial<BridgeHostOptions>;
    now?: () => number;
  } = {},
): Promise<Rig> {
  const transport = new FakeTransport(options.snapshot ?? baseSnapshot());
  const theme = new FakeTheme();
  const logs: Rig["logs"] = [];
  const violations: string[] = [];
  const ended: string[] = [];
  const host = new BridgeHost({
    app: baseApp(options.app),
    transport,
    users,
    locale: () => "pt-BR",
    theme,
    fetchImpl: pngFetch(),
    log: (message, detail) => logs.push({ message, detail }),
    onViolation: (reason) => violations.push(reason),
    onEnded: (reason) => ended.push(reason),
    now: options.now,
    ...options.host,
  });
  await host.start();
  const channel = new MessageChannel();
  const app = new AppSide(channel.port2);
  host.attach(channel.port1);
  await app.hello;
  return { host, transport, theme, app, logs, violations, ended };
}
