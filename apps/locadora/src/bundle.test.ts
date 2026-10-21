import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  applyImport,
  BUNDLE_MAX_BYTES,
  exportBundle,
  planImport,
  readBundle,
} from "./bundle";
import { addToLibrary, metaKey, romKey, sha256Hex, stateKey, thumbKey, sramKey } from "./library";
import { memoryStore, type DeviceStore } from "./store";

/** Synthetic bytes with an iNES-looking header and nothing of a real game in them. */
function fakeNes(seed: number): Uint8Array {
  const out = new Uint8Array(16 + 1024);
  out.set([0x4e, 0x45, 0x53, 0x1a]);
  for (let i = 16; i < out.length; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

/** The same keys, bytes and meta, in key order. */
async function snapshot(store: DeviceStore) {
  const rows = await store.list("");
  const out: Array<{ key: string; bytes: number[]; meta: unknown }> = [];
  for (const row of rows) {
    const entry = await store.get(row.key);
    out.push({ key: row.key, bytes: entry ? [...entry.bytes] : [], meta: entry?.meta ?? null });
  }
  return out;
}

/** A shelf with one game, a battery save, a manual slot with its picture and an autosave. */
async function seeded(seed = 1) {
  const store = memoryStore();
  const bytes = fakeNes(seed);
  const added = await addToLibrary(store, { bytes, ext: ".nes", fallbackTitle: "Jogo de teste", now: 1_000 });
  if (!added) throw new Error("the test game was refused");
  const sha = added.item.sha256;
  await store.put(sramKey(sha), new Uint8Array([9, 8, 7]), { savedAt: 2_000, size: 3 });
  await store.put(
    stateKey(sha, "1"),
    new Uint8Array([1, 2, 3, 4]),
    { core: "fceumm", coreVersion: "4.2.3", savedAt: 3_000, origin: "device", enc: "raw", size: 4 },
  );
  await store.put(thumbKey(sha, "1"), new Uint8Array([137, 80, 78, 71]), { savedAt: 3_000 });
  await store.put(
    stateKey(sha, "auto"),
    new Uint8Array([5, 5]),
    { core: "fceumm", coreVersion: "4.2.3", savedAt: 4_000, origin: "device", enc: "raw", size: 2 },
  );
  return { store, sha, bytes };
}

describe("export then import", () => {
  it("round trips every key, byte and meta into a fresh store, game file included", async () => {
    const source = await seeded();
    const exported = await exportBundle(source.store, { withRom: true, now: 5_000 });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.games).toBe(1);
    expect(exported.withRom).toBe(true);

    const read = readBundle(exported.bytes);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const fresh = memoryStore();
    const plan = await planImport(fresh, read.bundle);
    expect(plan.conflicts).toBe(0);
    const applied = await applyImport(fresh, plan);
    expect(applied.ok).toBe(true);

    expect(await snapshot(fresh)).toEqual(await snapshot(source.store));
    expect((await fresh.list("")).map((row) => row.key)).toEqual(
      expect.arrayContaining([romKey(source.sha), metaKey(source.sha), sramKey(source.sha)]),
    );
  });

  it("leaves the game file out by default: saves, slots and pictures only", async () => {
    const source = await seeded();
    const exported = await exportBundle(source.store, { withRom: false });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.withRom).toBe(false);

    const read = readBundle(exported.bytes);
    if (!read.ok) throw new Error("the bundle should read");
    expect(read.bundle.items[0]!.rom).toBeNull();

    const fresh = memoryStore();
    const plan = await planImport(fresh, read.bundle);
    expect(plan.games[0]!.missingFile).toBe(true);
    await applyImport(fresh, plan);

    const keys = (await fresh.list("")).map((row) => row.key);
    expect(keys).not.toContain(romKey(source.sha));
    expect(keys).toEqual(expect.arrayContaining([metaKey(source.sha), sramKey(source.sha), stateKey(source.sha, "1")]));
  });

  it("stops packing at the file that takes the export past 64 MB, without reading the rest", async () => {
    const store = memoryStore(512 * 1024 * 1024);
    // three game files that do not compress, 34 MB each: the second one already tips the bundle over
    for (let seed = 1; seed <= 3; seed += 1) {
      const bytes = fakeNes(seed);
      const big = new Uint8Array(34 * 1024 * 1024);
      big.set(bytes.subarray(0, 16));
      let x = seed * 2654435761;
      for (let i = 16; i < big.length; i += 1) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        big[i] = x & 0xff;
      }
      const added = await addToLibrary(store, { bytes: big, ext: ".nes", fallbackTitle: `Jogo ${seed}`, now: seed });
      if (!added) throw new Error("the test game was refused");
    }
    let romReads = 0;
    const counting: DeviceStore = {
      ...store,
      durable: store.durable,
      get: (key) => {
        if (key.startsWith("rom:")) romReads += 1;
        return store.get(key);
      },
    };
    expect(await exportBundle(counting, { withRom: true })).toEqual({ ok: false, reason: "too-large" });
    expect(romReads).toBe(2);
  }, 60_000);

  it("says the shelf is empty rather than writing an empty bundle", async () => {
    const result = await exportBundle(memoryStore(), { withRom: true });
    expect(result).toEqual({ ok: false, reason: "empty" });
  });

  it("asks on a collision and keeps what is on the device unless told otherwise", async () => {
    const source = await seeded();
    const exported = await exportBundle(source.store, { withRom: false });
    if (!exported.ok) throw new Error("export failed");
    const read = readBundle(exported.bytes);
    if (!read.ok) throw new Error("the bundle should read");

    const target = memoryStore();
    await applyImport(target, await planImport(target, read.bundle));
    // this device saved slot 1 again since: its bytes differ from the file's
    await target.put(stateKey(source.sha, "1"), new Uint8Array([42, 42]), { core: "fceumm", coreVersion: "4.2.3" });

    const plan = await planImport(target, read.bundle);
    expect(plan.conflicts).toBe(1);
    expect(plan.games[0]!.isNew).toBe(false);

    const keep = await applyImport(target, plan, "keep");
    // the slot's state and its picture both wait, and the item row already there stays: three writes skipped, one collision
    expect(keep).toMatchObject({ ok: true, skipped: 3 });
    expect([...(await target.get(stateKey(source.sha, "1")))!.bytes]).toEqual([42, 42]);

    const replace = await applyImport(target, plan, "replace");
    expect(replace.ok).toBe(true);
    expect([...(await target.get(stateKey(source.sha, "1")))!.bytes]).toEqual([1, 2, 3, 4]);
  });

  it("keeps the device's item row when the game is already on the shelf", async () => {
    const source = await seeded();
    const exported = await exportBundle(source.store, { withRom: true });
    if (!exported.ok) throw new Error("export failed");
    const read = readBundle(exported.bytes);
    if (!read.ok) throw new Error("the bundle should read");

    const target = memoryStore();
    await applyImport(target, await planImport(target, read.bundle));
    const row = await target.get(metaKey(source.sha));
    await target.put(metaKey(source.sha), row!.bytes, { ...row!.meta, userTitle: "Nome deste aparelho" });

    const again = await planImport(target, read.bundle);
    expect(again.games[0]!.isNew).toBe(false);
    await applyImport(target, again, "replace");
    expect((await target.get(metaKey(source.sha)))!.meta).toMatchObject({ userTitle: "Nome deste aparelho" });
  });
});

describe("importing safely", () => {
  async function bundleOf(withRom: boolean, seed = 1) {
    const source = await seeded(seed);
    const exported = await exportBundle(source.store, { withRom });
    if (!exported.ok) throw new Error("export failed");
    const read = readBundle(exported.bytes);
    if (!read.ok) throw new Error("the bundle should read");
    return { source, bundle: read.bundle };
  }

  it("keeps a game file only under the hash of its own bytes", async () => {
    const { source, bundle } = await bundleOf(true);
    // a bundle that names this game's sha and carries other bytes
    bundle.items[0]!.rom = fakeNes(99);
    const target = memoryStore();
    const plan = await planImport(target, bundle);
    expect(plan.writes.some((w) => w.key === romKey(source.sha))).toBe(false);
    expect(plan.games[0]!.missingFile).toBe(true);
    await applyImport(target, plan);
    expect(await target.get(romKey(source.sha))).toBeNull();
    // the saves still arrive and wait for the real file
    expect(await target.get(sramKey(source.sha))).not.toBeNull();
  });

  it("a write that fails puts back what the import had already written", async () => {
    const { source, bundle } = await bundleOf(true);
    const target = memoryStore();
    const plan = await planImport(target, bundle);
    let puts = 0;
    const failing: DeviceStore = {
      ...target,
      durable: target.durable,
      get: (key) => target.get(key),
      list: (prefix) => target.list(prefix),
      usage: () => target.usage(),
      delete: (key) => target.delete(key),
      put: async (key, bytes, meta) => {
        puts += 1;
        if (puts === 3) throw new Error("disk went away");
        return target.put(key, bytes, meta);
      },
    };
    expect(await applyImport(failing, plan)).toEqual({ ok: false, reason: "failed" });
    expect(await target.list("")).toEqual([]);
    expect(await target.get(metaKey(source.sha))).toBeNull();
  });

  it("says failed, not throws, when the device cannot say how full it is", async () => {
    const { bundle } = await bundleOf(false);
    const target = memoryStore();
    const plan = await planImport(target, bundle);
    const broken: DeviceStore = { ...target, durable: target.durable, usage: () => Promise.reject(new Error("no")) };
    await expect(applyImport(broken, plan)).resolves.toEqual({ ok: false, reason: "failed" });
  });

  it("a replacing save is counted by what it adds, so a nearly full device can still take it", async () => {
    const { source, bundle } = await bundleOf(false);
    // a device with just enough room for this shelf, where the same slot holds other bytes of the same size
    const first = memoryStore();
    await applyImport(first, await planImport(first, bundle));
    const used = (await first.usage()).used;
    const tight = memoryStore(used);
    await applyImport(tight, await planImport(tight, bundle));
    await tight.put(stateKey(source.sha, "1"), new Uint8Array([7, 7, 7, 7]), { core: "fceumm", coreVersion: "4.2.3" });
    const plan = await planImport(tight, bundle);
    expect(plan.conflicts).toBe(1);
    const result = await applyImport(tight, plan, "replace");
    expect(result.ok).toBe(true);
    expect([...(await tight.get(stateKey(source.sha, "1")))!.bytes]).toEqual([1, 2, 3, 4]);
  });

  it("a game removed in another tab after the plan comes back to the shelf with its row", async () => {
    const { source, bundle } = await bundleOf(true);
    const target = memoryStore();
    await applyImport(target, await planImport(target, bundle));
    const plan = await planImport(target, bundle);
    expect(plan.games[0]!.isNew).toBe(false);
    // the person removes the game in another tab before this import is applied
    await target.delete(metaKey(source.sha));
    await target.delete(romKey(source.sha));
    const result = await applyImport(target, plan);
    expect(result.ok).toBe(true);
    expect(await target.get(metaKey(source.sha))).not.toBeNull();
    // and whole: the game file the bundle carried comes back with it, so the box can play
    expect([...(await target.get(romKey(source.sha)))!.bytes]).toEqual([...source.bytes]);
  });

  it("a save that appears after the plan is a collision too, kept by default", async () => {
    const { source, bundle } = await bundleOf(false);
    const target = memoryStore();
    const plan = await planImport(target, bundle);
    // the game, still running in another tab, saved slot 1 after the plan was read
    await target.put(stateKey(source.sha, "1"), new Uint8Array([42]), { core: "fceumm", coreVersion: "4.2.3" });
    await target.put(thumbKey(source.sha, "1"), new Uint8Array([1]), { savedAt: 9_000 });
    const result = await applyImport(target, plan, "keep");
    expect(result.ok).toBe(true);
    expect([...(await target.get(stateKey(source.sha, "1")))!.bytes]).toEqual([42]);
    expect([...(await target.get(thumbKey(source.sha, "1")))!.bytes]).toEqual([1]);
  });
});

describe("reading a bundle", () => {
  it("refuses bytes that are not a zip", () => {
    expect(readBundle(strToU8("isto nao e um zip"))).toEqual({ ok: false, reason: "not-zip" });
  });

  it("refuses a zip with no manifest", () => {
    const zip = zipSync({ "outra.txt": strToU8("oi") });
    expect(readBundle(zip)).toEqual({ ok: false, reason: "bad-manifest" });
  });

  it("refuses a malformed manifest: wrong format, bad sha, bad slot name, a file it names but lacks", async () => {
    const sha = await sha256Hex(fakeNes(7));
    const meta = { sha256: sha, platform: "nes", ext: ".nes", bytes: 1040, headerTitle: "", userTitle: "", addedAt: 1, lastPlayedAt: 0, playSeconds: 0, artSeed: 3 };
    const bundle = (manifest: unknown, extra: Record<string, Uint8Array> = {}) =>
      zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), ...extra });

    const wrongFormat = bundle({ format: "outro", version: 1, createdAt: 1, items: [] });
    expect(readBundle(wrongFormat)).toEqual({ ok: false, reason: "bad-manifest" });

    const wrongVersion = bundle({ format: "locadora-bundle", version: 9, createdAt: 1, items: [] });
    expect(readBundle(wrongVersion)).toEqual({ ok: false, reason: "bad-manifest" });

    const badSha = bundle({ format: "locadora-bundle", version: 1, createdAt: 1, items: [{ meta: { ...meta, sha256: "xyz" }, rom: false, sram: null, slots: [] }] });
    expect(readBundle(badSha)).toEqual({ ok: false, reason: "bad-manifest" });

    const badSlot = bundle({
      format: "locadora-bundle",
      version: 1,
      createdAt: 1,
      items: [{ meta, rom: false, sram: null, slots: [{ slot: "../../etc", meta: {}, thumb: null }] }],
    });
    expect(readBundle(badSlot)).toEqual({ ok: false, reason: "bad-manifest" });

    const missingFile = bundle({
      format: "locadora-bundle",
      version: 1,
      createdAt: 1,
      items: [{ meta, rom: true, sram: null, slots: [] }],
    });
    expect(readBundle(missingFile)).toEqual({ ok: false, reason: "bad-manifest" });

    const notJson = zipSync({ "manifest.json": strToU8("{ isto nao fecha") });
    expect(readBundle(notJson)).toEqual({ ok: false, reason: "bad-manifest" });
  });

  it("refuses a bundle over 64 MB, by the file's size", () => {
    expect(BUNDLE_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(readBundle(new Uint8Array(BUNDLE_MAX_BYTES + 1))).toEqual({ ok: false, reason: "too-large" });
  });

  it("refuses a small file that unpacks past 64 MB", () => {
    // a run of zeros compresses to almost nothing, so the size of the file says nothing about what it holds
    const zip = zipSync({ "manifest.json": strToU8("{}"), "enche.bin": new Uint8Array(BUNDLE_MAX_BYTES + 1024) });
    expect(zip.length).toBeLessThan(BUNDLE_MAX_BYTES);
    expect(readBundle(zip)).toEqual({ ok: false, reason: "too-large" });
  });
});
