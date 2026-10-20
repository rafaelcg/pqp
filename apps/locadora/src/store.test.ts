import { describe, expect, it } from "vitest";
import { memoryStore, StoreError } from "./store";

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

describe("memoryStore", () => {
  it("keeps bytes and meta by key, and returns copies", async () => {
    const store = memoryStore();
    await store.put("sram:abc", bytes(4, 7), { at: 1 });
    const first = await store.get("sram:abc");
    expect([...first!.bytes]).toEqual([7, 7, 7, 7]);
    expect(first!.meta).toEqual({ at: 1 });
    first!.bytes[0] = 0;
    expect((await store.get("sram:abc"))!.bytes[0]).toBe(7);
    expect(await store.get("sram:nope")).toBeNull();
    expect(store.durable).toBe(false);
  });

  it("lists by prefix in key order and deletes", async () => {
    const store = memoryStore(undefined, () => 5);
    await store.put("state:a:2", bytes(2));
    await store.put("state:a:1", bytes(3));
    await store.put("meta:a", bytes(1));
    expect(await store.list("state:a:")).toEqual([
      { key: "state:a:1", size: 3, updatedAt: 5 },
      { key: "state:a:2", size: 2, updatedAt: 5 },
    ]);
    await store.delete("state:a:1");
    expect((await store.list("state:")).map((row) => row.key)).toEqual(["state:a:2"]);
  });

  it("counts usage, and a replaced key is not counted twice", async () => {
    const store = memoryStore(10);
    await store.put("a", bytes(6));
    expect((await store.put("a", bytes(8))).used).toBe(8);
    await expect(store.put("b", bytes(3))).rejects.toMatchObject({ code: "too-large" });
    expect(await store.usage()).toEqual({ used: 8, cap: 10, persisted: false });
  });

  it("refuses the keys and meta the host would", async () => {
    const store = memoryStore();
    for (const key of ["", "A", "a b", "a/b", "x".repeat(129)]) {
      await expect(store.put(key, bytes(1)), key).rejects.toBeInstanceOf(StoreError);
    }
    await expect(store.put("ok", bytes(1), { big: "x".repeat(2100) })).rejects.toMatchObject({ code: "bad-meta" });
  });
});
