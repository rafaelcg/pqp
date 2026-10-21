import { describe, expect, it } from "vitest";
import { defaultKeymap } from "./keymap";
import { createPrefsKeeper, defaultPrefs, loadPrefs, parsePrefs, PREFS_KEY, savePrefs } from "./prefs";
import { memoryStore } from "./store";

describe("parsePrefs", () => {
  it("gives the defaults for anything that is not an object", () => {
    for (const raw of [null, undefined, 3, "x", [], true]) expect(parsePrefs(raw)).toEqual(defaultPrefs());
  });

  it("keeps the good fields and defaults the bad ones, one by one", () => {
    const parsed = parsePrefs({
      autosave: false,
      muted: "yes",
      stage: { scale: "pixel", aspect: "weird", crt: true, ambient: 4 },
      keymaps: {
        nes: { up: "KeyW", down: "KeyS", left: "KeyA", right: "KeyD", b: "KeyJ", a: "KeyK", select: "KeyU", start: "KeyI" },
        gba: "nope",
      },
    });
    expect(parsed.autosave).toBe(false);
    expect(parsed.muted).toBe(false);
    expect(parsed.stage).toEqual({ scale: "pixel", aspect: "square", crt: true, ambient: false, bezel: false });
    expect(parsed.keymaps.nes.up).toBe("KeyW");
    // a bad console row falls back to that console's own defaults
    expect(parsed.keymaps.gba).toEqual(defaultKeymap("gba"));
  });

  it("reads a row written before the double click hint was removed: the old key is ignored, the rest is kept", async () => {
    const old = { autosave: false, muted: true, turboRatio: 4, dblclickHintSeen: true };
    const parsed = parsePrefs(old);
    expect(parsed.autosave).toBe(false);
    expect(parsed.muted).toBe(true);
    expect(parsed.turboRatio).toBe(4);
    expect("dblclickHintSeen" in parsed).toBe(false);
    // and through the store, as the bytes the old build wrote
    const store = memoryStore();
    await store.put(PREFS_KEY, new TextEncoder().encode(JSON.stringify(old)), { at: 1 });
    expect((await loadPrefs(store)).turboRatio).toBe(4);
  });

  it("refuses a keymap that binds a key the shortcuts own", () => {
    const parsed = parsePrefs({ keymaps: { nes: { ...defaultKeymap("nes"), a: "KeyP" } } });
    expect(parsed.keymaps.nes).toEqual(defaultKeymap("nes"));
  });
});

describe("the prefs row", () => {
  it("round trips through the store, and a missing or broken row is the defaults", async () => {
    const store = memoryStore();
    expect(await loadPrefs(store)).toEqual(defaultPrefs());
    const prefs = { ...defaultPrefs(), autosave: false };
    await savePrefs(store, prefs);
    expect((await loadPrefs(store)).autosave).toBe(false);
    await store.put(PREFS_KEY, new TextEncoder().encode("{not json"));
    expect(await loadPrefs(store)).toEqual(defaultPrefs());
  });

  it("writes once after a burst of changes, and flush writes at once", async () => {
    const store = memoryStore();
    let writes = 0;
    const put = store.put.bind(store);
    store.put = async (...args) => {
      writes += 1;
      return put(...args);
    };
    const keeper = createPrefsKeeper(store, defaultPrefs(), 20);
    keeper.update({ autosave: false });
    keeper.update({ muted: true });
    expect(keeper.prefs.muted).toBe(true);
    expect(writes).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(writes).toBe(1);
    const saved = await loadPrefs(store);
    expect(saved.autosave).toBe(false);
    expect(saved.muted).toBe(true);
    keeper.update({ muted: false });
    await keeper.flush();
    expect(writes).toBe(2);
    await keeper.flush();
    expect(writes).toBe(2);
  });
});

describe("the turbo's ratio in the prefs", () => {
  it("defaults to 3x", () => {
    expect(defaultPrefs().turboRatio).toBe(3);
    expect(parsePrefs({}).turboRatio).toBe(3);
  });

  it("keeps a good ratio, snaps to half steps and clamps to 1..10", () => {
    expect(parsePrefs({ turboRatio: 6.5 }).turboRatio).toBe(6.5);
    expect(parsePrefs({ turboRatio: 1 }).turboRatio).toBe(1);
    expect(parsePrefs({ turboRatio: 10 }).turboRatio).toBe(10);
    expect(parsePrefs({ turboRatio: 4.3 }).turboRatio).toBe(4.5);
    expect(parsePrefs({ turboRatio: 0 }).turboRatio).toBe(1);
    expect(parsePrefs({ turboRatio: -2 }).turboRatio).toBe(1);
    expect(parsePrefs({ turboRatio: 11 }).turboRatio).toBe(10);
    expect(parsePrefs({ turboRatio: 1e9 }).turboRatio).toBe(10);
  });

  it("tolerates a bad stored value without costing the rest of the row", () => {
    for (const bad of ["fast", "6.5", null, true, [], {}, Number.NaN]) {
      const parsed = parsePrefs({ turboRatio: bad, autosave: false, muted: true });
      expect(parsed.turboRatio, String(bad)).toBe(3);
      expect(parsed.autosave).toBe(false);
      expect(parsed.muted).toBe(true);
    }
  });

  it("survives a trip through the store, JSON and all, and a row from before it existed reads as 3x", async () => {
    const store = memoryStore();
    const keeper = createPrefsKeeper(store, defaultPrefs(), 10);
    keeper.update({ turboRatio: 7.5 });
    await keeper.flush();
    expect((await loadPrefs(store)).turboRatio).toBe(7.5);
    await store.put(PREFS_KEY, new TextEncoder().encode(JSON.stringify({ autosave: true, muted: false })));
    expect((await loadPrefs(store)).turboRatio).toBe(3);
    // a hand-edited out-of-range row
    await store.put(PREFS_KEY, new TextEncoder().encode(JSON.stringify({ turboRatio: 99 })));
    expect((await loadPrefs(store)).turboRatio).toBe(10);
  });
});
