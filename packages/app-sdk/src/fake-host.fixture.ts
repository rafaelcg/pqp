import type { BridgeHello } from "./types.js";
import type { HandshakeWindow } from "./connect.js";

export const HELLO: BridgeHello = {
  type: "hello",
  platformApi: 1,
  app: { id: "eco", version: "1.0.0" },
  locale: "pt-BR",
  theme: { "--bg": "#111111", "--fg": "#eeeeee" },
  reducedMotion: false,
  self: { seatId: "seat-aaaaaaaaaaaaaaaa", role: "player", isHost: true },
  connection: "online",
};

interface Request {
  id: string;
  type: string;
  [key: string]: unknown;
}

/**
 * A stand-in for the pqp page: a fake `window` for the handshake and a real
 * `MessageChannel` for the port, so the SDK is exercised against the same
 * structured-clone behaviour a browser has.
 */
export class FakeHost {
  readonly posted: Array<{ message: unknown; targetOrigin: string }> = [];
  readonly requests: Request[] = [];
  readonly parent = {
    postMessage: (message: unknown, targetOrigin: string) => {
      this.posted.push({ message, targetOrigin });
    },
  };
  readonly listeners = new Set<(event: MessageEvent) => void>();
  readonly window: HandshakeWindow = {
    parent: this.parent,
    addEventListener: (_type, listener) => {
      this.listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      this.listeners.delete(listener);
    },
  };
  private channel = new MessageChannel();
  private readonly hostPort = this.channel.port1;
  private waiting: Array<() => void> = [];
  /** The type of every request seen, so an answer can echo it the way the real host does. */
  private readonly types = new Map<string, string>();

  constructor() {
    this.hostPort.onmessage = (event: MessageEvent) => {
      const request = event.data as Request;
      this.types.set(request.id, request.type);
      this.requests.push(request);
      for (const wake of this.waiting.splice(0)) wake();
    };
  }

  /** A `message` event on the app's window, from `source` (the parent by default). */
  deliver(data: unknown, options: { source?: unknown; ports?: unknown[] } = {}): void {
    const event = {
      data,
      source: "source" in options ? options.source : this.parent,
      ports: options.ports ?? [],
    } as unknown as MessageEvent;
    for (const listener of [...this.listeners]) listener(event);
  }

  /** The host's answer to `app-hello`: the port, then the hello push on it. */
  accept(hello: BridgeHello = HELLO): void {
    this.deliver(
      { pqp: "app-port", platformApi: 1 },
      { ports: [this.channel.port2] },
    );
    this.hostPort.postMessage(hello);
  }

  push(message: unknown): void {
    this.hostPort.postMessage(message);
  }

  /** A success answer. `type` is the request's own unless a test says otherwise (`null` leaves it out). */
  respond(id: string, result: unknown, transfer: Transferable[] = [], type?: string | null): void {
    const echoed = type === undefined ? this.types.get(id) : type;
    this.hostPort.postMessage({ id, ok: true, ...(echoed === null ? {} : { type: echoed }), result }, transfer);
  }

  fail(id: string, error: string): void {
    this.hostPort.postMessage({ id, ok: false, error });
  }

  /** The next request the app sent (already received ones first). */
  async nextRequest(): Promise<Request> {
    for (;;) {
      const next = this.requests.shift();
      if (next) return next;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  /** Waits a few ticks so pushes sent on the port have been delivered. */
  async settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  close(): void {
    this.channel.port1.close();
    this.channel.port2.close();
  }
}
