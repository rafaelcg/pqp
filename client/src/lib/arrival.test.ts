import { describe, expect, it } from "vitest";
import { hasArrived, readArrivals, rememberArrival } from "./arrival";

/** A localStorage stand-in. The real one is not available under vitest. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    read: () => map.get("pqp:arrived-servers") ?? null,
  };
}

/** One that refuses every write, the way a full or locked-down store does. */
function hostileStorage() {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
}

describe("readArrivals", () => {
  it("is empty with nothing stored", () => {
    expect(readArrivals(fakeStorage())).toEqual([]);
  });

  it("is empty with no storage at all", () => {
    expect(readArrivals(null)).toEqual([]);
  });

  it("reads back what was written", () => {
    const storage = fakeStorage({ "pqp:arrived-servers": '["s1","s2"]' });
    expect(readArrivals(storage)).toEqual(["s1", "s2"]);
  });

  it("treats invalid JSON as no record rather than throwing", () => {
    const storage = fakeStorage({ "pqp:arrived-servers": "{not json" });
    expect(readArrivals(storage)).toEqual([]);
  });

  it("treats a non-array as no record", () => {
    const storage = fakeStorage({ "pqp:arrived-servers": '{"s1":true}' });
    expect(readArrivals(storage)).toEqual([]);
  });

  it("drops non-string entries rather than trusting the shape", () => {
    const storage = fakeStorage({ "pqp:arrived-servers": '["s1",7,null,"s2"]' });
    expect(readArrivals(storage)).toEqual(["s1", "s2"]);
  });
});

describe("hasArrived", () => {
  it("is false for a server this device has not seen", () => {
    expect(hasArrived(fakeStorage(), "s1")).toBe(false);
  });

  it("is true once the arrival is recorded", () => {
    const storage = fakeStorage({ "pqp:arrived-servers": '["s1"]' });
    expect(hasArrived(storage, "s1")).toBe(true);
    expect(hasArrived(storage, "s2")).toBe(false);
  });

  it("answers true for no server, so callers need not null-check first", () => {
    expect(hasArrived(fakeStorage(), null)).toBe(true);
  });

  it("shows nothing when storage is denied", () => {
    // Failing closed: a missing hint costs less than one that cannot be
    // dismissed.
    expect(hasArrived(null, "s1")).toBe(false);
    expect(readArrivals(null)).toEqual([]);
  });
});

describe("rememberArrival", () => {
  it("records the server and reads back as arrived", () => {
    const storage = fakeStorage();
    rememberArrival(storage, "s1");
    expect(hasArrived(storage, "s1")).toBe(true);
    expect(storage.read()).toBe('["s1"]');
  });

  it("puts the newest first and never duplicates", () => {
    const storage = fakeStorage();
    rememberArrival(storage, "s1");
    rememberArrival(storage, "s2");
    rememberArrival(storage, "s1");
    expect(readArrivals(storage)).toEqual(["s1", "s2"]);
  });

  it("caps the list so a grow-only key cannot live forever", () => {
    const storage = fakeStorage();
    for (let i = 0; i < 8; i += 1) {
      rememberArrival(storage, `s${i}`, 5);
    }
    const stored = readArrivals(storage);
    expect(stored).toHaveLength(5);
    // The ids that fall off are the oldest joins.
    expect(stored).toEqual(["s7", "s6", "s5", "s4", "s3"]);
  });

  it("returns the new list even when the write is refused", () => {
    expect(rememberArrival(hostileStorage(), "s1")).toEqual(["s1"]);
  });

  it("survives having no storage at all", () => {
    expect(rememberArrival(null, "s1")).toEqual(["s1"]);
  });
});
