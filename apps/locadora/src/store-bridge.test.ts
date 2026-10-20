import { PqpAppError } from "@pqp/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { createBridgeStore, openDeviceStore, type StoreHost } from "./store-bridge";
import { StoreError } from "./store";

const usage = { used: 3, cap: 100, persisted: true };

/** A host that keeps rows the way the real one does: bytes as an ArrayBuffer, meta `null` when none. */
function fakeHost(overrides: Partial<StoreHost> = {}): StoreHost & { rows: Map<string, { bytes: ArrayBuffer; meta: unknown }> } {
  const rows = new Map<string, { bytes: ArrayBuffer; meta: unknown }>();
  return {
    rows,
    async get(key) {
      return rows.get(key) ?? null;
    },
    async put(key, bytes, meta) {
      const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      rows.set(key, { bytes: view.slice().buffer, meta: meta ?? null });
      return usage;
    },
    async delete(key) {
      rows.delete(key);
      return null;
    },
    async list(prefix = "") {
      return [...rows.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, row]) => ({ key, size: row.bytes.byteLength, meta: row.meta, updatedAt: 7 }));
    },
    async usage() {
      return usage;
    },
    ...overrides,
  };
}

describe("createBridgeStore", () => {
  it("passes bytes and meta through the host and gives the rows back as the store's types", async () => {
    const host = fakeHost();
    const store = createBridgeStore(host);
    await store.put("rom:aa", new Uint8Array([1, 2, 3]), { n: 1 });
    await store.put("meta:aa", new Uint8Array([1]));
    const got = await store.get("rom:aa");
    expect(got!.bytes).toBeInstanceOf(Uint8Array);
    expect([...got!.bytes]).toEqual([1, 2, 3]);
    expect(got!.meta).toEqual({ n: 1 });
    expect((await store.get("meta:aa"))!.meta).toBeUndefined();
    expect(await store.get("rom:none")).toBeNull();
    expect(await store.list("rom:")).toEqual([{ key: "rom:aa", size: 3, updatedAt: 7, meta: { n: 1 } }]);
    await store.delete("rom:aa");
    expect(await store.get("rom:aa")).toBeNull();
    expect(await store.usage()).toEqual(usage);
    expect(store.durable).toBe(true);
  });

  it("checks the key and the meta the way the host would, before asking it", async () => {
    const host = fakeHost({ put: vi.fn() });
    const store = createBridgeStore(host);
    await expect(store.put("Bad Key", new Uint8Array(1))).rejects.toMatchObject({ code: "bad-key" });
    await expect(store.put("ok", new Uint8Array(1), { text: "x".repeat(3000) })).rejects.toMatchObject({ code: "bad-meta" });
    expect(host.put).not.toHaveBeenCalled();
  });

  it("turns the host's too-large into the store's StoreError, which the saves know as a full disk", async () => {
    const store = createBridgeStore(
      fakeHost({
        async put() {
          throw new PqpAppError("too-large");
        },
      }),
    );
    await expect(store.put("rom:aa", new Uint8Array(1))).rejects.toBeInstanceOf(StoreError);
    await expect(store.put("rom:aa", new Uint8Array(1))).rejects.toMatchObject({ code: "too-large" });
    expect(store.durable).toBe(true);
  });

  it.each(["invalid", "not-allowed"] as const)("falls back to memory once when the host answers %s, and says so", async (code) => {
    const onFallback = vi.fn();
    const store = createBridgeStore(
      fakeHost({
        async put() {
          throw new PqpAppError(code);
        },
        async get() {
          throw new PqpAppError(code);
        },
      }),
      { onFallback },
    );
    expect(store.durable).toBe(true);
    // the failed put is repeated against memory, so the caller never sees the refusal
    await store.put("sram:aa", new Uint8Array([9]), { at: 1 });
    expect(store.durable).toBe(false);
    expect(store.fellBack).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect([...(await store.get("sram:aa"))!.bytes]).toEqual([9]);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("does not fall back for an ordinary failure: that one is the caller's to handle", async () => {
    const store = createBridgeStore(
      fakeHost({
        async get() {
          throw new PqpAppError("unavailable");
        },
      }),
    );
    await expect(store.get("rom:aa")).rejects.toMatchObject({ code: "unavailable" });
    expect(store.durable).toBe(true);
  });
});

describe("openDeviceStore", () => {
  it("is durable when the host answers the probe", async () => {
    const opened = await openDeviceStore(fakeHost());
    expect(opened.durable).toBe(true);
  });

  it.each(["invalid", "not-allowed"] as const)("is memory when the probe is answered %s", async (code) => {
    const opened = await openDeviceStore(
      fakeHost({
        async usage() {
          throw new PqpAppError(code);
        },
      }),
    );
    expect(opened.durable).toBe(false);
    // and it works: the app plays on, the shelf just does not outlive the session
    await opened.store.put("meta:aa", new Uint8Array([1]), { a: 1 });
    expect((await opened.store.list("meta:")).length).toBe(1);
    expect((await opened.store.usage()).persisted).toBe(false);
  });

  it("is memory when the probe gets no answer at all", async () => {
    const opened = await openDeviceStore(
      fakeHost({
        async usage() {
          throw new PqpAppError("unavailable");
        },
      }),
    );
    expect(opened.durable).toBe(false);
  });
});
