import type { BridgeHello } from "./types.js";
import { createApp, type PqpApp } from "./app.js";
import { PortClient, REQUEST_TIMEOUT_MS } from "./client.js";
import type { ConnectOptions, HandshakeWindow } from "./connect.js";
import { PqpAppError } from "./errors.js";

/**
 * SAVES NA CONTA (`sync.*`, Locadora only, flag `locadora_save_sync`): a
 * battery save or a save state, with its picture, kept on the person's
 * account through the host. Never the game file.
 *
 * Its own module, and its own way in (`connectWithSync`), on purpose: the
 * bundle of every app carries `connect` and `createApp`, and a released app's
 * bytes may not change under its version (the catalog refuses it). An app that
 * never imports this file builds exactly as before. `connectWithSync` is
 * `connect` (the same handshake, the same checks: the port only from
 * `window.parent`, the hello in the shape every field is read as) that also
 * keeps the port's client for the `sync.*` calls. Folding it into `PqpApp` is
 * the next SDK change that bumps every app anyway.
 */

/** What the account holds, of the 8 MB it may, and what this device is called. */
export interface SyncStatus {
  /** `read-only`: the server stopped taking new saves; the old ones can still be taken back and deleted. */
  mode: "on" | "read-only";
  used: number;
  cap: number;
  device: "computer" | "phone" | "tablet";
}

/** One save on the account. Never a key, an object name or an account id. */
export interface SyncEntry {
  id: string;
  kind: "sram" | "state";
  slot: number;
  rev: number;
  size: number;
  /** SHA-256 of the stored bytes. */
  hash: string;
  savedAt: number;
  device: "computer" | "phone" | "tablet";
  thisDevice: boolean;
  thumb: boolean;
  platform: string;
  core: string;
  coreVersion: string;
  history: number;
}

export interface SyncPut {
  /** SHA-256 (hex) of the game file. It stays with the host, which turns it into the account's own key. */
  game: string;
  kind: "sram" | "state";
  slot: number;
  /** The rev this write replaces, 0 for none. A newer one on the account rejects with `stale-rev`. */
  baseRev: number;
  bytes: ArrayBuffer | ArrayBufferView;
  thumb?: ArrayBuffer | ArrayBufferView;
  platform: string;
  core: string;
  coreVersion: string;
}

/**
 * Every call rejects with `not-allowed` where Saves na conta is off (or the
 * app is not Locadora, or the seat is a spectator's) and with `invalid` on a
 * host that predates it.
 */
export interface SyncApi {
  status(): Promise<SyncStatus>;
  list(game: string): Promise<SyncEntry[]>;
  get(id: string): Promise<{ rev: number; bytes: ArrayBuffer; thumb: ArrayBuffer | null }>;
  put(save: SyncPut): Promise<{ id: string; rev: number; used: number; cap: number }>;
  delete(id: string): Promise<{ used: number; cap: number }>;
  /** The newest older battery save comes back as the current one. */
  restore(id: string, baseRev: number): Promise<{ id: string; rev: number }>;
  /** This game's saves, or every one without `game`. */
  clear(game?: string): Promise<{ deleted: number; used: number; cap: number }>;
}

type Kind = "number" | "string" | "array" | "buffer";

function isKind(value: unknown, kind: Kind): boolean {
  switch (kind) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "buffer":
      return typeof value === "object" && value !== null && Object.prototype.toString.call(value) === "[object ArrayBuffer]";
  }
}

function field<T>(result: unknown, key: string, kind: Kind): T {
  if (typeof result === "object" && result !== null && key in result) {
    const value = (result as Record<string, unknown>)[key];
    if (isKind(value, kind)) return value as T;
  }
  throw new PqpAppError("unavailable", `pqp host answered without a usable ${key}`);
}

/** A copy for the wire, so the caller's buffer is never detached. */
function wireBytes(bytes: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  const view = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  return view.slice().buffer;
}

const usage = (result: unknown) => ({ used: field<number>(result, "used", "number"), cap: field<number>(result, "cap", "number") });

/** The `sync.*` calls over a port client. The save is named `save` on the wire: `id` is the request's own. */
export function createSyncApi(client: PortClient): SyncApi {
  return {
    async status() {
      const result = await client.request<unknown>("sync.status");
      return {
        mode: field<SyncStatus["mode"]>(result, "mode", "string"),
        ...usage(result),
        device: field<SyncStatus["device"]>(result, "device", "string"),
      };
    },
    async list(game) {
      return field<SyncEntry[]>(await client.request<unknown>("sync.list", { game }), "entries", "array");
    },
    async get(id) {
      const result = await client.request<unknown>("sync.get", { save: id });
      const thumb = (result as { thumb?: unknown } | null)?.thumb;
      return {
        rev: field<number>(result, "rev", "number"),
        bytes: field<ArrayBuffer>(result, "bytes", "buffer"),
        thumb: thumb === null || thumb === undefined ? null : field<ArrayBuffer>(result, "thumb", "buffer"),
      };
    },
    async put(save) {
      const params: Record<string, unknown> = {
        game: save.game,
        kind: save.kind,
        slot: save.slot,
        baseRev: save.baseRev,
        bytes: wireBytes(save.bytes),
        platform: save.platform,
        core: save.core,
        coreVersion: save.coreVersion,
      };
      if (save.thumb !== undefined) params.thumb = wireBytes(save.thumb);
      const result = await client.request<unknown>("sync.put", params);
      return { id: field<string>(result, "id", "string"), rev: field<number>(result, "rev", "number"), ...usage(result) };
    },
    async delete(id) {
      return usage(await client.request<unknown>("sync.delete", { save: id }));
    },
    async restore(id, baseRev) {
      const result = await client.request<unknown>("sync.restore", { save: id, baseRev });
      return { id: field<string>(result, "id", "string"), rev: field<number>(result, "rev", "number") };
    },
    async clear(game) {
      const result = await client.request<unknown>("sync.clear", game === undefined ? {} : { game });
      return { deleted: field<number>(result, "deleted", "number"), ...usage(result) };
    },
  };
}

const PLATFORM_API = 1;
const HELLO_RETRY_MS = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The same check `connect` makes: every field an app reads, in the kind it is read as. */
function isHello(data: unknown): data is BridgeHello {
  if (!isRecord(data) || data.type !== "hello" || data.platformApi !== PLATFORM_API) return false;
  const { app, self } = data;
  return (
    isRecord(app) &&
    typeof app.id === "string" &&
    typeof app.version === "string" &&
    typeof data.locale === "string" &&
    isRecord(data.theme) &&
    typeof data.reducedMotion === "boolean" &&
    isRecord(self) &&
    typeof self.seatId === "string" &&
    (self.role === "player" || self.role === "spectator") &&
    typeof self.isHost === "boolean" &&
    (data.connection === "online" || data.connection === "reconnecting")
  );
}

/** `connect()`, plus the `sync.*` calls on the same port. Call it once, instead of `connect`. */
export function connectWithSync(options: ConnectOptions = {}): Promise<{ app: PqpApp; sync: SyncApi }> {
  const host: HandshakeWindow | undefined = options.window ?? (globalThis as unknown as { window?: HandshakeWindow }).window;
  if (!host) return Promise.reject(new PqpAppError("unavailable", "connectWithSync() needs a browser window"));
  const parent = host.parent;
  if ((parent as unknown) === (host as unknown)) {
    return Promise.reject(new PqpAppError("unavailable", "this page is not inside a pqp frame"));
  }
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
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
      port?.close();
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
      host!.removeEventListener("message", onMessage);
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
        resolve({ app: createApp(client, push), sync: createSyncApi(client) });
      });
    }
    host.addEventListener("message", onMessage);
    const hello = { pqp: "app-hello", platformApi: PLATFORM_API };
    parent.postMessage(hello, "*");
    const retry = setInterval(() => parent.postMessage(hello, "*"), HELLO_RETRY_MS);
    const timer = setTimeout(() => fail(new PqpAppError("unavailable", "pqp did not answer the handshake")), timeoutMs);
  });
}
