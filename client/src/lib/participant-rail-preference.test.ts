import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadParticipantRailOpen,
  saveParticipantRailOpen,
} from "./participant-rail-preference";

describe("participant rail preference", () => {
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

  it("is open until somebody closes it", () => {
    expect(loadParticipantRailOpen()).toBe(true);
  });

  it("round-trips both answers", () => {
    saveParticipantRailOpen(false);
    expect(loadParticipantRailOpen()).toBe(false);
    saveParticipantRailOpen(true);
    expect(loadParticipantRailOpen()).toBe(true);
  });

  it("reads junk as open rather than as hidden", () => {
    store.set("pqp:participant-rail", "{}");
    expect(loadParticipantRailOpen()).toBe(true);
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(loadParticipantRailOpen()).toBe(true);
    expect(() => saveParticipantRailOpen(false)).not.toThrow();
  });
});
