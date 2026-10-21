import {
  APP_STORE_KEY_PATTERN,
  APP_STORE_LIST_MAX,
  APP_STORE_META_MAX_BYTES,
  APP_STORE_PREFIX_PATTERN,
  APP_STORE_VALUE_MAX_BYTES,
  jsonByteLength,
  jsonProblem,
  type JsonValue,
} from "@pqp/shared";

/**
 * The device store: named blobs an app keeps on the person's own device (the
 * bridge's `store.*` calls, `capabilities.deviceStore`).
 *
 * - IndexedDB database `pqp-app-store`, ONE OBJECT STORE PER APP ID. The id is
 *   the host's (the manifest's), never a field of a message, so app A cannot
 *   name app B's store, and there is no key syntax that reaches across.
 * - Inside a store each app key `k` is two records, `v:k` (the bytes) and `m:k`
 *   (size, meta, updatedAt). A listing or a quota sum reads only the `m:` range,
 *   so it never loads a 30 MB value to count it.
 * - Nothing in here is read by pqp's own code and nothing is sent anywhere.
 * - The quota is the manifest's `deviceStore.maxBytes`, summed over the store.
 *   Operations of one store run one at a time (a promise chain), so two puts
 *   cannot both fit under the cap by each looking before the other wrote. Two
 *   TABS can still race; the overshoot is at most one value, the browser's own
 *   quota still applies, and nothing here is a security boundary.
 * - `navigator.storage.persist()` is asked once, after the first put (a person
 *   did something that made data worth keeping), and its answer only ever
 *   shows up as `persisted` in the usage.
 */

export const DEVICE_STORE_DB_NAME = "pqp-app-store";

export type DeviceStoreErrorCode = "too-large" | "unavailable" | "invalid";

export class DeviceStoreError extends Error {
  readonly code: DeviceStoreErrorCode;
  constructor(code: DeviceStoreErrorCode, message?: string) {
    super(message ?? `device store call failed: ${code}`);
    this.name = "DeviceStoreError";
    this.code = code;
  }
}

/** What is kept about one value besides its bytes. */
export interface StoreRecordInfo {
  size: number;
  /** JSON, `null` when none was given. */
  meta: JsonValue;
  /** Epoch milliseconds of the last write. */
  updatedAt: number;
}

export interface StoredRecord extends StoreRecordInfo {
  bytes: ArrayBuffer;
}

export interface StoreListEntry extends StoreRecordInfo {
  key: string;
}

export interface StoreUsageInfo {
  used: number;
  cap: number;
  persisted: boolean;
}

/** The storage under one app's store. The IndexedDB one is `openIdbBackend`; tests stand in with memory. */
export interface DeviceStoreBackend {
  read(key: string): Promise<StoredRecord | null>;
  /** Writes the value and its info together, or neither. */
  write(key: string, bytes: ArrayBuffer, info: StoreRecordInfo): Promise<void>;
  remove(key: string): Promise<void>;
  /** Info of every entry whose key starts with `prefix`, sorted by key, without the bytes. */
  scan(prefix: string): Promise<StoreListEntry[]>;
}

/** The slice of `navigator.storage` the store uses. */
export interface PersistApi {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
}

export interface DeviceStoreOptions {
  backend: DeviceStoreBackend;
  /** The manifest's `deviceStore.maxBytes`. */
  capBytes: number;
  storage?: PersistApi | null;
  now?: () => number;
}

function validMeta(meta: JsonValue): boolean {
  return jsonProblem(meta) === null && jsonByteLength(meta) <= APP_STORE_META_MAX_BYTES;
}

function checkKey(key: string): void {
  if (!APP_STORE_KEY_PATTERN.test(key)) throw new DeviceStoreError("invalid", "bad key");
}

export class DeviceStore {
  private readonly backend: DeviceStoreBackend;
  private readonly capBytes: number;
  private readonly storage: PersistApi | null;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private persistAsked = false;

  constructor(options: DeviceStoreOptions) {
    this.backend = options.backend;
    this.capBytes = options.capBytes;
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.now = options.now ?? (() => Date.now());
  }

  /** Runs `job` after everything queued before it, whether that succeeded or not. */
  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async get(key: string): Promise<{ bytes: ArrayBuffer; meta: JsonValue } | null> {
    checkKey(key);
    return this.run(async () => {
      const record = await this.guard(() => this.backend.read(key));
      return record ? { bytes: record.bytes, meta: record.meta } : null;
    });
  }

  /**
   * Writes a value. `too-large` when the value passes the per-value ceiling or
   * the store would pass the manifest's cap (a replaced value's old size is not
   * counted twice) or the browser refuses for lack of room.
   */
  async put(key: string, bytes: ArrayBuffer, meta: JsonValue = null): Promise<StoreUsageInfo> {
    checkKey(key);
    if (!validMeta(meta)) throw new DeviceStoreError("invalid", "bad meta");
    const size = bytes.byteLength;
    if (size > APP_STORE_VALUE_MAX_BYTES) throw new DeviceStoreError("too-large", "value over the ceiling");
    return this.run(async () => {
      const entries = await this.guard(() => this.backend.scan(""));
      const others = entries.reduce((sum, entry) => (entry.key === key ? sum : sum + entry.size), 0);
      if (others + size > this.capBytes) throw new DeviceStoreError("too-large", "store would pass its cap");
      await this.guard(() => this.backend.write(key, bytes, { size, meta, updatedAt: this.now() }));
      this.askPersistOnce();
      return { used: others + size, cap: this.capBytes, persisted: await this.persisted() };
    });
  }

  async delete(key: string): Promise<void> {
    checkKey(key);
    return this.run(() => this.guard(() => this.backend.remove(key)));
  }

  /** At most 500 entries, by key, without bytes. */
  async list(prefix: string): Promise<StoreListEntry[]> {
    if (!APP_STORE_PREFIX_PATTERN.test(prefix)) throw new DeviceStoreError("invalid", "bad prefix");
    return this.run(async () => (await this.guard(() => this.backend.scan(prefix))).slice(0, APP_STORE_LIST_MAX));
  }

  async usage(): Promise<StoreUsageInfo> {
    return this.run(async () => {
      const entries = await this.guard(() => this.backend.scan(""));
      return {
        used: entries.reduce((sum, entry) => sum + entry.size, 0),
        cap: this.capBytes,
        persisted: await this.persisted(),
      };
    });
  }

  /** A browser that refuses for room is `too-large`; any other failure is `unavailable`. */
  private async guard<T>(job: () => Promise<T>): Promise<T> {
    try {
      return await job();
    } catch (error) {
      if (error instanceof DeviceStoreError) throw error;
      const name = (error as { name?: unknown } | null)?.name;
      throw new DeviceStoreError(name === "QuotaExceededError" ? "too-large" : "unavailable");
    }
  }

  private askPersistOnce(): void {
    if (this.persistAsked) return;
    this.persistAsked = true;
    try {
      // not awaited: a browser may hold the answer behind a prompt
      void this.storage?.persist?.()?.catch(() => undefined);
    } catch {
      // a store that cannot ask is still a store
    }
  }

  private async persisted(): Promise<boolean> {
    try {
      return (await this.storage?.persisted?.()) === true;
    } catch {
      return false;
    }
  }
}

function browserStorage(): PersistApi | null {
  return typeof navigator !== "undefined" && navigator.storage ? navigator.storage : null;
}

// ---------------------------------------------------------------------------
// IndexedDB

/** The IndexedDB pieces the backend needs, injectable so a test can stand in. */
export interface IdbEnvironment {
  factory: IDBFactory;
  /** `IDBKeyRange.bound`. */
  bound(lower: string, upper: string): IDBKeyRange;
}

export function browserIdb(): IdbEnvironment | null {
  if (typeof indexedDB === "undefined" || typeof IDBKeyRange === "undefined") return null;
  return { factory: indexedDB, bound: (lower, upper) => IDBKeyRange.bound(lower, upper) };
}

interface InfoRecord extends StoreRecordInfo {
  key: string;
}

const VALUE_PREFIX = "v:";
const INFO_PREFIX = "m:";
/** Above every character an app key can hold. */
const RANGE_END = "￿";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexeddb transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb transaction aborted"));
  });
}

/**
 * Opens the database, creating the object store for `appId` when it is not
 * there yet. An object store can only be created in a version change, so a
 * missing one means closing and reopening one version up.
 */
async function openDatabase(env: IdbEnvironment, appId: string): Promise<IDBDatabase> {
  const openAt = (version: number | undefined, create: boolean) =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = version === undefined ? env.factory.open(DEVICE_STORE_DB_NAME) : env.factory.open(DEVICE_STORE_DB_NAME, version);
      request.onupgradeneeded = () => {
        if (create && !request.result.objectStoreNames.contains(appId)) request.result.createObjectStore(appId);
      };
      request.onerror = () => reject(request.error ?? new Error("indexeddb open failed"));
      request.onsuccess = () => resolve(request.result);
      // `onblocked` is not an error: another connection closes on its `versionchange`
    });

  // Another tab (or another app's first call) may create its store at the same
  // version number at the same moment, and then this open finds a database that
  // is already at the version it asked for and has no upgrade to run. So look
  // again after each upgrade rather than trusting it.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const db = await openAt(undefined, false);
    if (db.objectStoreNames.contains(appId)) return db;
    const version = db.version;
    db.close();
    const upgraded = await openAt(version + 1, true);
    if (upgraded.objectStoreNames.contains(appId)) return upgraded;
    upgraded.close();
  }
  throw new Error("indexeddb: could not create the object store");
}

/**
 * The backend over one app's object store. A connection is opened on first use
 * and dropped when the browser asks (another app's store being created closes
 * every open connection, and the next call reopens).
 */
export function openIdbBackend(appId: string, env: IdbEnvironment): DeviceStoreBackend {
  let opened: Promise<IDBDatabase> | null = null;

  const database = (): Promise<IDBDatabase> => {
    if (!opened) {
      opened = openDatabase(env, appId).then(
        (db) => {
          db.onversionchange = () => {
            db.close();
            opened = null;
          };
          db.onclose = () => {
            opened = null;
          };
          return db;
        },
        (error: unknown) => {
          opened = null;
          throw error;
        },
      );
    }
    return opened;
  };

  /** One transaction on the app's store; a connection closed under us is reopened once. */
  const transact = async <T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      const db = await database();
      let tx: IDBTransaction;
      try {
        tx = db.transaction(appId, mode);
      } catch (error) {
        if (attempt === 0 && (error as { name?: unknown } | null)?.name === "InvalidStateError") {
          opened = null;
          continue;
        }
        throw error;
      }
      const done = transactionDone(tx);
      // awaited after the body: a rejection before that must not count as unhandled
      done.catch(() => undefined);
      try {
        const result = await body(tx.objectStore(appId));
        await done;
        return result;
      } catch (error) {
        // a failed request already aborts; this stops a body that threw by itself
        try {
          tx.abort();
        } catch {
          // already finished
        }
        done.catch(() => undefined);
        throw error;
      }
    }
  };

  return {
    read(key) {
      return transact("readonly", async (store) => {
        const [info, bytes] = await Promise.all([
          requestResult(store.get(INFO_PREFIX + key) as IDBRequest<InfoRecord | undefined>),
          requestResult(store.get(VALUE_PREFIX + key) as IDBRequest<ArrayBuffer | undefined>),
        ]);
        if (!info || !bytes) return null;
        return { bytes, size: info.size, meta: info.meta, updatedAt: info.updatedAt };
      });
    },
    async write(key, bytes, info) {
      await transact("readwrite", (store) => {
        const record: InfoRecord = { key, size: info.size, meta: info.meta, updatedAt: info.updatedAt };
        store.put(bytes, VALUE_PREFIX + key);
        store.put(record, INFO_PREFIX + key);
      });
    },
    async remove(key) {
      await transact("readwrite", (store) => {
        store.delete(VALUE_PREFIX + key);
        store.delete(INFO_PREFIX + key);
      });
    },
    scan(prefix) {
      return transact("readonly", async (store) => {
        const range = env.bound(INFO_PREFIX + prefix, INFO_PREFIX + prefix + RANGE_END);
        const records = await requestResult(store.getAll(range) as IDBRequest<InfoRecord[]>);
        return records
          .filter((record) => record.key.startsWith(prefix))
          .map((record) => ({ key: record.key, size: record.size, meta: record.meta, updatedAt: record.updatedAt }));
      });
    },
  };
}

/** A store for `appId` on this browser's IndexedDB, or null when there is none (a private window that refuses, a test). */
export function openBrowserDeviceStore(appId: string, capBytes: number): DeviceStore | null {
  const env = browserIdb();
  return env ? new DeviceStore({ backend: openIdbBackend(appId, env), capBytes }) : null;
}
