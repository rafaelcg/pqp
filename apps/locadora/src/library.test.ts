import { describe, expect, it } from "vitest";
import {
  addToLibrary,
  attachFile,
  AUTOSAVE_SLOT,
  autosaveAt,
  displayTitle,
  filterItems,
  formatAgo,
  formatBytes,
  formatPlaytime,
  getItem,
  groupCounts,
  loadLibrary,
  manualSlots,
  markPlayed,
  MAX_USER_TITLE,
  metaKey,
  nextUntitledTitle,
  parseStoredItem,
  pickContinue,
  platformForExt,
  removeItem,
  renameItem,
  romKey,
  sanitiseUserTitle,
  sha256Hex,
  sortItems,
  sramKey,
  stateKey,
  thumbKey,
  usageLevel,
  type LibraryItem,
} from "./library";
import { KEY_PATTERN, memoryStore, type DeviceStore } from "./store";

/** Made-up bytes: a header of our own invention, never a real game's. */
function bytesOf(seed: number, length = 0x200): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 7) & 0xff;
  return out;
}

function gameBoyBytes(seed: number, title: string): Uint8Array {
  const out = bytesOf(seed, 0x200);
  out.fill(0, 0x134, 0x144);
  for (let i = 0; i < title.length; i++) out[0x134 + i] = title.charCodeAt(i);
  out[0x143] = 0; // not a Color cart
  return out;
}

function item(n: number, patch: Partial<LibraryItem> = {}): LibraryItem {
  return {
    sha256: n.toString(16).padStart(64, "0"),
    platform: "nes",
    ext: ".nes",
    bytes: 1000 * n,
    headerTitle: "",
    userTitle: `Fita ${n}`,
    addedAt: 1000 + n,
    lastPlayedAt: 0,
    playSeconds: 0,
    artSeed: n,
    hasSram: false,
    slots: [],
    hasFile: true,
    ...patch,
  };
}

describe("sha256Hex", () => {
  it("matches the known vector for 'abc'", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("platformForExt", () => {
  it("maps the extensions the picker reports, with or without the dot, any case", () => {
    expect(platformForExt(".nes")).toBe("nes");
    expect(platformForExt("GBA")).toBe("gba");
    expect(platformForExt(".gb")).toBe("gb");
    expect(platformForExt(".gbc")).toBe("gbc");
    expect(platformForExt(".sfc")).toBe("snes");
    expect(platformForExt(".zip")).toBeNull();
    expect(platformForExt("")).toBeNull();
  });
});

describe("addToLibrary", () => {
  it("hashes, keeps the bytes and the item, and reads a header title", async () => {
    const store = memoryStore();
    const bytes = gameBoyBytes(1, "TESTCART");
    const sha = await sha256Hex(bytes);
    const result = await addToLibrary(store, { bytes, ext: ".gb", now: 5000 });
    expect(result).not.toBeNull();
    expect(result!.isNew).toBe(true);
    expect(result!.stored).toBe(true);
    expect(result!.askName).toBe(false);
    expect(result!.item).toMatchObject({ sha256: sha, platform: "gb", ext: ".gb", bytes: bytes.length, headerTitle: "TESTCART", userTitle: "", addedAt: 5000, lastPlayedAt: 0 });
    expect((await store.get(romKey(sha)))?.bytes).toEqual(bytes);
    for (const row of await store.list("")) expect(KEY_PATTERN.test(row.key)).toBe(true);
    expect((await store.list("")).map((r) => r.key).sort()).toEqual([metaKey(sha), romKey(sha)].sort());
    expect((await loadLibrary(store)).map((i) => i.sha256)).toEqual([sha]);
  });

  it("a file already on the shelf comes back as known, unchanged", async () => {
    const store = memoryStore();
    const bytes = gameBoyBytes(2, "TWICE");
    const first = await addToLibrary(store, { bytes, ext: ".gb", now: 1 });
    await markPlayed(store, first!.item.sha256, 9000, 60);
    const again = await addToLibrary(store, { bytes, ext: ".gb", now: 99999 });
    expect(again!.isNew).toBe(false);
    expect(again!.askName).toBe(false);
    expect(again!.item.addedAt).toBe(1);
    expect(again!.item.lastPlayedAt).toBe(9000);
    expect(await loadLibrary(store)).toHaveLength(1);
  });

  it("does not ask for a name when the device would not keep the cartridge: there is no shelf row to name", async () => {
    const full = memoryStore(100);
    const result = await addToLibrary(full, { bytes: bytesOf(4), ext: ".nes", fallbackTitle: "Fita sem nome 1" });
    expect(result!.stored).toBe(false);
    expect(result!.askName).toBe(false);
    expect(await loadLibrary(full)).toEqual([]);
  });

  it("puts the bytes back when only the row survived", async () => {
    const store = memoryStore();
    const bytes = gameBoyBytes(3, "HALF");
    const first = await addToLibrary(store, { bytes, ext: ".gb" });
    await store.delete(romKey(first!.item.sha256));
    await addToLibrary(store, { bytes, ext: ".gb" });
    expect((await store.get(romKey(first!.item.sha256)))?.bytes).toEqual(bytes);
  });

  it("asks for a name only on NES, with the fallback title prefilled and already saved", async () => {
    const store = memoryStore();
    const nes = await addToLibrary(store, { bytes: bytesOf(4), ext: ".nes", fallbackTitle: "Fita sem nome 1" });
    expect(nes!.askName).toBe(true);
    expect(nes!.item.headerTitle).toBe("");
    expect(nes!.item.userTitle).toBe("Fita sem nome 1");
    expect(displayTitle(nes!.item)).toBe("Fita sem nome 1");
    // the same file again never asks
    expect((await addToLibrary(store, { bytes: bytesOf(4), ext: ".nes" }))!.askName).toBe(false);
  });

  it("a titled Game Boy file keeps the header's title and ignores the fallback", async () => {
    const store = memoryStore();
    const r = await addToLibrary(store, { bytes: gameBoyBytes(5, "HEADERED"), ext: ".gb", fallbackTitle: "Fita sem nome 1" });
    expect(r!.item.userTitle).toBe("");
    expect(displayTitle(r!.item)).toBe("HEADERED");
  });

  it("refuses an extension it cannot run", async () => {
    expect(await addToLibrary(memoryStore(), { bytes: bytesOf(6), ext: ".zip" })).toBeNull();
  });

  it("is not an error when the device will not keep it: stored false, nothing left behind", async () => {
    const small = memoryStore(100);
    const r = await addToLibrary(small, { bytes: bytesOf(7, 0x200), ext: ".nes" });
    expect(r!.stored).toBe(false);
    expect(r!.isNew).toBe(true);
    expect(await small.list("")).toEqual([]);

    // room for the file but not for its row: the file is taken back out
    const sha = await sha256Hex(bytesOf(8, 64));
    const tight = memoryStore(64);
    const real = tight.put.bind(tight);
    tight.put = async (key, b, meta) => {
      if (key === metaKey(sha)) throw new Error("refused");
      return real(key, b, meta);
    };
    const r2 = await addToLibrary(tight, { bytes: bytesOf(8, 64), ext: ".nes" });
    expect(r2!.stored).toBe(false);
    expect(await tight.list("")).toEqual([]);
  });

  it("keeps the item's meta well under the host's 2 KB, with the longest title", async () => {
    const store = memoryStore();
    const r = await addToLibrary(store, { bytes: bytesOf(9), ext: ".nes", fallbackTitle: "x".repeat(200) });
    expect(r!.item.userTitle.length).toBe(MAX_USER_TITLE);
    const row = (await store.list(metaKey("")))[0]!;
    expect(new TextEncoder().encode(JSON.stringify(row.meta)).length).toBeLessThan(700);
  });
});

describe("a box with no game file", () => {
  it("is derived from the rom row: the box is still on the shelf, and attaching the same file brings the cartridge back", async () => {
    const store = memoryStore();
    const bytes = gameBoyBytes(5, "NOFILE");
    const added = await addToLibrary(store, { bytes, ext: ".gb" });
    const sha = added!.item.sha256;
    expect((await loadLibrary(store))[0]!.hasFile).toBe(true);
    await store.delete(romKey(sha));
    expect((await loadLibrary(store))[0]!.hasFile).toBe(false);
    expect((await getItem(store, sha))?.hasFile).toBe(false);

    const wrong = await attachFile(store, { sha256: sha }, gameBoyBytes(6, "OTHER"));
    expect(wrong).toEqual({ ok: false, reason: "mismatch" });
    expect(await store.get(romKey(sha))).toBeNull();

    expect(await attachFile(store, { sha256: sha }, bytes)).toEqual({ ok: true, stored: true });
    expect((await store.get(romKey(sha)))?.bytes).toEqual(bytes);
    expect((await getItem(store, sha))?.hasFile).toBe(true);
  });

  it("says stored: false when the device is full, the file still matched", async () => {
    const store = memoryStore();
    const bytes = gameBoyBytes(7, "FULL");
    const sha = await sha256Hex(bytes);
    const full: DeviceStore = { ...store, put: async () => { throw new Error("full"); } };
    expect(await attachFile(full, { sha256: sha }, bytes)).toEqual({ ok: true, stored: false });
  });
});

describe("loadLibrary", () => {
  it("derives the battery save and the slots from the keys, in slot order", async () => {
    const store = memoryStore(undefined, () => 777);
    const a = await addToLibrary(store, { bytes: bytesOf(10), ext: ".nes", fallbackTitle: "A" });
    const b = await addToLibrary(store, { bytes: bytesOf(11), ext: ".nes", fallbackTitle: "B" });
    const sa = a!.item.sha256;
    await store.put(sramKey(sa), new Uint8Array([1]));
    await store.put(stateKey(sa, 2), new Uint8Array([1]));
    await store.put(stateKey(sa, 1), new Uint8Array([1]));
    await store.put(stateKey(sa, AUTOSAVE_SLOT), new Uint8Array([1]));
    const items = await loadLibrary(store);
    const ia = items.find((i) => i.sha256 === sa)!;
    const ib = items.find((i) => i.sha256 === b!.item.sha256)!;
    expect(ia.hasSram).toBe(true);
    expect(ia.slots.map((s) => s.slot)).toEqual(["1", "2", "auto"]);
    expect(manualSlots(ia).map((s) => s.slot)).toEqual(["1", "2"]);
    expect(autosaveAt(ia)).toBe(777);
    expect(ib.hasSram).toBe(false);
    expect(ib.slots).toEqual([]);
    expect(autosaveAt(ib)).toBeNull();
    expect((await getItem(store, sa))?.slots).toHaveLength(3);
  });

  it("skips rows that are not items, and rows whose key does not match their hash", async () => {
    const store = memoryStore();
    await addToLibrary(store, { bytes: bytesOf(12), ext: ".nes", fallbackTitle: "Ok" });
    await store.put("meta:" + "a".repeat(64), new Uint8Array([1]), { nonsense: true });
    await store.put("meta:notahash", new Uint8Array([1]), { sha256: "b".repeat(64), platform: "nes", ext: ".nes", bytes: 1, addedAt: 1 });
    await store.put("meta:" + "c".repeat(64), new Uint8Array([1]), { sha256: "d".repeat(64), platform: "nes", ext: ".nes", bytes: 1, addedAt: 1 });
    expect(await loadLibrary(store)).toHaveLength(1);
  });

  it("parseStoredItem is strict about what it trusts", () => {
    const good = { sha256: "a".repeat(64), platform: "gba", ext: ".gba", bytes: 4, addedAt: 2 };
    expect(parseStoredItem(good)).toMatchObject({ platform: "gba", lastPlayedAt: 0, playSeconds: 0, userTitle: "", headerTitle: "" });
    expect(parseStoredItem({ ...good, sha256: "nope" })).toBeNull();
    expect(parseStoredItem({ ...good, platform: "n64" })).toBeNull();
    expect(parseStoredItem({ ...good, bytes: -1 })).toBeNull();
    expect(parseStoredItem(null)).toBeNull();
    expect(parseStoredItem("x")).toBeNull();
    expect(parseStoredItem({ ...good, userTitle: "a\u0000b\nc" })?.userTitle).toBe("a b c");
  });
});

describe("rename and played", () => {
  it("renames with a cleaned title, and an empty one goes back to the header's", async () => {
    const store = memoryStore();
    const r = await addToLibrary(store, { bytes: gameBoyBytes(13, "HEADER"), ext: ".gb" });
    const sha = r!.item.sha256;
    expect((await renameItem(store, sha, "  Meu   jogo\u0007  "))?.userTitle).toBe("Meu jogo");
    expect(displayTitle((await getItem(store, sha))!)).toBe("Meu jogo");
    const cleared = await renameItem(store, sha, "   ");
    expect(cleared?.userTitle).toBe("");
    expect(displayTitle(cleared!)).toBe("HEADER");
    expect(await renameItem(store, "e".repeat(64), "x")).toBeNull();
    expect(sanitiseUserTitle("y".repeat(100)).length).toBe(MAX_USER_TITLE);
  });

  it("records the last play and adds the time", async () => {
    const store = memoryStore();
    const r = await addToLibrary(store, { bytes: bytesOf(14), ext: ".nes", fallbackTitle: "T" });
    const sha = r!.item.sha256;
    await markPlayed(store, sha, 100, 30);
    const next = await markPlayed(store, sha, 200, 45.4);
    expect(next).toMatchObject({ lastPlayedAt: 200, playSeconds: 75 });
    expect((await getItem(store, sha))?.playSeconds).toBe(75);
    expect((await markPlayed(store, sha, 300, -5))?.playSeconds).toBe(75);
  });
});

describe("removeItem", () => {
  it("deletes the rom, meta, battery save, every state and thumb of that game, and nothing of another", async () => {
    const store = memoryStore();
    const a = (await addToLibrary(store, { bytes: bytesOf(20), ext: ".nes", fallbackTitle: "A" }))!.item.sha256;
    const b = (await addToLibrary(store, { bytes: bytesOf(21), ext: ".nes", fallbackTitle: "B" }))!.item.sha256;
    for (const sha of [a, b]) {
      await store.put(sramKey(sha), new Uint8Array([1]));
      await store.put(`sync:${sha}`, new Uint8Array([1]), { v: 1, e: {} });
      for (const slot of [1, 2, 3, 4, AUTOSAVE_SLOT]) {
        await store.put(stateKey(sha, slot), new Uint8Array([1]));
        await store.put(thumbKey(sha, slot), new Uint8Array([1]));
      }
    }
    await store.put("prefs", new Uint8Array([1]));
    await store.put("seen:onboarding", new Uint8Array([1]));

    const removed = await removeItem(store, a);
    expect(removed).toContain(romKey(a));
    expect(removed).toContain(metaKey(a));
    expect(removed).toContain(sramKey(a));
    expect(removed).toContain(stateKey(a, 3));
    expect(removed).toContain(thumbKey(a, AUTOSAVE_SLOT));

    const left = (await store.list("")).map((r) => r.key);
    expect(left.filter((k) => k.includes(a))).toEqual([]);
    // the other game, the preferences and the onboarding flag are all still there
    expect(left.filter((k) => k.includes(b)).sort()).toEqual(
      [romKey(b), metaKey(b), sramKey(b), `sync:${b}`, ...[1, 2, 3, 4, AUTOSAVE_SLOT].flatMap((s) => [stateKey(b, s), thumbKey(b, s)])].sort(),
    );
    expect(left).toContain("prefs");
    expect(left).toContain("seen:onboarding");
    expect((await loadLibrary(store)).map((i) => i.sha256)).toEqual([b]);
  });

  it("does nothing for something that is not a hash, and is safe to run twice", async () => {
    const store = memoryStore();
    await store.put("prefs", new Uint8Array([1]));
    expect(await removeItem(store, "../prefs")).toEqual([]);
    // rom, meta, battery save, art and the account agreement (`sync:`), all absent and all asked for
    expect(await removeItem(store, "f".repeat(64))).toHaveLength(5);
    expect((await store.list("")).map((r) => r.key)).toEqual(["prefs"]);
  });
});

describe("views of the list", () => {
  const items = [
    item(1, { userTitle: "banana", platform: "gba", ext: ".gba", lastPlayedAt: 500 }),
    item(2, { userTitle: "Abacate", platform: "nes", lastPlayedAt: 900 }),
    item(3, { userTitle: "cereja", platform: "gbc", ext: ".gbc", addedAt: 2000 }),
    item(4, { userTitle: "Damasco", platform: "gb", ext: ".gb", addedAt: 100 }),
    item(5, { userTitle: "Figo", platform: "snes", ext: ".sfc", addedAt: 100 }),
  ];
  const titles = (list: LibraryItem[]) => list.map((i) => i.userTitle);

  it("sorts by last played (never played by when it was added), by name, by console", () => {
    expect(titles(sortItems(items, "recent"))).toEqual(["cereja", "Abacate", "banana", "Damasco", "Figo"]);
    expect(titles(sortItems(items, "name"))).toEqual(["Abacate", "banana", "cereja", "Damasco", "Figo"]);
    expect(titles(sortItems(items, "console"))).toEqual(["Abacate", "Figo", "cereja", "Damasco", "banana"]);
    // sorting copies: the input is untouched
    expect(items[0]!.userTitle).toBe("banana");
  });

  it("filters by console group, Game Boy and Color together, and counts them", () => {
    expect(titles(filterItems(items, "gb"))).toEqual(["cereja", "Damasco"]);
    expect(filterItems(items, "all")).toHaveLength(5);
    expect(groupCounts(items)).toEqual([
      { group: "nes", count: 1 },
      { group: "snes", count: 1 },
      { group: "gb", count: 2 },
      { group: "gba", count: 1 },
    ]);
    expect(groupCounts([])).toEqual([]);
  });

  it("offers Continuar for the one played last, and for nothing when nothing was played", () => {
    expect(pickContinue(items)?.userTitle).toBe("Abacate");
    expect(pickContinue([item(1), item(2)])).toBeNull();
    expect(pickContinue([])).toBeNull();
  });

  it("never offers Continuar for a box with no game file, until the file is attached", () => {
    const missing = { ...items[0]!, hasFile: false, lastPlayedAt: 9_999_999 };
    expect(pickContinue([missing])).toBeNull();
    // the next most recent one leads instead
    expect(pickContinue([...items, missing])?.userTitle).toBe("Abacate");
    expect(pickContinue([{ ...missing, hasFile: true }])?.userTitle).toBe(missing.userTitle);
  });

  it("names a tape without a title after its console, and numbers fallbacks without repeating", () => {
    expect(displayTitle({ userTitle: "", headerTitle: "", platform: "gba" })).toBe("Game Boy Advance");
    const taken = [item(1, { userTitle: "Fita sem nome 1" }), item(2, { userTitle: "fita sem nome 2" })];
    expect(nextUntitledTitle(taken, "Fita sem nome {n}")).toBe("Fita sem nome 3");
    expect(nextUntitledTitle([], "Fita sem nome {n}")).toBe("Fita sem nome 1");
  });
});

describe("numbers for the screen", () => {
  it("formats sizes, ages and play time", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(24 * 1024)).toBe("24 KB");
    expect(formatBytes(86 * 1024 * 1024)).toBe("86 MB");
    expect(formatBytes(512 * 1024 * 1024)).toBe("512 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
    const now = 10_000_000_000;
    expect(formatAgo(now - 5_000, now)).toBe("1 min");
    expect(formatAgo(now - 5 * 60_000, now)).toBe("5 min");
    expect(formatAgo(now - 2 * 3_600_000, now)).toBe("2 h");
    expect(formatAgo(now - 3 * 86_400_000, now)).toBe("3 d");
    expect(formatAgo(now + 5_000, now)).toBe("1 min");
    expect(formatPlaytime(10)).toBe("1 min");
    expect(formatPlaytime(42 * 60)).toBe("42 min");
    expect(formatPlaytime(80 * 60)).toBe("1 h 20 min");
    expect(formatPlaytime(180 * 60)).toBe("3 h");
  });

  it("turns the meter to a warning past 90% of the cap, and not before", () => {
    const cap = 512 * 1024 * 1024;
    expect(usageLevel(undefined)).toBe("ok");
    expect(usageLevel({ used: 0, cap: 0 })).toBe("ok");
    expect(usageLevel({ used: cap * 0.9, cap })).toBe("ok");
    expect(usageLevel({ used: cap * 0.91, cap })).toBe("full");
    expect(usageLevel({ used: cap, cap })).toBe("full");
  });
});
