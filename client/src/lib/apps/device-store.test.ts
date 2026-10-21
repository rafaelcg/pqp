import { describe, expect, it, vi } from "vitest";
import { APP_STORE_LIST_MAX, APP_STORE_VALUE_MAX_BYTES } from "@pqp/shared";
import {
  DEVICE_STORE_DB_NAME,
  DeviceStore,
  DeviceStoreError,
  openIdbBackend,
  type DeviceStoreBackend,
  type StoreListEntry,
  type StoredRecord,
} from "./device-store";
import { createFakeIdb } from "./fake-idb.fixture";

function bytesOf(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}
function sized(n: number): ArrayBuffer {
  return new Uint8Array(n).fill(7).buffer;
}
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DeviceStoreError) return error.code;
    throw error;
  }
  return "resolved";
}

function memoryBackend(): DeviceStoreBackend & { data: Map<string, StoredRecord> } {
  const data = new Map<string, StoredRecord>();
  return {
    data,
    async read(key) {
      const found = data.get(key);
      return found ? { ...found, bytes: found.bytes.slice(0) } : null;
    },
    async write(key, bytes, info) {
      data.set(key, { bytes: bytes.slice(0), ...info });
    },
    async remove(key) {
      data.delete(key);
    },
    async scan(prefix): Promise<StoreListEntry[]> {
      return [...data.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, { bytes: _bytes, ...info }]) => ({ key, ...info }));
    },
  };
}

function make(options: { cap?: number } = {}) {
  const backend = memoryBackend();
  let clock = 1000;
  const persist = vi.fn(async () => true);
  const persisted = vi.fn(async () => false);
  const store = new DeviceStore({
    backend,
    capBytes: options.cap ?? 100,
    storage: { persist, persisted },
    now: () => (clock += 1),
  });
  return { store, backend, persist, persisted };
}

describe("DeviceStore", () => {
  it("round-trips bytes and meta, and answers null for a key with nothing", async () => {
    const { store } = make();
    expect(await store.get("rom:abc")).toBeNull();
    await store.put("rom:abc", bytesOf(1, 2, 3), { name: "x", n: [1, 2] });
    const got = await store.get("rom:abc");
    expect(Array.from(new Uint8Array(got!.bytes))).toEqual([1, 2, 3]);
    expect(got!.meta).toEqual({ name: "x", n: [1, 2] });
    await store.put("prefs", bytesOf(9));
    expect((await store.get("prefs"))!.meta).toBeNull();
  });

  it("deletes a key, and deleting one that is not there is not an error", async () => {
    const { store } = make();
    await store.put("a", bytesOf(1));
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
    await expect(store.delete("a")).resolves.toBeUndefined();
  });

  it("lists by prefix in key order, with size, meta and updatedAt and no bytes", async () => {
    const { store } = make();
    await store.put("state:b:2", bytesOf(1, 2), { slot: 2 });
    await store.put("state:b:1", bytesOf(1), { slot: 1 });
    await store.put("rom:b", bytesOf(1, 2, 3));
    const entries = await store.list("state:b:");
    expect(entries.map((entry) => entry.key)).toEqual(["state:b:1", "state:b:2"]);
    expect(entries[0]).toMatchObject({ size: 1, meta: { slot: 1 } });
    expect(entries[0]!.updatedAt).toBeGreaterThan(1000);
    expect(entries[0]).not.toHaveProperty("bytes");
    expect((await store.list("")).length).toBe(3);
    expect(await store.list("none:")).toEqual([]);
  });

  it("answers at most 500 entries", async () => {
    const backend = memoryBackend();
    for (let i = 0; i < APP_STORE_LIST_MAX + 20; i += 1) {
      backend.data.set(`k:${String(i).padStart(4, "0")}`, { bytes: new ArrayBuffer(0), size: 0, meta: null, updatedAt: 1 });
    }
    const store = new DeviceStore({ backend, capBytes: 10, storage: null });
    expect((await store.list("")).length).toBe(APP_STORE_LIST_MAX);
  });

  it("counts the bytes in use, the cap from the manifest and whether the browser persisted it", async () => {
    const { store, persisted } = make({ cap: 100 });
    await store.put("a", sized(30));
    await store.put("b", sized(20));
    expect(await store.usage()).toEqual({ used: 50, cap: 100, persisted: false });
    persisted.mockResolvedValue(true);
    expect((await store.usage()).persisted).toBe(true);
  });

  it("answers too-large when the store would pass its cap, and keeps what it had", async () => {
    const { store } = make({ cap: 100 });
    await store.put("a", sized(60));
    expect(await codeOf(store.put("b", sized(41)))).toBe("too-large");
    expect(await store.get("b")).toBeNull();
    expect((await store.usage()).used).toBe(60);
    // exactly at the cap fits
    expect((await store.put("b", sized(40))).used).toBe(100);
    expect(await codeOf(store.put("c", sized(1)))).toBe("too-large");
  });

  it("does not count a replaced value twice, and a smaller replacement frees room", async () => {
    const { store } = make({ cap: 100 });
    await store.put("a", sized(90));
    expect((await store.put("a", sized(95))).used).toBe(95);
    expect((await store.put("a", sized(10))).used).toBe(10);
    expect((await store.usage()).used).toBe(10);
  });

  it("answers too-large for one value over the per-value ceiling before touching the backend", async () => {
    const backend = memoryBackend();
    const scan = vi.spyOn(backend, "scan");
    const store = new DeviceStore({ backend, capBytes: APP_STORE_VALUE_MAX_BYTES * 4, storage: null });
    const huge = { byteLength: APP_STORE_VALUE_MAX_BYTES + 1 } as ArrayBuffer;
    expect(await codeOf(store.put("rom:big", huge))).toBe("too-large");
    expect(scan).not.toHaveBeenCalled();
  });

  it("serializes writes, so two that each fit alone cannot both pass the cap", async () => {
    const { store } = make({ cap: 100 });
    const results = await Promise.allSettled([store.put("a", sized(60)), store.put("b", sized(60)), store.put("c", sized(30))]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((await store.usage()).used).toBe(90);
  });

  it("refuses keys, prefixes and meta outside the contract", async () => {
    const { store } = make();
    for (const key of ["", "A", "a b", "../x", "a".repeat(129)]) {
      expect(await codeOf(store.get(key)), key).toBe("invalid");
      expect(await codeOf(store.put(key, bytesOf(1))), key).toBe("invalid");
      expect(await codeOf(store.delete(key)), key).toBe("invalid");
    }
    expect(await codeOf(store.list("A"))).toBe("invalid");
    expect(await codeOf(store.put("a", bytesOf(1), { s: "x".repeat(2100) }))).toBe("invalid");
    expect(await codeOf(store.put("a", bytesOf(1), { n: Number.NaN } as never))).toBe("invalid");
  });

  it("asks the browser to persist once, after the first put, and never on a read", async () => {
    const { store, persist } = make();
    await store.get("a");
    await store.usage();
    expect(persist).not.toHaveBeenCalled();
    await store.put("a", bytesOf(1));
    await store.put("b", bytesOf(1));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("is not stopped by a browser with no storage manager, or one that throws", async () => {
    const backend = memoryBackend();
    const none = new DeviceStore({ backend, capBytes: 10, storage: null });
    expect((await none.put("a", bytesOf(1))).persisted).toBe(false);
    const throwing = new DeviceStore({
      backend,
      capBytes: 10,
      storage: {
        persist: () => {
          throw new Error("no");
        },
        persisted: () => Promise.reject(new Error("no")),
      },
    });
    expect((await throwing.put("b", bytesOf(1))).persisted).toBe(false);
  });

  it("maps a browser that is out of room to too-large and any other failure to unavailable", async () => {
    const backend = memoryBackend();
    const store = new DeviceStore({ backend, capBytes: 100, storage: null });
    vi.spyOn(backend, "write").mockRejectedValueOnce(Object.assign(new Error("full"), { name: "QuotaExceededError" }));
    expect(await codeOf(store.put("a", bytesOf(1)))).toBe("too-large");
    vi.spyOn(backend, "read").mockRejectedValueOnce(new Error("broken"));
    expect(await codeOf(store.get("a"))).toBe("unavailable");
    // and the queue goes on after a failure
    expect((await store.put("a", bytesOf(1))).used).toBe(1);
  });
});

describe("the IndexedDB backend", () => {
  function pair() {
    const idb = createFakeIdb();
    const open = (appId: string, cap = 1000) =>
      new DeviceStore({ backend: openIdbBackend(appId, idb.env), capBytes: cap, storage: null });
    return { idb, open };
  }

  it("keeps one object store per app id, in the one database, and creates it on first use", async () => {
    const { idb, open } = pair();
    expect(idb.stores()).toEqual([]);
    await open("app-aaa").put("a", bytesOf(1));
    await open("app-bbb").put("a", bytesOf(2));
    expect(idb.stores().sort()).toEqual(["app-aaa", "app-bbb"]);
    expect(DEVICE_STORE_DB_NAME).toBe("pqp-app-store");
  });

  it("round-trips, lists, replaces and deletes through the records it writes", async () => {
    const { idb, open } = pair();
    const store = open("app-aaa");
    await store.put("rom:abc", bytesOf(1, 2, 3), { name: "n" });
    await store.put("state:abc:1", bytesOf(4), null);
    expect(idb.entries("app-aaa").map(([key]) => key).sort()).toEqual([
      "m:rom:abc",
      "m:state:abc:1",
      "v:rom:abc",
      "v:state:abc:1",
    ]);
    const got = await store.get("rom:abc");
    expect(Array.from(new Uint8Array(got!.bytes))).toEqual([1, 2, 3]);
    expect(got!.meta).toEqual({ name: "n" });
    expect((await store.list("state:")).map((entry) => entry.key)).toEqual(["state:abc:1"]);
    expect((await store.list("")).map((entry) => entry.key)).toEqual(["rom:abc", "state:abc:1"]);
    await store.put("rom:abc", bytesOf(9), null);
    expect(Array.from(new Uint8Array((await store.get("rom:abc"))!.bytes))).toEqual([9]);
    expect((await store.usage()).used).toBe(2);
    await store.delete("rom:abc");
    expect(await store.get("rom:abc")).toBeNull();
    expect(idb.entries("app-aaa").map(([key]) => key).sort()).toEqual(["m:state:abc:1", "v:state:abc:1"]);
  });

  it("never lets one app's key reach another's store, listing or usage", async () => {
    const { open } = pair();
    const a = open("app-aaa");
    const b = open("app-bbb");
    await a.put("rom:secret", bytesOf(1, 2, 3), { who: "a" });
    expect(await b.get("rom:secret")).toBeNull();
    expect(await b.list("")).toEqual([]);
    expect((await b.usage()).used).toBe(0);
    await b.put("rom:secret", bytesOf(9), { who: "b" });
    expect((await a.get("rom:secret"))!.meta).toEqual({ who: "a" });
    await b.delete("rom:secret");
    expect(await a.get("rom:secret")).not.toBeNull();
  });

  it("enforces each app's own cap over its own store", async () => {
    const { open } = pair();
    const a = open("app-aaa", 10);
    const b = open("app-bbb", 1000);
    await a.put("a", sized(10));
    expect(await codeOf(a.put("b", sized(1)))).toBe("too-large");
    await expect(b.put("a", sized(500))).resolves.toMatchObject({ used: 500 });
  });

  it("reopens after the connection was closed for another app's store being created", async () => {
    const { idb, open } = pair();
    const a = open("app-aaa");
    await a.put("a", bytesOf(1));
    expect(idb.connections()).toBe(1);
    // creating app-bbb's store bumps the version and closes a's connection
    await open("app-bbb").put("a", bytesOf(2));
    expect(idb.connections()).toBe(1);
    expect(Array.from(new Uint8Array((await a.get("a"))!.bytes))).toEqual([1]);
    await a.put("c", bytesOf(3));
    expect((await a.list("")).map((entry) => entry.key)).toEqual(["a", "c"]);
  });

  it("answers too-large when the browser itself is out of room", async () => {
    const { idb, open } = pair();
    const store = open("app-aaa");
    await store.put("a", sized(5));
    idb.setQuota(10);
    expect(await codeOf(store.put("b", sized(20)))).toBe("too-large");
    expect(await store.get("b")).toBeNull();
    expect((await store.usage()).used).toBe(5);
  });

  it("opens two apps at once without losing either", async () => {
    const { idb, open } = pair();
    await Promise.all([open("app-aaa").put("k", bytesOf(1)), open("app-bbb").put("k", bytesOf(2))]);
    expect(idb.stores().sort()).toEqual(["app-aaa", "app-bbb"]);
    expect(Array.from(new Uint8Array((await open("app-aaa").get("k"))!.bytes))).toEqual([1]);
    expect(Array.from(new Uint8Array((await open("app-bbb").get("k"))!.bytes))).toEqual([2]);
  });
});
