/**
 * "Exportar pra arquivo" (SPEC 11, the safe default): one `.locadora` file, a zip
 * the person moves with whatever they already use. It holds the shelf's saves,
 * slots and pictures, and the game file only when the person chose "Fita e
 * saves". Nothing leaves the device: `exportBundle` returns bytes and the caller
 * saves them through the host's `files.saveLocal`; `readBundle` takes bytes the
 * picker gave us.
 *
 * Layout of the zip:
 *   manifest.json                 the index (format, version, every item and its files)
 *   items/<sha>/rom.bin           the game file, only when it was ticked
 *   items/<sha>/sram.bin          the battery save
 *   items/<sha>/state-<slot>.bin  a save state, `auto` or `1` to `4`
 *   items/<sha>/thumb-<slot>.png  its picture
 *
 * Import merges by sha and slot. A save that is already on the device with
 * different bytes is a collision: `planImport` says which, and `applyImport` takes
 * the person's choice (keep what is here, the default, or take the file's). Store
 * keys are the same ones library.ts and saves.ts write (SPEC 9), so an imported
 * game is indistinguishable from one added on this device.
 *
 * Logic only, no DOM: the dialog is `ui/export-dialog.ts`.
 */
import { unzipSync, Zip, ZipDeflate } from "fflate";
import {
  loadLibrary,
  metaKey,
  parseStoredItem,
  romKey,
  sha256Hex,
  sramKey,
  stateKey,
  thumbKey,
  type StoredItem,
} from "./library";
import { LIST_MAX, META_MAX_BYTES, type DeviceStore, type StoreMeta } from "./store";

export const BUNDLE_FORMAT = "locadora-bundle";
export const BUNDLE_VERSION = 1;
/** With its dot: that is how `files.saveLocal` and the picker's `accept` list say it. */
export const BUNDLE_EXT = ".locadora";
/** 64 MB, the most a bundle may be, zipped or unpacked. */
export const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;

/** The value library.ts writes under `meta:<sha>`. */
const MARKER = new Uint8Array([1]);
const SLOT_NAMES = ["auto", "1", "2", "3", "4"] as const;
const SHA_PATTERN = /^[0-9a-f]{64}$/;

/* ---- export ---- */

export type ExportResult =
  | { ok: true; bytes: Uint8Array; games: number; saves: number; withRom: boolean }
  | { ok: false; reason: "empty" | "too-large" };

interface ManifestSlot {
  slot: string;
  meta: StoreMeta;
  /** The picture's meta when the slot has one, else null. */
  thumb: StoreMeta | null;
}

interface ManifestItem {
  meta: StoredItem;
  rom: boolean;
  sram: StoreMeta | null;
  slots: ManifestSlot[];
}

interface Manifest {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  createdAt: number;
  items: ManifestItem[];
}

/**
 * A zip written one file at a time, that gives up as soon as what it wrote passes the cap: an export
 * that cannot fit stops at the file that tipped it over, without first reading and packing the whole
 * shelf. Each file is read just before it is packed, so the page holds the packed output and one file.
 */
function boundedZip(cap: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let failed = false;
  const zip = new Zip((error, chunk) => {
    if (error) {
      failed = true;
      return;
    }
    chunks.push(chunk);
    size += chunk.length;
  });
  return {
    /** False once the archive is over the cap (or broke): stop adding. */
    add(name: string, bytes: Uint8Array): boolean {
      if (failed || size > cap) return false;
      const file = new ZipDeflate(name, { level: 6 });
      zip.add(file);
      file.push(bytes, true);
      return !failed && size <= cap;
    },
    finish(): Uint8Array | null {
      if (failed || size > cap) {
        zip.terminate();
        return null;
      }
      zip.end();
      if (failed || size > cap) return null;
      const out = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    },
    abort(): void {
      zip.terminate();
    },
  };
}

/** Every game on the shelf with its saves; the game file only when `withRom`. */
export async function exportBundle(
  store: DeviceStore,
  options: { withRom: boolean; now?: number },
): Promise<ExportResult> {
  const library = await loadLibrary(store);
  if (library.length === 0) return { ok: false, reason: "empty" };

  const zip = boundedZip(BUNDLE_MAX_BYTES);
  const tooLarge = (): ExportResult => {
    zip.abort();
    return { ok: false, reason: "too-large" };
  };
  const items: ManifestItem[] = [];
  let saves = 0;

  for (const item of library) {
    const { hasSram: _sram, slots: _slots, ...meta } = item;
    const dir = `items/${item.sha256}`;
    const entry: ManifestItem = { meta, rom: false, sram: null, slots: [] };

    if (options.withRom) {
      const rom = await store.get(romKey(item.sha256));
      if (rom) {
        if (!zip.add(`${dir}/rom.bin`, rom.bytes)) return tooLarge();
        entry.rom = true;
      }
    }

    const sram = await store.get(sramKey(item.sha256));
    if (sram) {
      if (!zip.add(`${dir}/sram.bin`, sram.bytes)) return tooLarge();
      entry.sram = sram.meta ?? {};
      saves += 1;
    }

    for (const { slot } of item.slots) {
      const state = await store.get(stateKey(item.sha256, slot));
      if (!state) continue;
      if (!zip.add(`${dir}/state-${slot}.bin`, state.bytes)) return tooLarge();
      const thumb = await store.get(thumbKey(item.sha256, slot));
      if (thumb && !zip.add(`${dir}/thumb-${slot}.png`, thumb.bytes)) return tooLarge();
      entry.slots.push({ slot, meta: state.meta ?? {}, thumb: thumb ? (thumb.meta ?? {}) : null });
      saves += 1;
    }

    items.push(entry);
  }

  const manifest: Manifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt: options.now ?? Date.now(),
    items,
  };
  if (!zip.add("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)))) return tooLarge();
  const bytes = zip.finish();
  if (!bytes) return { ok: false, reason: "too-large" };
  return { ok: true, bytes, games: items.length, saves, withRom: items.some((i) => i.rom) };
}

/**
 * About how big the file would be, for the dialog's two choices: the saves (battery saves, states and their pictures,
 * as kept) and the same plus every game file. The zip is a little smaller than the sum, never larger by more than a
 * few hundred bytes of index, so a "uns" is honest. Reads the listing only, never a byte of a game.
 */
export async function estimateBundle(store: DeviceStore): Promise<{ saves: number; withRom: number; games: number }> {
  const [sram, state, thumb, rom, meta] = await Promise.all(
    ["sram:", "state:", "thumb:", "rom:", "meta:"].map((prefix) => store.list(prefix).catch(() => [])),
  );
  const sum = (rows: readonly { size: number }[]) => rows.reduce((total, row) => total + row.size, 0);
  const saves = sum(sram ?? []) + sum(state ?? []) + sum(thumb ?? []);
  return { saves, withRom: saves + sum(rom ?? []), games: (meta ?? []).length };
}

/* ---- reading ---- */

export interface BundleSlot {
  slot: string;
  meta: StoreMeta;
  bytes: Uint8Array;
  thumb: { bytes: Uint8Array; meta: StoreMeta | null } | null;
}

export interface BundleItem {
  sha256: string;
  meta: StoredItem;
  rom: Uint8Array | null;
  sram: { bytes: Uint8Array; meta: StoreMeta | null } | null;
  slots: BundleSlot[];
}

export interface ParsedBundle {
  createdAt: number;
  items: BundleItem[];
}

export type ReadResult =
  | { ok: true; bundle: ParsedBundle }
  | { ok: false; reason: "too-large" | "not-zip" | "bad-manifest" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMeta(value: unknown): value is StoreMeta {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  return new TextEncoder().encode(JSON.stringify(value)).length <= META_MAX_BYTES;
}

/** The manifest's shape, checked before a single file is trusted. Null when anything is off. */
function parseManifest(json: unknown): Manifest | null {
  if (!isRecord(json)) return null;
  if (json.format !== BUNDLE_FORMAT || json.version !== BUNDLE_VERSION) return null;
  if (typeof json.createdAt !== "number" || !Number.isFinite(json.createdAt)) return null;
  if (!Array.isArray(json.items) || json.items.length > LIST_MAX) return null;

  const seen = new Set<string>();
  for (const raw of json.items) {
    if (!isRecord(raw)) return null;
    const meta = parseStoredItem(raw.meta);
    if (!meta || !SHA_PATTERN.test(meta.sha256) || seen.has(meta.sha256)) return null;
    seen.add(meta.sha256);
    if (typeof raw.rom !== "boolean") return null;
    if (raw.sram !== null && !isMeta(raw.sram)) return null;
    if (!Array.isArray(raw.slots)) return null;
    const slots = new Set<string>();
    for (const slot of raw.slots) {
      if (!isRecord(slot) || typeof slot.slot !== "string") return null;
      if (slot.thumb !== null && !isRecord(slot.thumb)) return null;
      if (slot.thumb !== null && !isMeta(slot.thumb)) return null;
      if (!(SLOT_NAMES as readonly string[]).includes(slot.slot) || slots.has(slot.slot)) return null;
      if (!isMeta(slot.meta)) return null;
      slots.add(slot.slot);
    }
  }
  return json as unknown as Manifest;
}

/** Unpacks and checks a bundle. Nothing is written here; refusals say why. */
export function readBundle(bytes: Uint8Array): ReadResult {
  if (bytes.length > BUNDLE_MAX_BYTES) return { ok: false, reason: "too-large" };

  // count what the archive says it unpacks to, so a small file that inflates past the cap is refused too
  let unpacked = 0;
  let over = false;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        unpacked += file.originalSize;
        if (unpacked > BUNDLE_MAX_BYTES) over = true;
        return !over;
      },
    });
  } catch {
    return { ok: false, reason: over ? "too-large" : "not-zip" };
  }
  if (over) return { ok: false, reason: "too-large" };

  const raw = files["manifest.json"];
  if (!raw) return { ok: false, reason: "bad-manifest" };
  let manifest: Manifest | null;
  try {
    manifest = parseManifest(JSON.parse(new TextDecoder().decode(raw)));
  } catch {
    manifest = null;
  }
  if (!manifest) return { ok: false, reason: "bad-manifest" };

  const need = (path: string): Uint8Array | null => files[path] ?? null;
  const items: BundleItem[] = [];
  for (const entry of manifest.items) {
    const meta = parseStoredItem(entry.meta);
    if (!meta) return { ok: false, reason: "bad-manifest" };
    const sha = meta.sha256;
    const dir = `items/${sha}`;
    const rom = entry.rom ? need(`${dir}/rom.bin`) : null;
    if (entry.rom && !rom) return { ok: false, reason: "bad-manifest" };
    const sramBytes = entry.sram !== null ? need(`${dir}/sram.bin`) : null;
    if (entry.sram !== null && !sramBytes) return { ok: false, reason: "bad-manifest" };
    const slots: BundleSlot[] = [];
    for (const slot of entry.slots) {
      const state = need(`${dir}/state-${slot.slot}.bin`);
      if (!state) return { ok: false, reason: "bad-manifest" };
      const picture = slot.thumb !== null ? need(`${dir}/thumb-${slot.slot}.png`) : null;
      if (slot.thumb !== null && !picture) return { ok: false, reason: "bad-manifest" };
      slots.push({
        slot: slot.slot,
        meta: slot.meta,
        bytes: state,
        thumb: picture ? { bytes: picture, meta: slot.thumb } : null,
      });
    }
    items.push({
      sha256: sha,
      meta,
      rom,
      sram: sramBytes ? { bytes: sramBytes, meta: entry.sram } : null,
      slots,
    });
  }
  return { ok: true, bundle: { createdAt: manifest.createdAt, items } };
}

/* ---- import ---- */

export interface PlannedWrite {
  key: string;
  bytes: Uint8Array;
  meta?: StoreMeta;
  /** The device already holds different bytes under this key. */
  conflict: boolean;
  /** How many bytes the key held when the plan was made: what a replacing write gives back. */
  replaces: number;
}

export interface ImportGame {
  sha256: string;
  title: string;
  /** Not on this device yet: its item row comes with the import. */
  isNew: boolean;
  /** The file came without the cartridge and the device has none: saves wait for it. */
  missingFile: boolean;
  saves: number;
  conflicts: number;
}

export interface ImportPlan {
  games: ImportGame[];
  writes: PlannedWrite[];
  conflicts: number;
  /** Bytes the import would put on the device, collisions excluded unless replaced. */
  bytes: number;
}

export type CollisionChoice = "keep" | "replace";

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** What importing would write, and where it would collide. Reads the device, writes nothing. */
export async function planImport(store: DeviceStore, bundle: ParsedBundle): Promise<ImportPlan> {
  const games: ImportGame[] = [];
  const writes: PlannedWrite[] = [];

  for (const item of bundle.items) {
    const sha = item.sha256;
    const game: ImportGame = {
      sha256: sha,
      title: item.meta.userTitle || item.meta.headerTitle,
      isNew: (await store.get(metaKey(sha))) === null,
      missingFile: false,
      saves: 0,
      conflicts: 0,
    };
    const gameWrites: PlannedWrite[] = [];

    let hasFile = (await store.get(romKey(sha))) !== null;
    // the game file is only ever kept under the hash of its own bytes: a bundle that names one sha and carries
    // other bytes does not get to put them on the shelf (its saves still arrive and wait for the real file)
    if (item.rom && !hasFile && (await sha256Hex(item.rom)) === sha) {
      gameWrites.push({ key: romKey(sha), bytes: item.rom, conflict: false, replaces: 0 });
      hasFile = true;
    }
    game.missingFile = !hasFile;

    if (item.sram) {
      const here = await store.get(sramKey(sha));
      if (!here) {
        gameWrites.push({ key: sramKey(sha), bytes: item.sram.bytes, meta: item.sram.meta ?? undefined, conflict: false, replaces: 0 });
      } else if (!same(here.bytes, item.sram.bytes)) {
        gameWrites.push({
          key: sramKey(sha),
          bytes: item.sram.bytes,
          meta: item.sram.meta ?? undefined,
          conflict: true,
          replaces: here.bytes.length,
        });
      }
      if (!here || !same(here.bytes, item.sram.bytes)) game.saves += 1;
    }

    for (const slot of item.slots) {
      const here = await store.get(stateKey(sha, slot.slot));
      if (here && same(here.bytes, slot.bytes)) continue;
      const conflict = here !== null;
      gameWrites.push({ key: stateKey(sha, slot.slot), bytes: slot.bytes, meta: slot.meta, conflict, replaces: here?.bytes.length ?? 0 });
      if (slot.thumb) {
        const picture = conflict ? await store.get(thumbKey(sha, slot.slot)) : null;
        gameWrites.push({
          key: thumbKey(sha, slot.slot),
          bytes: slot.thumb.bytes,
          meta: slot.thumb.meta ?? undefined,
          conflict,
          replaces: picture?.bytes.length ?? 0,
        });
      }
      game.saves += 1;
    }

    // a collision is a save (the battery save or a slot), not each file that makes it up: a slot's picture follows its state
    game.conflicts = gameWrites.filter((w) => w.conflict && !w.key.startsWith("thumb:")).length;
    writes.push(...gameWrites);
    // the item row goes last, so a cut-short import never shows a half-written game
    // and it is planned for every game, not only a new one: a game removed in another tab between the plan and the
    // apply gets its row back, while `applyImport` leaves an existing row (this device's title) as it is
    writes.push({ key: metaKey(sha), bytes: MARKER, meta: { ...item.meta }, conflict: false, replaces: game.isNew ? 0 : MARKER.length });
    games.push(game);
  }

  return {
    games,
    writes,
    conflicts: games.reduce((sum, g) => sum + g.conflicts, 0),
    bytes: writes.reduce((sum, w) => sum + w.bytes.length, 0),
  };
}

export type ApplyResult =
  | { ok: true; games: number; written: number; skipped: number }
  | { ok: false; reason: "full" | "failed" };

/**
 * Writes the plan. Collisions follow `choice`; everything else is written. Refuses up front when
 * the device has no room for what it would write, so a full device is told before anything lands.
 *
 * The device is read again key by key as it is written: a save that appeared or changed since the
 * plan (another tab, the game still running) is a collision too and follows `choice`, and a game
 * file or an item row already there is never written over. A write that fails puts back what this
 * import had already written, so a failure never leaves half a game behind.
 */
export async function applyImport(
  store: DeviceStore,
  plan: ImportPlan,
  choice: CollisionChoice = "keep",
): Promise<ApplyResult> {
  const pending = plan.writes.filter((w) => !(w.conflict && choice === "keep"));
  // what the device has to find room for: a write over a key gives that key's bytes back
  const need = pending.reduce((sum, w) => sum + Math.max(0, w.bytes.length - w.replaces), 0);
  try {
    const usage = await store.usage();
    if (usage.used + need > usage.cap) return { ok: false, reason: "full" };
  } catch {
    return { ok: false, reason: "failed" };
  }

  const done: WrittenKey[] = [];
  let written = 0;
  let skipped = plan.writes.length - pending.length;
  // a slot's picture follows its state: a state left as it was keeps its own picture too
  const keptStates = new Set<string>();
  for (const write of pending) {
    try {
      if (write.key.startsWith("thumb:") && keptStates.has(`state:${write.key.slice("thumb:".length)}`)) {
        skipped += 1;
        continue;
      }
      const here = await store.get(write.key);
      if (here) {
        const isRow = write.key.startsWith("rom:") || write.key.startsWith("meta:");
        if (isRow || same(here.bytes, write.bytes) || (!write.conflict && choice === "keep")) {
          if (write.key.startsWith("state:")) keptStates.add(write.key);
          skipped += 1;
          continue;
        }
      }
      await store.put(write.key, write.bytes, write.meta);
      done.push({ key: write.key, before: here ? { bytes: here.bytes, meta: here.meta ?? null } : null });
    } catch {
      await rollBack(store, done);
      return { ok: false, reason: "failed" };
    }
    written += 1;
  }
  return { ok: true, games: plan.games.length, written, skipped };
}

interface WrittenKey {
  key: string;
  before: { bytes: Uint8Array; meta: StoreMeta | null } | null;
}

/** Best effort, newest first: what was there goes back, what was not goes away. */
async function rollBack(store: DeviceStore, done: readonly WrittenKey[]): Promise<void> {
  for (const { key, before } of [...done].reverse()) {
    try {
      if (before) await store.put(key, before.bytes, before.meta ?? undefined);
      else await store.delete(key);
    } catch {
      // the store is failing; stop trying for this key and go on with the others
    }
  }
}
