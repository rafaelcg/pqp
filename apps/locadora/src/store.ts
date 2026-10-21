/**
 * Where Locadora keeps what a person would miss: the shelf, the saves, the
 * preferences. The frame has no storage of its own (opaque origin), so the real
 * adapter asks the host (SPEC 9, `store.*` requests) and `memoryStore()` is
 * what the app falls back to when the host cannot, or will not, keep anything.
 *
 * Keys are `^[a-z0-9:._-]{1,128}$` and `meta` is small JSON; both are checked
 * here so the memory store refuses what the host would, and a test written
 * against one holds for the other.
 */
export interface StoreMeta {
  [key: string]: unknown;
}

export interface StoreEntry {
  bytes: Uint8Array;
  meta?: StoreMeta;
}

export interface StoreListing {
  key: string;
  size: number;
  meta?: StoreMeta;
  updatedAt: number;
}

export interface StoreUsage {
  used: number;
  cap: number;
  /** The browser promised not to evict it. Memory is never persisted. */
  persisted: boolean;
}

export type StoreErrorCode = "bad-key" | "bad-meta" | "too-large";

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export interface DeviceStore {
  /** False for the memory fallback: what is kept is gone when the session ends. */
  readonly durable: boolean;
  get(key: string): Promise<StoreEntry | null>;
  put(key: string, bytes: Uint8Array, meta?: StoreMeta): Promise<StoreUsage>;
  delete(key: string): Promise<void>;
  /** Entries whose key starts with `prefix`, at most 500, in key order. */
  list(prefix: string): Promise<StoreListing[]>;
  usage(): Promise<StoreUsage>;
}

export const KEY_PATTERN = /^[a-z0-9:._-]{1,128}$/;
export const META_MAX_BYTES = 2048;
export const LIST_MAX = 500;

export function checkKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new StoreError("bad-key", "store keys are 1 to 128 of a-z 0-9 : . _ -");
}

function checkMeta(meta: StoreMeta | undefined): void {
  if (meta !== undefined && new TextEncoder().encode(JSON.stringify(meta)).length > META_MAX_BYTES) {
    throw new StoreError("bad-meta", "meta is over 2 KB");
  }
}

/** 64 MB: a session of play without a durable store, never more than the page can hold comfortably. */
export const MEMORY_CAP_BYTES = 64 * 1024 * 1024;

export function memoryStore(capBytes: number = MEMORY_CAP_BYTES, now: () => number = Date.now): DeviceStore {
  const rows = new Map<string, { bytes: Uint8Array; meta?: StoreMeta; updatedAt: number }>();
  const used = () => {
    let total = 0;
    for (const row of rows.values()) total += row.bytes.length;
    return total;
  };
  const usage = (): StoreUsage => ({ used: used(), cap: capBytes, persisted: false });
  return {
    durable: false,
    async get(key) {
      checkKey(key);
      const row = rows.get(key);
      return row ? { bytes: row.bytes.slice(), ...(row.meta ? { meta: structuredClone(row.meta) } : {}) } : null;
    },
    async put(key, bytes, meta) {
      checkKey(key);
      checkMeta(meta);
      const replaced = rows.get(key)?.bytes.length ?? 0;
      if (used() - replaced + bytes.length > capBytes) throw new StoreError("too-large", "over the store's cap");
      rows.set(key, { bytes: bytes.slice(), ...(meta ? { meta: structuredClone(meta) } : {}), updatedAt: now() });
      return usage();
    },
    async delete(key) {
      checkKey(key);
      rows.delete(key);
    },
    async list(prefix) {
      return [...rows.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, LIST_MAX)
        .map(([key, row]) => ({
          key,
          size: row.bytes.length,
          updatedAt: row.updatedAt,
          ...(row.meta ? { meta: structuredClone(row.meta) } : {}),
        }));
    },
    async usage() {
      return usage();
    },
  };
}
