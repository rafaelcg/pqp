import { beforeEach, describe, expect, it } from "vitest";
import {
  JAM_HANDOVER_TTL_MS,
  handoverFromIntent,
  leavesToJamSite,
  readJamHandover,
  removeJamHandover,
  writeJamHandover,
} from "./jam-handover";
import type { JamIntent } from "./jam-intent";

const SONG = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

function memory(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

const record: JamIntent = { kind: "song", songId: SONG, record: true, instrument: "bass" };

describe("the jam handover record", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = memory();
  });

  it("is made from an intent: the song, what they came to do, and no title yet", () => {
    expect(handoverFromIntent(record, 1000)).toEqual({
      target: SONG,
      record: true,
      instrument: "bass",
      title: null,
      at: 1000,
    });
    expect(handoverFromIntent({ kind: "new" }, 1000)).toEqual({
      target: "new",
      record: false,
      instrument: null,
      title: null,
      at: 1000,
    });
    expect(
      handoverFromIntent({ kind: "song", songId: SONG, record: false, instrument: null, act: "like" }, 5, "Café").title,
    ).toBe("Café");
  });

  it("round-trips through storage and expires after an hour", () => {
    const held = handoverFromIntent(record, 1000, "Café");
    writeJamHandover(storage, held);
    expect(readJamHandover(storage, 1000 + 5)).toEqual(held);
    expect(readJamHandover(storage, 1000 + JAM_HANDOVER_TTL_MS)).toEqual(held);
    expect(readJamHandover(storage, 1000 + JAM_HANDOVER_TTL_MS + 1)).toBeNull();
  });

  it("reads anything unreadable as no handover", () => {
    expect(readJamHandover(null)).toBeNull();
    storage.setItem("pqp:jam-handover", "not json");
    expect(readJamHandover(storage)).toBeNull();
    storage.setItem("pqp:jam-handover", JSON.stringify({ target: 4 }));
    expect(readJamHandover(storage)).toBeNull();
    storage.setItem("pqp:jam-handover", JSON.stringify(handoverFromIntent(record, Date.now() + 10 * 60_000)));
    expect(readJamHandover(storage)).toBeNull();
  });

  it("is removed on request, and storage that throws costs nothing", () => {
    writeJamHandover(storage, handoverFromIntent(record, 1));
    removeJamHandover(storage);
    expect(readJamHandover(storage, 2)).toBeNull();
    const denied = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(readJamHandover(denied)).toBeNull();
    expect(() => writeJamHandover(denied, handoverFromIntent(record, 1))).not.toThrow();
    expect(() => removeJamHandover(denied)).not.toThrow();
  });
});

describe("where closing a public jam goes", () => {
  it("leaves for the Jam site only for the song the visitor came for", () => {
    const held = handoverFromIntent(record, 1);
    expect(leavesToJamSite(held, SONG)).toBe(true);
    // A member opening some other public jam from the wall closes the old way.
    expect(leavesToJamSite(held, OTHER)).toBe(false);
    expect(leavesToJamSite(held, "new")).toBe(false);
  });

  it("a visitor who came to start a jam leaves from the start sheet", () => {
    expect(leavesToJamSite(handoverFromIntent({ kind: "new" }, 1), "new")).toBe(true);
  });

  it("closes the old way with no handover at all", () => {
    expect(leavesToJamSite(null, SONG)).toBe(false);
    expect(leavesToJamSite(null, "new")).toBe(false);
  });
});
