import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOSAVE_INTERVAL_MS,
  createSaves,
  equalBytes,
  gunzip,
  gzip,
  sramKey,
  SRAM_INTERVAL_MS,
  stateKey,
  thumbKey,
  thumbSize,
  UNDO_WINDOW_MS,
  type Saves,
  type SavesEvent,
  type SavesRuntime,
} from "./saves";
import { KEY_PATTERN, memoryStore, StoreError, type DeviceStore } from "./store";
import { STRINGS } from "./i18n";
import { formatAgo, formatBytes, slotName } from "./ui/slot-drawer";

const SHA = "a".repeat(64);
const bytes = (...values: number[]) => new Uint8Array(values);

/** A console that is only bytes: nothing of a real game in it. */
function fakeRuntime(version = "4.2.3") {
  const runtime = {
    sram: null as Uint8Array | null,
    state: bytes(1, 2, 3, 4),
    loaded: null as Uint8Array | null,
    readSramCalls: 0,
    failScreenshot: false,
    async getState() {
      return runtime.state.slice();
    },
    async getStateRecord() {
      return { core: "mgba" as const, coreVersion: version, data: runtime.state.slice() };
    },
    stateInfo() {
      return { core: "mgba" as const, coreVersion: version };
    },
    async loadState(data: Uint8Array) {
      runtime.loaded = data.slice();
    },
    async screenshot() {
      if (runtime.failScreenshot) throw new Error("no frame");
      return new Blob([bytes(9, 9)], { type: "image/png" });
    },
    async readSram() {
      runtime.readSramCalls += 1;
      return runtime.sram ? runtime.sram.slice() : null;
    },
    async writeSram(data: Uint8Array) {
      runtime.sram = data.slice();
    },
  };
  return runtime satisfies SavesRuntime;
}

/** The store as a later visit finds it: a new object holding what was kept. */
async function reloaded(store: DeviceStore): Promise<DeviceStore> {
  const next = memoryStore();
  for (const row of await store.list("")) {
    const entry = await store.get(row.key);
    if (entry) await next.put(row.key, entry.bytes, entry.meta);
  }
  return next;
}

const thumbnail = async () => bytes(7, 7, 7);

function setup(over: { store?: DeviceStore; runtime?: ReturnType<typeof fakeRuntime>; autosave?: boolean; requireShelf?: boolean } = {}) {
  const store = over.store ?? memoryStore();
  const runtime = over.runtime ?? fakeRuntime();
  const saves = createSaves({
    store,
    runtime,
    sha: SHA,
    thumbnail,
    watchVisibility: false,
    autosave: over.autosave,
    ...(over.requireShelf !== undefined ? { requireShelf: over.requireShelf } : {}),
  });
  const events: SavesEvent[] = [];
  saves.on((event) => events.push(event));
  return { store, runtime, saves, events };
}

const types = (events: SavesEvent[]) => events.map((event) => event.type);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("store keys", () => {
  it("are the ones the store accepts", () => {
    for (const key of [sramKey(SHA), stateKey(SHA, "auto"), stateKey(SHA, 3), thumbKey(SHA, 1)]) {
      expect(KEY_PATTERN.test(key), key).toBe(true);
    }
    expect(stateKey(SHA, 2)).toBe(`state:${SHA}:2`);
  });
});

describe("the battery save", () => {
  it("is written every 30 s only when it changed", async () => {
    const { saves, runtime, store, events } = setup();
    saves.start();
    runtime.sram = bytes(1, 1, 1);
    await vi.advanceTimersByTimeAsync(SRAM_INTERVAL_MS);
    expect((await store.get(sramKey(SHA)))?.bytes).toEqual(bytes(1, 1, 1));
    expect(events.filter((event) => event.type === "sram-saved")).toHaveLength(1);

    // nothing changed: read, compare, no write
    await vi.advanceTimersByTimeAsync(SRAM_INTERVAL_MS);
    expect(runtime.readSramCalls).toBe(2);
    expect(events.filter((event) => event.type === "sram-saved")).toHaveLength(1);

    runtime.sram = bytes(2, 2, 2);
    await vi.advanceTimersByTimeAsync(SRAM_INTERVAL_MS);
    expect((await store.get(sramKey(SHA)))?.bytes).toEqual(bytes(2, 2, 2));
    saves.dispose();
  });

  it("is written when the page goes hidden and on Ejetar", async () => {
    const { saves, runtime, store, events } = setup();
    saves.start();
    runtime.sram = bytes(5);
    expect(await saves.flushSram("hidden")).toBe(true);
    expect((await store.get(sramKey(SHA)))?.bytes).toEqual(bytes(5));

    runtime.sram = bytes(6);
    await saves.eject();
    expect((await store.get(sramKey(SHA)))?.bytes).toEqual(bytes(6));
    expect(events.filter((event) => event.type === "sram-saved").map((event) => (event as { reason: string }).reason)).toEqual(["hidden", "eject"]);
  });

  it("survives a session end and a reload of the store", async () => {
    const first = setup();
    first.saves.start();
    first.runtime.sram = bytes(4, 5, 6, 7);
    await first.saves.end();

    // a later visit: the store object is new, the console is new, the person has not touched anything
    const store = await reloaded(first.store);
    const second = setup({ store });
    expect(await second.saves.restoreSram()).toBe(true);
    expect(second.runtime.sram).toEqual(bytes(4, 5, 6, 7));
    expect(second.saves.sramSavedAt).toBe(Date.now());

    // what was restored is the baseline: an unchanged save is not written again
    second.saves.start();
    expect(await second.saves.flushSram("interval")).toBe(false);
  });

  it("restores nothing for a game with no save yet", async () => {
    const { saves, runtime } = setup();
    expect(await saves.restoreSram()).toBe(false);
    expect(runtime.sram).toBeNull();
  });

  it("is not erased by a core that has none", async () => {
    const { saves, runtime, store } = setup();
    saves.start();
    runtime.sram = bytes(1);
    await saves.flushSram("interval");
    runtime.sram = null;
    expect(await saves.flushSram("interval")).toBe(false);
    expect((await store.get(sramKey(SHA)))?.bytes).toEqual(bytes(1));
  });

  it("reports a full disk and keeps playing", async () => {
    const store = memoryStore(4);
    const { saves, runtime, events } = setup({ store });
    saves.start();
    runtime.sram = bytes(1, 2, 3, 4, 5, 6);
    expect(await saves.flushSram("interval")).toBe(false);
    expect(types(events)).toEqual(["storage-full", "error"]);
  });
});

describe("a battery save only for a game that has one", () => {
  it("writes nothing for a buffer of zeros or of 0xFF, which is what a cartridge without a battery hands back", async () => {
    const { saves, runtime, store, events } = setup();
    saves.start();
    for (const blank of [new Uint8Array(32 * 1024), new Uint8Array(64 * 1024).fill(0xff)]) {
      runtime.sram = blank;
      await vi.advanceTimersByTimeAsync(SRAM_INTERVAL_MS);
      expect(await saves.flushSram("hidden")).toBe(false);
    }
    expect(await store.get(sramKey(SHA))).toBeNull();
    expect(events.filter((event) => event.type === "sram-saved")).toHaveLength(0);
    expect(saves.hasBattery).toBe(false);
    expect(saves.sramSavedAt).toBeNull();
    // and nothing to write on the way out either
    await saves.eject();
    expect(await store.get(sramKey(SHA))).toBeNull();
  });

  it("starts writing the moment the game puts real data in, and from then on says it has a battery", async () => {
    const { saves, runtime, store } = setup();
    saves.start();
    runtime.sram = new Uint8Array(8).fill(0xff);
    expect(await saves.flushSram("interval")).toBe(false);
    runtime.sram = Uint8Array.of(0xff, 0xff, 0x10, 0xff, 0xff, 0xff, 0xff, 0xff);
    expect(await saves.flushSram("interval")).toBe(true);
    expect(saves.hasBattery).toBe(true);
    expect((await store.get(sramKey(SHA)))?.bytes).toEqual(runtime.sram);
    saves.dispose();
  });

  it("a restored battery save counts as one, even before the game touches it again", async () => {
    const first = setup();
    first.saves.start();
    first.runtime.sram = bytes(4, 5, 6);
    await first.saves.flushSram("interval");
    first.saves.dispose();
    const second = setup({ store: await reloaded(first.store) });
    expect(second.saves.hasBattery).toBe(false);
    expect(await second.saves.restoreSram()).toBe(true);
    expect(second.saves.hasBattery).toBe(true);
  });
});

describe("a cartridge that is not on the shelf leaves nothing behind", () => {
  async function shelved(store: DeviceStore) {
    await store.put(`meta:${SHA}`, bytes(1), { sha256: SHA });
  }

  it("says the device is full for F2 and the slots, instead of saying Salvo", async () => {
    const { saves, store, events } = setup({ requireShelf: true });
    saves.start();
    const result = await saves.saveSlot(1);
    expect(result).toEqual({ ok: false, reason: "not-shelved" });
    expect(types(events)).toEqual(["storage-full"]);
    expect(types(events)).not.toContain("slot-saved");
    expect((await store.list("")).map((row) => row.key)).toEqual([]);
    expect(saves.canUndo).toBe(false);
    saves.dispose();
  });

  it("writes no battery save, no autosave, and nothing on Ejetar", async () => {
    const { saves, runtime, store, events } = setup({ requireShelf: true });
    saves.start();
    runtime.sram = bytes(1, 2, 3);
    await vi.advanceTimersByTimeAsync(SRAM_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS);
    await saves.eject();
    expect((await store.list("")).map((row) => row.key)).toEqual([]);
    // the rolling autosave and the battery save are quiet: no toast every two minutes about a disk nobody asked about
    expect(types(events)).toEqual([]);
  });

  it("saves as usual once the cartridge is on the shelf", async () => {
    const store = memoryStore();
    await shelved(store);
    const { saves, runtime } = setup({ store, requireShelf: true });
    saves.start();
    runtime.sram = bytes(9, 9);
    expect((await saves.saveSlot(2)).ok).toBe(true);
    expect(await saves.flushSram("hidden")).toBe(true);
    expect((await store.list("")).map((row) => row.key).sort()).toEqual(
      [`meta:${SHA}`, sramKey(SHA), stateKey(SHA, 2), thumbKey(SHA, 2)].sort(),
    );
    saves.dispose();
  });

  it("is off by default: a bare store is still written to", async () => {
    const { saves } = setup();
    saves.start();
    expect((await saves.saveSlot(1)).ok).toBe(true);
    saves.dispose();
  });
});

describe("the rolling autosave", () => {
  it("fires every 2 minutes of play", async () => {
    const { saves, store, events } = setup();
    saves.start();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS - 1000);
    expect(await store.get(stateKey(SHA, "auto"))).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await saves.settled();
    expect(await store.get(stateKey(SHA, "auto"))).not.toBeNull();
    expect(types(events)).toContain("autosaved");

    const first = (await store.get(stateKey(SHA, "auto")))!.meta!.savedAt as number;
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS);
    await saves.settled();
    expect((await store.get(stateKey(SHA, "auto")))!.meta!.savedAt as number).toBeGreaterThan(first);
    saves.dispose();
  });

  it("pauses with the game and resumes where it left off", async () => {
    const { saves, store } = setup();
    saves.start();
    await vi.advanceTimersByTimeAsync(90_000);
    saves.setPaused(true);

    // a long pause is not play
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await store.get(stateKey(SHA, "auto"))).toBeNull();

    saves.setPaused(false);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(await store.get(stateKey(SHA, "auto"))).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await saves.settled();
    expect(await store.get(stateKey(SHA, "auto"))).not.toBeNull();
    saves.dispose();
  });

  it("stops when the switch is off and starts a fresh interval when it is turned on", async () => {
    const { saves, store, events } = setup({ autosave: false });
    saves.start();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS * 2);
    expect(await store.get(stateKey(SHA, "auto"))).toBeNull();

    saves.setAutosave(true);
    expect(types(events)).toContain("autosave-switched");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS - 1000);
    expect(await store.get(stateKey(SHA, "auto"))).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await saves.settled();
    expect(await store.get(stateKey(SHA, "auto"))).not.toBeNull();
    saves.dispose();
  });

  it("is written on Ejetar after real play, and not over a good one after a glance", async () => {
    const glance = setup();
    glance.saves.start();
    await vi.advanceTimersByTimeAsync(3000);
    await glance.saves.eject();
    expect(await glance.store.get(stateKey(SHA, "auto"))).toBeNull();

    const played = setup();
    played.saves.start();
    await vi.advanceTimersByTimeAsync(20_000);
    await played.saves.eject();
    expect(await played.store.get(stateKey(SHA, "auto"))).not.toBeNull();
    expect(types(played.events)).toContain("autosaved");
  });

  it("does not count paused time as play for Ejetar", async () => {
    const { saves, store } = setup();
    saves.start();
    await vi.advanceTimersByTimeAsync(3000);
    saves.setPaused(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await saves.eject();
    expect(await store.get(stateKey(SHA, "auto"))).toBeNull();
  });

  it("stops every timer once ended", async () => {
    const { saves, runtime } = setup();
    saves.start();
    await saves.end();
    const reads = runtime.readSramCalls;
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS * 3);
    expect(runtime.readSramCalls).toBe(reads);
    expect(await saves.saveSlot(1)).toEqual({ ok: false, reason: "not-started" });
  });
});

describe("slots", () => {
  async function started(over: Parameters<typeof setup>[0] = {}): Promise<ReturnType<typeof setup> & { saves: Saves }> {
    const made = setup(over);
    made.saves.start();
    return made;
  }

  it("save a gzipped state with its thumbnail and meta, and load it back", async () => {
    const { saves, runtime, store, events } = await started();
    runtime.state = bytes(...Array.from({ length: 300 }, (_, i) => i % 3));
    expect(await saves.saveSlot(2)).toEqual({ ok: true, slot: 2 });

    const entry = (await store.get(stateKey(SHA, 2)))!;
    expect(entry.meta).toMatchObject({ core: "mgba", coreVersion: "4.2.3", origin: "device", enc: "gzip", size: 300 });
    expect(entry.bytes.length).toBeLessThan(300);
    expect(await gunzip(entry.bytes)).toEqual(runtime.state);
    expect((await store.get(thumbKey(SHA, 2)))?.bytes).toEqual(bytes(7, 7, 7));
    expect(events).toContainEqual(expect.objectContaining({ type: "slot-saved", slot: 2, overwrote: false }));

    runtime.state = bytes(0);
    expect(await saves.loadSlot(2)).toEqual({ ok: true, slot: 2 });
    expect(runtime.loaded).toEqual(bytes(...Array.from({ length: 300 }, (_, i) => i % 3)));
    expect(types(events)).toContain("slot-loaded");
  });

  it("list as the autosave and four slots, empty ones included", async () => {
    const { saves } = await started();
    await saves.saveSlot(3);
    const list = await saves.listSlots();
    expect(list.map((slot) => slot.slot)).toEqual(["auto", 1, 2, 3, 4]);
    expect(list.map((slot) => slot.empty)).toEqual([true, true, true, false, true]);
    const three = list[3]!;
    expect(three).toMatchObject({ origin: "device", core: "mgba", coreVersion: "4.2.3", sameConsole: true, savedAt: Date.now() });
    expect(three.thumb).toEqual(bytes(7, 7, 7));
    expect(three.size).toBeGreaterThan(3);
  });

  it("are saved without a picture when the frame cannot be taken", async () => {
    const { saves, runtime, store } = await started();
    runtime.failScreenshot = true;
    expect(await saves.saveSlot(1)).toEqual({ ok: true, slot: 1 });
    expect(await store.get(thumbKey(SHA, 1))).toBeNull();
    expect((await saves.listSlots())[1]!.thumb).toBeNull();
  });

  it("answer empty for a slot with nothing, and select, cycle and quick-save the chosen one", async () => {
    const { saves, store, events } = await started();
    expect(await saves.loadSlot(4)).toEqual({ ok: false, reason: "empty" });
    expect(saves.currentSlot).toBe(1);
    saves.selectSlot(3);
    expect(saves.cycleSlot(1)).toBe(4);
    expect(saves.cycleSlot(1)).toBe(1);
    expect(saves.cycleSlot(-1)).toBe(4);
    await saves.quickSave();
    expect(await store.get(stateKey(SHA, 4))).not.toBeNull();
    expect(types(events)).toContain("slot-selected");
    expect(await saves.quickLoad()).toEqual({ ok: true, slot: 4 });
  });

  it("survive a reload of the store", async () => {
    const first = await started();
    first.runtime.state = bytes(8, 8, 8);
    await first.saves.saveSlot(1);
    await first.saves.end();

    const second = setup({ store: await reloaded(first.store) });
    second.saves.start();
    expect(await second.saves.loadSlot(1)).toEqual({ ok: true, slot: 1 });
    expect(second.runtime.loaded).toEqual(bytes(8, 8, 8));
  });

  it("do not save before the game is on screen", async () => {
    const { saves } = setup();
    expect(await saves.saveSlot(1)).toEqual({ ok: false, reason: "not-started" });
  });

  it("reports a full disk as too-large", async () => {
    const { saves, events } = await started({ store: memoryStore(2) });
    expect(await saves.saveSlot(1)).toEqual({ ok: false, reason: "too-large" });
    expect(types(events)).toContain("storage-full");
  });

  it("are deleted with their thumbnails", async () => {
    const { saves, store } = await started();
    await saves.saveSlot(1);
    expect(await saves.deleteSlot(1)).toBe(true);
    expect(await store.get(stateKey(SHA, 1))).toBeNull();
    expect(await store.get(thumbKey(SHA, 1))).toBeNull();
    expect(await saves.deleteSlot(1)).toBe(false);
  });
});

describe("undo", () => {
  it("puts back what an overwrite replaced", async () => {
    const { saves, runtime, store, events } = setup();
    saves.start();
    runtime.state = bytes(1);
    await saves.saveSlot(2);
    runtime.state = bytes(2);
    await saves.saveSlot(2);
    expect(events.at(-1)).toMatchObject({ type: "slot-saved", slot: 2, overwrote: true, undoUntil: Date.now() + UNDO_WINDOW_MS });
    expect(saves.canUndo).toBe(true);

    expect(await saves.undo()).toBe(true);
    expect(await gunzip((await store.get(stateKey(SHA, 2)))!.bytes)).toEqual(bytes(1));
    expect(types(events)).toContain("undone");
    expect(saves.canUndo).toBe(false);
    expect(await saves.undo()).toBe(false);
  });

  it("empties a slot that a first save filled", async () => {
    const { saves, store } = setup();
    saves.start();
    await saves.saveSlot(1);
    expect(await saves.undo()).toBe(true);
    expect(await store.get(stateKey(SHA, 1))).toBeNull();
    expect(await store.get(thumbKey(SHA, 1))).toBeNull();
  });

  it("stops working after 10 s", async () => {
    const { saves, runtime, store, events } = setup();
    saves.start();
    runtime.state = bytes(1);
    await saves.saveSlot(2);
    runtime.state = bytes(2);
    await saves.saveSlot(2);

    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS - 1);
    expect(saves.canUndo).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves.canUndo).toBe(false);
    expect(types(events)).toContain("undo-expired");
    expect(await saves.undo()).toBe(false);
    expect(await gunzip((await store.get(stateKey(SHA, 2)))!.bytes)).toEqual(bytes(2));
  });

  it("only remembers the last change", async () => {
    const { saves, runtime, store } = setup();
    saves.start();
    runtime.state = bytes(1);
    await saves.saveSlot(1);
    runtime.state = bytes(2);
    await saves.saveSlot(2);
    await saves.undo();
    // slot 2 is gone again, slot 1 is untouched
    expect(await store.get(stateKey(SHA, 2))).toBeNull();
    expect(await store.get(stateKey(SHA, 1))).not.toBeNull();
  });

  it("brings back a deleted slot", async () => {
    const { saves, runtime, store } = setup();
    saves.start();
    runtime.state = bytes(3);
    await saves.saveSlot(4);
    await saves.deleteSlot(4);
    expect(await saves.undo()).toBe(true);
    expect(await gunzip((await store.get(stateKey(SHA, 4)))!.bytes)).toEqual(bytes(3));
    expect((await store.get(thumbKey(SHA, 4)))?.bytes).toEqual(bytes(7, 7, 7));
  });

  it("is not offered for the rolling autosave", async () => {
    const { saves } = setup();
    saves.start();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS);
    await saves.settled();
    expect(saves.canUndo).toBe(false);
    saves.dispose();
  });
});

describe("another console version", () => {
  it("is refused with a warning, and loads when the person insists", async () => {
    const store = memoryStore();
    const old = setup({ store, runtime: fakeRuntime("4.2.3") });
    old.saves.start();
    old.runtime.state = bytes(4, 4);
    await old.saves.saveSlot(1);
    old.saves.dispose();

    const next = setup({ store, runtime: fakeRuntime("4.3.0") });
    next.saves.start();
    const refused = await next.saves.loadSlot(1);
    expect(refused).toEqual({
      ok: false,
      reason: "other-console",
      saved: { core: "mgba", coreVersion: "4.2.3" },
      current: { core: "mgba", coreVersion: "4.3.0" },
    });
    expect(next.runtime.loaded).toBeNull();
    expect(types(next.events)).toContain("old-core");
    expect((await next.saves.listSlots())[1]!.sameConsole).toBe(false);

    expect(await next.saves.loadSlot(1, { force: true })).toEqual({ ok: true, slot: 1 });
    expect(next.runtime.loaded).toEqual(bytes(4, 4));
  });

  it("opens a state stored without compression", async () => {
    const { saves, runtime, store } = setup();
    saves.start();
    await store.put(stateKey(SHA, 2), bytes(5, 5), { core: "mgba", coreVersion: "4.2.3", savedAt: 1, enc: "raw" });
    expect(await saves.loadSlot(2)).toEqual({ ok: true, slot: 2 });
    expect(runtime.loaded).toEqual(bytes(5, 5));
  });

  it("fails cleanly on a damaged state", async () => {
    const { saves, store, events } = setup();
    saves.start();
    await store.put(stateKey(SHA, 2), bytes(1, 2, 3), { core: "mgba", coreVersion: "4.2.3", savedAt: 1, enc: "gzip" });
    expect(await saves.loadSlot(2)).toEqual({ ok: false, reason: "failed" });
    expect(types(events)).toContain("error");
  });
});

describe("helpers", () => {
  it("gzip round trips and shrinks a repetitive state", async () => {
    const data = new Uint8Array(4096).fill(7);
    const packed = await gzip(data);
    expect(packed).not.toBeNull();
    expect(packed!.length).toBeLessThan(200);
    expect(equalBytes(await gunzip(packed!), data)).toBe(true);
  });

  it("thumbSize scales to 160 wide and never up", () => {
    expect(thumbSize(256, 240)).toEqual({ width: 160, height: 150 });
    expect(thumbSize(240, 160)).toEqual({ width: 160, height: 107 });
    expect(thumbSize(160, 144)).toEqual({ width: 160, height: 144 });
    expect(thumbSize(100, 80)).toEqual({ width: 100, height: 80 });
    expect(thumbSize(0, 0).width).toBe(160);
  });

  it("formatAgo and formatBytes read well", () => {
    const now = Date.UTC(2026, 9, 19, 12, 0, 0);
    expect(formatAgo(now - 2000, now, "pt-BR")).toBe("agora");
    expect(formatAgo(now - 40_000, now, "pt-BR")).toBe("há 40 segundos");
    expect(formatAgo(now - 5 * 60_000, now, "en")).toBe("5 minutes ago");
    expect(formatAgo(now - 3 * 3_600_000, now, "pt-BR")).toBe("há 3 horas");
    expect(formatBytes(512, "en")).toBe("512 B");
    expect(formatBytes(1536, "en")).toBe("1.5 KB");
    expect(formatBytes(1_258_291, "pt-BR")).toBe("1,2 MB");
  });

  it("slotName", () => {
    expect(slotName("auto", STRINGS.en)).toBe("Autosave");
    expect(slotName(3, STRINGS["pt-BR"])).toBe("Slot 3");
  });

  it("StoreError is how a full disk is told apart", () => {
    expect(new StoreError("too-large", "x").code).toBe("too-large");
  });
});

describe("copy", () => {
  const keys = [
    "saves.title",
    "saves.close",
    "saves.auto",
    "saves.slot",
    "saves.autoHint",
    "saves.autoEmpty",
    "saves.saveHere",
    "saves.loadAria",
    "saves.saveAria",
    "saves.more",
    "saves.delete",
    "saves.originLocal",
    "saves.originPhone",
    "saves.tryAnyway",
    "saves.autoSwitch",
    "saves.sramAt",
    "saves.emptyThumb",
    "saves.usage",
  ] as const;

  it("has the drawer's keys in every language, with no em dash and no formal pronoun in pt-BR", () => {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      for (const key of keys) {
        const value = STRINGS[locale][key];
        expect(value, `${locale}.${key}`).toBeTruthy();
        expect(value.includes("—"), `${locale}.${key}`).toBe(false);
      }
    }
    for (const key of keys) expect(/\bvoc[eê]\b/i.test(STRINGS["pt-BR"][key])).toBe(false);
  });

  it("keeps the same slots in every language", () => {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      expect(STRINGS[locale]["saves.slot"]).toContain("{n}");
      expect(STRINGS[locale]["saves.loadAria"]).toContain("{name}");
      expect(STRINGS[locale]["saves.sramAt"]).toContain("{ago}");
      expect(STRINGS[locale]["saves.usage"]).toContain("{used}");
    }
  });
});
