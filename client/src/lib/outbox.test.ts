import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSendNonce, loadOutbox, saveOutbox, type OutboxEntry } from "./outbox";

function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    nonce: "n1",
    channelId: "c1",
    body: "hello",
    replyToId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("outbox", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips entries per account", () => {
    const one = entry();
    saveOutbox("u1", [one], new Set(["n1"]));
    expect(loadOutbox("u1")).toEqual([one]);
    expect(loadOutbox("u2")).toEqual([]);
  });

  it("removes the key when the outbox empties", () => {
    saveOutbox("u1", [entry()], new Set(["n1"]));
    saveOutbox("u1", [], new Set(["n1"]));
    expect(store.size).toBe(0);
  });

  it("drops rows that are malformed or a day old", () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    store.set(
      "pqp:outbox:u1",
      JSON.stringify([entry(), entry({ nonce: "n2", createdAt: old }), { nonce: 3 }]),
    );
    expect(loadOutbox("u1").map((item) => item.nonce)).toEqual(["n1"]);
  });

  it("survives unreadable storage", () => {
    store.set("pqp:outbox:u1", "{not json");
    expect(loadOutbox("u1")).toEqual([]);
  });

  it("caps the store at 200 newest rows", () => {
    const many = Array.from({ length: 250 }, (_, i) => entry({ nonce: `n${i}` }));
    saveOutbox("u1", many, new Set(many.map((item) => item.nonce)));
    const kept = loadOutbox("u1");
    expect(kept).toHaveLength(200);
    expect(kept[0]!.nonce).toBe("n50");
  });

  it("keeps another tab's rows and only replaces its own", () => {
    const a = entry({ nonce: "a", createdAt: new Date(Date.now() - 2000).toISOString() });
    const b = entry({ nonce: "b", createdAt: new Date(Date.now() - 1000).toISOString() });
    // Tab A writes its row, tab B (which never saw "a") writes its row.
    saveOutbox("u1", [a], new Set(["a"]));
    saveOutbox("u1", [b], new Set(["b"]));
    expect(loadOutbox("u1").map((item) => item.nonce)).toEqual(["a", "b"]);
    // Tab A's send is answered: it removes "a" and leaves "b" alone.
    saveOutbox("u1", [], new Set(["a"]));
    expect(loadOutbox("u1").map((item) => item.nonce)).toEqual(["b"]);
  });

  it("makes a nonce that does not repeat", () => {
    const seen = new Set(Array.from({ length: 100 }, () => createSendNonce()));
    expect(seen.size).toBe(100);
    for (const nonce of seen) {
      expect(nonce.length).toBeLessThanOrEqual(64);
    }
  });
});
