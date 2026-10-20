import { PqpAppError, type PqpApp } from "@pqp/app-sdk";
import {
  checkKey,
  META_MAX_BYTES,
  memoryStore,
  StoreError,
  type DeviceStore,
  type StoreEntry,
  type StoreListing,
  type StoreMeta,
  type StoreUsage,
} from "./store";

/**
 * The real `DeviceStore`: an adapter over the host's `store.*` bridge calls
 * (SPEC 9, `app.store` in `@pqp/app-sdk`). The frame has no storage of its own,
 * so the host keeps the bytes in its own IndexedDB and never reads them.
 *
 * The host can say no in two ways, and both end the same way: an old host does
 * not know the request and answers `invalid`, a new host answers `not-allowed`
 * to an app that did not declare the capability. Either way the app keeps
 * playing and keeps what it has in memory (`memoryStore()`), exactly as it did
 * before the shelf existed. The switch happens once, on the first such answer,
 * and `durable` turns false from then on, so the shelf can say so.
 *
 * Keys and meta are checked here first with the same rules as the memory store
 * (and the host), so a bug in a caller fails the same way on both.
 */

/** The slice of the SDK's `app.store` this adapter uses, so a test can stand in for the host. */
export interface StoreHost {
  get(key: string): Promise<{ bytes: ArrayBuffer; meta: unknown } | null>;
  put(key: string, bytes: ArrayBuffer | ArrayBufferView, meta?: StoreMeta): Promise<StoreUsage>;
  delete(key: string): Promise<null>;
  list(prefix?: string): Promise<Array<{ key: string; size: number; meta: unknown; updatedAt: number }>>;
  usage(): Promise<StoreUsage>;
}

/** The SDK's `app.store` as a `StoreHost`: the same calls, with `meta` (small JSON the SDK types as `JsonValue`) passed as it is. */
export function hostFromApp(store: PqpApp["store"]): StoreHost {
  return {
    get: (key) => store.get(key),
    put: (key, bytes, meta) => store.put(key, bytes, meta as Parameters<PqpApp["store"]["put"]>[2]),
    delete: (key) => store.delete(key),
    list: (prefix) => store.list(prefix),
    usage: () => store.usage(),
  };
}

/** The host answered that it will not keep anything for this app. */
export function isStoreRefusal(error: unknown): boolean {
  return error instanceof PqpAppError && (error.code === "invalid" || error.code === "not-allowed");
}

/** A meta object back from the host: JSON `null` means "none was stored". */
function metaOf(raw: unknown): StoreMeta | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as StoreMeta) : undefined;
}

export interface BridgeStoreOptions {
  /** What stands in once the host refuses. Defaults to a fresh `memoryStore()`. */
  fallback?: DeviceStore;
  /** Called once, the first time the host refuses and the fallback takes over. */
  onFallback?: () => void;
}

export interface BridgeStore extends DeviceStore {
  /** True once the host refused and the memory fallback is in use. */
  readonly fellBack: boolean;
  /** Switches to memory by hand (the probe could not get an answer at all). */
  useMemory(): void;
}

export function createBridgeStore(host: StoreHost, options: BridgeStoreOptions = {}): BridgeStore {
  const fallback = options.fallback ?? memoryStore();
  let fellBack = false;

  function fall(): void {
    if (fellBack) return;
    fellBack = true;
    options.onFallback?.();
  }

  /** Runs a host call; the host's refusal switches to memory and repeats the call there. */
  async function run<T>(real: () => Promise<T>, local: () => Promise<T>): Promise<T> {
    if (fellBack) return local();
    try {
      return await real();
    } catch (error) {
      if (isStoreRefusal(error)) {
        fall();
        return local();
      }
      if (error instanceof PqpAppError && error.code === "too-large") throw new StoreError("too-large", "over the store's cap");
      throw error;
    }
  }

  return {
    get durable() {
      return !fellBack;
    },
    get fellBack() {
      return fellBack;
    },
    useMemory: fall,
    async get(key) {
      checkKey(key);
      return run<StoreEntry | null>(
        async () => {
          const found = await host.get(key);
          if (!found) return null;
          const meta = metaOf(found.meta);
          return { bytes: new Uint8Array(found.bytes), ...(meta ? { meta } : {}) };
        },
        () => fallback.get(key),
      );
    },
    async put(key, bytes, meta) {
      checkKey(key);
      if (meta !== undefined && new TextEncoder().encode(JSON.stringify(meta)).length > META_MAX_BYTES) {
        throw new StoreError("bad-meta", "meta is over 2 KB");
      }
      return run(
        () => host.put(key, bytes, meta),
        () => fallback.put(key, bytes, meta),
      );
    },
    async delete(key) {
      checkKey(key);
      await run(
        async () => {
          await host.delete(key);
        },
        () => fallback.delete(key),
      );
    },
    async list(prefix) {
      return run<StoreListing[]>(
        async () => {
          const rows = await host.list(prefix);
          return rows.map((row) => {
            const meta = metaOf(row.meta);
            return { key: row.key, size: row.size, updatedAt: row.updatedAt, ...(meta ? { meta } : {}) };
          });
        },
        () => fallback.list(prefix),
      );
    },
    async usage() {
      return run(
        () => host.usage(),
        () => fallback.usage(),
      );
    },
  };
}

export interface OpenedStore {
  store: BridgeStore;
  /** False when the host would not keep anything: the shelf is then session-only and says so. */
  durable: boolean;
}

/**
 * Opens the device store: one `usage` call is the probe. A refusal means memory
 * for the whole session (`run` already switched); so does any other failure to
 * answer (a timeout, a closed session), because nothing durable can be counted on.
 */
export async function openDeviceStore(host: StoreHost, options: BridgeStoreOptions = {}): Promise<OpenedStore> {
  const store = createBridgeStore(host, options);
  try {
    await store.usage();
  } catch {
    store.useMemory();
  }
  return { store, durable: store.durable };
}
