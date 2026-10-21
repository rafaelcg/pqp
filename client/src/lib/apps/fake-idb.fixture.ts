import type { IdbEnvironment } from "./device-store";

/**
 * A small stand-in for IndexedDB, only as much as `openIdbBackend` uses: a
 * database with versions, object stores created in an upgrade, transactions
 * that commit when idle, `put` / `get` / `delete` / `getAll(range)`, values
 * copied with structured clone, `versionchange` closing other connections.
 * Tests run in a node environment, which has no IndexedDB.
 */

type Callback = (() => void) | null;

interface FakeDbState {
  version: number;
  stores: Map<string, Map<string, unknown>>;
  open: Set<FakeConnection>;
}

class FakeRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: Callback = null;
  onerror: Callback = null;
  onupgradeneeded: Callback = null;
  onblocked: Callback = null;
}

function domError(name: string): DOMException {
  return new DOMException(name, name);
}

class FakeTransaction {
  oncomplete: Callback = null;
  onerror: Callback = null;
  onabort: Callback = null;
  error: DOMException | null = null;
  private pending = 0;
  private finished = false;

  constructor(
    private readonly data: Map<string, unknown>,
    private readonly mode: IDBTransactionMode,
    private readonly name: string,
    private readonly hooks: { quotaLeft: () => number },
  ) {
    this.settleLater();
  }

  private settleLater(): void {
    setTimeout(() => {
      if (this.finished || this.pending > 0) return;
      this.finished = true;
      this.oncomplete?.();
    }, 0);
  }

  abort(): void {
    if (this.finished) throw domError("InvalidStateError");
    this.finished = true;
    this.onabort?.();
  }

  objectStore(name: string): FakeObjectStore {
    if (name !== this.name) throw domError("NotFoundError");
    return new FakeObjectStore(this, this.data);
  }

  /** Runs one request: the body at once (so a thrown error is the caller's), the callbacks later. */
  request<T>(work: () => T, write: boolean): FakeRequest<T> {
    if (this.finished) throw domError("TransactionInactiveError");
    if (write && this.mode === "readonly") throw domError("ReadOnlyError");
    const request = new FakeRequest<T>();
    this.pending += 1;
    setTimeout(() => {
      if (this.finished) return;
      try {
        request.result = work();
      } catch (error) {
        this.pending -= 1;
        this.error = error as DOMException;
        request.error = this.error;
        request.onerror?.();
        this.finished = true;
        this.onabort?.();
        return;
      }
      this.pending -= 1;
      request.onsuccess?.();
      this.settleLater();
    }, 0);
    return request;
  }

  get quotaLeft(): number {
    return this.hooks.quotaLeft();
  }
}

function sizeOf(value: unknown): number {
  if (value instanceof ArrayBuffer) return value.byteLength;
  return 0;
}

class FakeObjectStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly data: Map<string, unknown>,
  ) {}

  put(value: unknown, key: string): FakeRequest<string> {
    const copy = structuredClone(value);
    return this.tx.request(() => {
      if (sizeOf(copy) > this.tx.quotaLeft) throw domError("QuotaExceededError");
      this.data.set(key, copy);
      return key;
    }, true);
  }

  get(key: string): FakeRequest<unknown> {
    return this.tx.request(() => {
      const found = this.data.get(key);
      return found === undefined ? undefined : structuredClone(found);
    }, false);
  }

  delete(key: string): FakeRequest<undefined> {
    return this.tx.request(() => {
      this.data.delete(key);
      return undefined;
    }, true);
  }

  getAll(range: { lower: string; upper: string }): FakeRequest<unknown[]> {
    return this.tx.request(() => {
      return [...this.data.keys()]
        .filter((key) => key >= range.lower && key <= range.upper)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((key) => structuredClone(this.data.get(key)));
    }, false);
  }
}

class FakeConnection {
  onversionchange: Callback = null;
  onclose: Callback = null;
  closed = false;

  constructor(
    private readonly state: FakeDbState,
    readonly version: number,
    private readonly hooks: { quotaLeft: () => number },
  ) {
    state.open.add(this);
  }

  get objectStoreNames() {
    return { contains: (name: string) => this.state.stores.has(name) };
  }

  createObjectStore(name: string): void {
    this.state.stores.set(name, new Map());
  }

  transaction(name: string, mode: IDBTransactionMode): FakeTransaction {
    const store = this.state.stores.get(name);
    if (this.closed) throw domError("InvalidStateError");
    if (!store) throw domError("NotFoundError");
    return new FakeTransaction(store, mode, name, this.hooks);
  }

  close(): void {
    this.closed = true;
    this.state.open.delete(this);
  }
}

export interface FakeIdb {
  env: IdbEnvironment;
  /** Every `(database, object store)` pair that exists, to look at what a store holds. */
  stores(): string[];
  /** The raw key/value pairs of one object store. */
  entries(storeName: string): Array<[string, unknown]>;
  /** How many connections are open now. */
  connections(): number;
  /** Bytes the browser will still accept; a larger `put` fails with `QuotaExceededError`. */
  setQuota(bytes: number): void;
}

export function createFakeIdb(): FakeIdb {
  const databases = new Map<string, FakeDbState>();
  let quota = Number.POSITIVE_INFINITY;
  const hooks = { quotaLeft: () => quota };

  const factory = {
    open(name: string, version?: number) {
      const request = new FakeRequest<FakeConnection>();
      setTimeout(() => {
        let state = databases.get(name);
        const created = !state;
        if (!state) {
          state = { version: 0, stores: new Map(), open: new Set() };
          databases.set(name, state);
        }
        const wanted = version ?? (state.version === 0 ? 1 : state.version);
        if (wanted < state.version) {
          request.error = domError("VersionError");
          request.onerror?.();
          return;
        }
        const upgrading = wanted > state.version;
        if (upgrading) {
          for (const other of [...state.open]) other.onversionchange?.();
          if (state.open.size > 0) request.onblocked?.();
        }
        state.version = wanted;
        const connection = new FakeConnection(state, wanted, hooks);
        request.result = connection;
        if (upgrading || created) request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };

  return {
    env: {
      factory: factory as unknown as IDBFactory,
      bound: (lower, upper) => ({ lower, upper }) as unknown as IDBKeyRange,
    },
    stores: () => [...databases.values()].flatMap((db) => [...db.stores.keys()]),
    entries: (storeName) =>
      [...databases.values()].flatMap((db) => [...(db.stores.get(storeName)?.entries() ?? [])]),
    connections: () => [...databases.values()].reduce((sum, db) => sum + db.open.size, 0),
    setQuota: (bytes) => {
      quota = bytes;
    },
  };
}
