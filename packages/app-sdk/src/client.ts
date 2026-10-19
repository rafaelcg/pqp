import type { BridgeErrorCode } from "@pqp/shared";
import { isErrorCode, PqpAppError } from "./errors.js";

/** How long a request may wait for the host before it rejects with `unavailable`. */
export const REQUEST_TIMEOUT_MS = 15_000;

export type Unsubscribe = () => void;

interface Pending {
  /** The request type, so a success that answers another call is refused. */
  type: string;
  resolve: (result: unknown) => void;
  reject: (error: PqpAppError) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The request and push plumbing over the port the host handed over. It trusts
 * the host (pqp itself) for the shape of what it sends, and ignores anything
 * it does not recognise rather than throwing inside a message handler.
 */
export class PortClient {
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<string, Set<(push: Record<string, unknown>) => void>>();
  private endedFlag = false;

  constructor(
    private readonly port: MessagePort,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {
    port.onmessage = (event) => this.receive(event.data);
  }

  get ended(): boolean {
    return this.endedFlag;
  }

  /** After `session.ended` every call fails the same way the host would answer it. */
  markEnded(): void {
    this.endedFlag = true;
  }

  request<T>(type: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.endedFlag) return Promise.reject(new PqpAppError("ended"));
    this.nextId += 1;
    const id = String(this.nextId);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PqpAppError("unavailable", `pqp app call ${type} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { type, resolve: resolve as (r: unknown) => void, reject, timer });
      try {
        this.port.postMessage({ ...params, id, type });
      } catch {
        // structured clone refused the value (a function, a symbol, ...)
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new PqpAppError("invalid", `pqp app call ${type} carries a value that cannot be sent`));
      }
    });
  }

  on(type: string, listener: (push: Record<string, unknown>) => void): Unsubscribe {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private receive(data: unknown): void {
    if (!isRecord(data)) return;
    if (typeof data.id === "string" && typeof data.ok === "boolean") {
      const entry = this.pending.get(data.id);
      if (!entry) return; // late, duplicate or unknown: nothing is waiting
      this.pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.ok) {
        // a success echoes the request type; one that names another call, or none, is not an answer to this one
        const expectsNull = entry.type === "events.send" || entry.type === "session.end";
        if (data.type !== entry.type || (expectsNull && data.result !== null)) {
          entry.reject(new PqpAppError("unavailable", `pqp host answered ${entry.type} with a reply that does not match it`));
        } else {
          entry.resolve(data.result);
        }
      } else {
        const code: BridgeErrorCode = isErrorCode(data.error) ? data.error : "unavailable";
        entry.reject(new PqpAppError(code));
      }
      return;
    }
    if (typeof data.type === "string") {
      const set = this.listeners.get(data.type);
      if (!set) return;
      for (const listener of [...set]) {
        try {
          listener(data);
        } catch (error) {
          // one app callback throwing must not stop the others or the port
          console.error("pqp app listener threw", error);
        }
      }
    }
  }
}
