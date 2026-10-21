/**
 * The shelf's data (SPEC 4.1, 4.8): what a person has put on it, kept on their own
 * device through the `DeviceStore` and nowhere else.
 *
 * One cartridge is a few rows of the store, all keyed by the SHA-256 of the file:
 *   rom:<sha>            the bytes the person picked
 *   meta:<sha>           the item (JSON in `meta`, a one byte marker as bytes)
 *   sram:<sha>           the game's own battery save   (written by saves.ts)
 *   state:<sha>:<slot>   a save state                  (written by saves.ts)
 *   thumb:<sha>:<slot>   its picture                   (written by saves.ts)
 *   art:<sha>            reserved: box art is drawn from the title, never stored
 *
 * The item holds only what this module owns. Whether a game has a battery save and
 * which slots are filled is read from the keys, on every load, so it cannot go
 * stale when saves.ts writes or the person deletes a slot. Nothing here names a
 * game: the only titles are the ones read from the person's own file header or
 * typed by them, and they never leave the device.
 *
 * Logic only, no DOM: the shelf, the boxes and the Ficha are `ui/`.
 */
import { hashString } from "./boxart";
import type { Platform as ConsoleGroup } from "./keymap";
import { readRomHeader, type RomPlatform } from "./rom-header";
import type { DeviceStore, StoreListing, StoreMeta, StoreUsage } from "./store";

/* ---- keys ---- */

export const romKey = (sha: string) => `rom:${sha}`;
export const metaKey = (sha: string) => `meta:${sha}`;
export const sramKey = (sha: string) => `sram:${sha}`;
export const stateKey = (sha: string, slot: string | number) => `state:${sha}:${slot}`;
export const thumbKey = (sha: string, slot: string | number) => `thumb:${sha}:${slot}`;
export const artKey = (sha: string) => `art:${sha}`;
export const STATE_PREFIX = "state:";
export const SRAM_PREFIX = "sram:";
export const META_PREFIX = "meta:";
export const ROM_PREFIX = "rom:";

/** The slot id saves.ts gives the rolling autosave; every other slot id is a number the person picked. */
export const AUTOSAVE_SLOT = "auto";

/* ---- the item ---- */

export interface SaveSlot {
  /** `"1"`..`"4"`, or `AUTOSAVE_SLOT`. */
  slot: string;
  /** When it was written (the store's `updatedAt`). */
  at: number;
}

/** What is persisted in `meta:<sha>`. Small on purpose: the host caps `meta` at 2 KB. */
export interface StoredItem {
  sha256: string;
  platform: RomPlatform;
  ext: string;
  bytes: number;
  /** Read from the file's own header; empty when the platform has none (NES). */
  headerTitle: string;
  /** What the person typed; empty means "use the header's". */
  userTitle: string;
  addedAt: number;
  /** 0 until it is played. */
  lastPlayedAt: number;
  playSeconds: number;
  /** A number derived from the hash, reserved for art that wants variety beyond the title. */
  artSeed: number;
}

export interface LibraryItem extends StoredItem {
  /** Derived from `sram:<sha>` on every load. */
  hasSram: boolean;
  /** Derived from `state:<sha>:*` on every load, in slot order. */
  slots: SaveSlot[];
  /**
   * Derived from `rom:<sha>` on every load. False for a box that came in a `.locadora` bundle
   * without "Levar a fita junto": the saves are here, the game file is not (see `attachFile`).
   */
  hasFile: boolean;
}

export const SHA_PATTERN = /^[0-9a-f]{64}$/;
export const MAX_USER_TITLE = 48;

const PLATFORMS: readonly RomPlatform[] = ["nes", "snes", "gb", "gbc", "gba"];

/** A file's system from the extension the host's picker reported; null when Locadora cannot run it. */
export function platformForExt(ext: string): RomPlatform | null {
  const clean = ext.trim().toLowerCase();
  const dotted = clean.startsWith(".") ? clean : `.${clean}`;
  switch (dotted) {
    case ".nes":
      return "nes";
    case ".sfc":
    case ".smc":
      return "snes";
    case ".gb":
      return "gb";
    case ".gbc":
      return "gbc";
    case ".gba":
      return "gba";
    default:
      return null;
  }
}

/** Proper names, not translated. */
export const CONSOLE_NAMES: Readonly<Record<RomPlatform, string>> = {
  nes: "NES",
  snes: "SNES",
  gb: "Game Boy",
  gbc: "Game Boy Color",
  gba: "Game Boy Advance",
};

/** The filter chips group Game Boy and Game Boy Color. */
export function consoleGroup(platform: RomPlatform): ConsoleGroup {
  return platform === "gbc" ? "gb" : platform;
}

export const CONSOLE_GROUP_NAMES: Readonly<Record<ConsoleGroup, string>> = {
  nes: "NES",
  snes: "SNES",
  gb: "Game Boy",
  gba: "GBA",
};

const GROUP_ORDER: readonly ConsoleGroup[] = ["nes", "snes", "gb", "gba"];

/** What the person sees as the cartridge's name: theirs, else the header's, else the console's. */
export function displayTitle(item: Pick<StoredItem, "userTitle" | "headerTitle" | "platform">): string {
  return item.userTitle || item.headerTitle || CONSOLE_NAMES[item.platform];
}

/** Control characters out, whitespace collapsed, trimmed, at most 48 characters. Empty clears the name. */
export function sanitiseUserTitle(raw: string): string {
  const cleaned = raw.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  return [...cleaned].slice(0, MAX_USER_TITLE).join("").trim();
}

/** Saves the person made themselves (numbered slots), which is what the sticker counts. */
export function manualSlots(item: Pick<LibraryItem, "slots">): SaveSlot[] {
  return item.slots.filter((s) => /^\d+$/.test(s.slot));
}

/** When the rolling autosave was written, or null. */
export function autosaveAt(item: Pick<LibraryItem, "slots">): number | null {
  return item.slots.find((s) => s.slot === AUTOSAVE_SLOT)?.at ?? null;
}

/* ---- numbers for the screen ---- */

export function formatBytes(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
  if (v < 1024 * 1024 * 1024) return `${Math.round(v / (1024 * 1024))} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Under this long ago, a time is "just now": "salvo sozinho há 1 min" seconds after the save reads wrong. */
export const JUST_NOW_MS = 60_000;

/** Whether `at` is recent enough that the copy says "agora há pouco" instead of a number of minutes. */
export function isJustNow(at: number, now: number): boolean {
  return now - at < JUST_NOW_MS;
}

/**
 * "salvo sozinho há 3 min" or, under a minute, the template that says "agora há pouco"
 * (each language words that on its own, so it is a second template and not a number).
 */
export function agoLine(template: string, justNowTemplate: string, at: number, now: number): string {
  return isJustNow(at, now) ? justNowTemplate : template.split("{ago}").join(formatAgo(at, now));
}

/** "1 min", "2 h", "3 d": units that read the same in pt-BR, en and es, so the copy slots them in unchanged. */
export function formatAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

/** "42 min", "1 h 20 min", "3 h". */
export function formatPlaytime(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export type UsageLevel = "ok" | "full";

/** Over 90% of the app's cap turns the meter to a warning (SPEC 4.1). */
export function usageLevel(usage: Pick<StoreUsage, "used" | "cap"> | undefined): UsageLevel {
  if (!usage || usage.cap <= 0) return "ok";
  return usage.used / usage.cap > 0.9 ? "full" : "ok";
}

/* ---- hashing ---- */

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}

/* ---- reading ---- */

const MARKER = new Uint8Array([1]);

function isCount(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

/** A store row's meta back into an item, or null when it is not one. The store is the person's, but not trusted. */
export function parseStoredItem(meta: unknown): StoredItem | null {
  if (typeof meta !== "object" || meta === null) return null;
  const m = meta as Record<string, unknown>;
  const { sha256, platform, ext, bytes, headerTitle, userTitle, addedAt, lastPlayedAt, playSeconds, artSeed } = m;
  if (typeof sha256 !== "string" || !SHA_PATTERN.test(sha256)) return null;
  if (typeof platform !== "string" || !(PLATFORMS as readonly string[]).includes(platform)) return null;
  if (typeof ext !== "string" || !isCount(bytes) || !isCount(addedAt)) return null;
  return {
    sha256,
    platform: platform as RomPlatform,
    ext,
    bytes,
    headerTitle: typeof headerTitle === "string" ? headerTitle : "",
    userTitle: typeof userTitle === "string" ? sanitiseUserTitle(userTitle) : "",
    addedAt,
    lastPlayedAt: isCount(lastPlayedAt) ? lastPlayedAt : 0,
    playSeconds: isCount(playSeconds) ? playSeconds : 0,
    artSeed: isCount(artSeed) ? artSeed : hashString(sha256),
  };
}

function toMeta(item: StoredItem): StoreMeta {
  return { ...item };
}

function stored(item: LibraryItem | StoredItem): StoredItem {
  return {
    sha256: item.sha256,
    platform: item.platform,
    ext: item.ext,
    bytes: item.bytes,
    headerTitle: item.headerTitle,
    userTitle: item.userTitle,
    addedAt: item.addedAt,
    lastPlayedAt: item.lastPlayedAt,
    playSeconds: item.playSeconds,
    artSeed: item.artSeed,
  };
}

/** Slots and the battery save for the given games, from two list calls rather than two per game. */
function savesFrom(sramRows: StoreListing[], stateRows: StoreListing[]) {
  const sram = new Set<string>();
  for (const row of sramRows) sram.add(row.key.slice(SRAM_PREFIX.length));
  const slots = new Map<string, SaveSlot[]>();
  for (const row of stateRows) {
    const rest = row.key.slice(STATE_PREFIX.length);
    const cut = rest.indexOf(":");
    if (cut <= 0) continue;
    const sha = rest.slice(0, cut);
    const slot = rest.slice(cut + 1);
    if (!slot) continue;
    const list = slots.get(sha) ?? [];
    list.push({ slot, at: row.updatedAt });
    slots.set(sha, list);
  }
  for (const list of slots.values()) list.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  return { sram, slots };
}

/** Every cartridge on the shelf, unsorted. Rows that are not valid items are skipped, never thrown on. */
export async function loadLibrary(store: DeviceStore): Promise<LibraryItem[]> {
  const [metaRows, sramRows, stateRows, romRows] = await Promise.all([
    store.list(META_PREFIX),
    store.list(SRAM_PREFIX),
    store.list(STATE_PREFIX),
    store.list(ROM_PREFIX),
  ]);
  const { sram, slots } = savesFrom(sramRows, stateRows);
  const files = new Set(romRows.map((row) => row.key.slice(ROM_PREFIX.length)));
  const items: LibraryItem[] = [];
  for (const row of metaRows) {
    const base = parseStoredItem(row.meta);
    if (!base || row.key !== metaKey(base.sha256)) continue;
    items.push({ ...base, hasSram: sram.has(base.sha256), slots: slots.get(base.sha256) ?? [], hasFile: files.has(base.sha256) });
  }
  return items;
}

export async function getItem(store: DeviceStore, sha: string): Promise<LibraryItem | null> {
  if (!SHA_PATTERN.test(sha)) return null;
  const row = await store.get(metaKey(sha));
  const base = row ? parseStoredItem(row.meta) : null;
  if (!base || base.sha256 !== sha) return null;
  const [sramRows, stateRows, romRows] = await Promise.all([
    store.list(sramKey(sha)),
    store.list(`${STATE_PREFIX}${sha}:`),
    store.list(romKey(sha)),
  ]);
  const { sram, slots } = savesFrom(sramRows, stateRows);
  return { ...base, hasSram: sram.has(sha), slots: slots.get(sha) ?? [], hasFile: romRows.some((row) => row.key === romKey(sha)) };
}

/* ---- adding ---- */

/** "Fita sem nome N" with the smallest N not already the name of something on the shelf. */
export function nextUntitledTitle(items: readonly Pick<StoredItem, "userTitle" | "headerTitle" | "platform">[], template: string): string {
  const taken = new Set(items.map((i) => displayTitle(i).toLowerCase()));
  for (let n = 1; ; n++) {
    const candidate = template.split("{n}").join(String(n));
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export interface AddInput {
  bytes: Uint8Array;
  /** The extension the host's picker reported, with its dot. */
  ext: string;
  now?: number;
  /** The name to give a cartridge whose file has none, already worded in the person's language. */
  fallbackTitle?: string;
}

export interface AddResult {
  item: LibraryItem;
  /** False when the same file was already on the shelf. */
  isNew: boolean;
  /** False when the device refused to keep it (full, no storage): it still plays, it just is not on the shelf. */
  stored: boolean;
  /** NES files carry no title: ask once, with `item.userTitle` as the suggestion. Skipping keeps it. Never when it was not stored. */
  askName: boolean;
}

/**
 * The step after a pick (SPEC 4.3): hash the bytes, find the cartridge on the shelf or put it there.
 * Null when the extension is not one Locadora runs. A refusing or full store is not an error: the
 * result says `stored: false` and the game plays anyway.
 */
export async function addToLibrary(store: DeviceStore, input: AddInput): Promise<AddResult | null> {
  const platform = platformForExt(input.ext);
  if (platform === null) return null;
  const now = input.now ?? Date.now();
  const sha = await sha256Hex(input.bytes);

  try {
    const known = await getItem(store, sha);
    if (known) {
      // the row survived but the bytes did not (an interrupted write): put them back
      if ((await store.list(romKey(sha))).length === 0) await store.put(romKey(sha), input.bytes);
      return { item: known, isNew: false, stored: true, askName: false };
    }
  } catch {
    // an unreadable store is treated as an empty one; the put below says whether it can keep anything
  }

  const headerTitle = readRomHeader(input.bytes, platform)?.title ?? "";
  const item: LibraryItem = {
    sha256: sha,
    platform,
    ext: platformExt(input.ext),
    bytes: input.bytes.length,
    headerTitle,
    userTitle: headerTitle ? "" : sanitiseUserTitle(input.fallbackTitle ?? ""),
    addedAt: now,
    lastPlayedAt: 0,
    playSeconds: 0,
    artSeed: hashString(sha),
    hasSram: false,
    slots: [],
    hasFile: true,
  };
  const askName = platform === "nes" && !headerTitle;

  try {
    await store.put(romKey(sha), input.bytes);
    try {
      await store.put(metaKey(sha), MARKER, toMeta(stored(item)));
    } catch (error) {
      await store.delete(romKey(sha)).catch(() => undefined);
      throw error;
    }
  } catch {
    // not on the shelf, so there is nothing a name could be kept on: the question is never asked
    return { item, isNew: true, stored: false, askName: false };
  }
  return { item, isNew: true, stored: true, askName };
}

export type AttachResult = { ok: true; stored: boolean } | { ok: false; reason: "mismatch" };

/**
 * "Falta a fita": a box that came in a bundle with no game file gets one. Only the very same
 * file fits: its hash must be the box's own `sha256`, which is also how every save for it is
 * keyed. `stored: false` means the match was right but the device would not keep the bytes
 * (full); the caller can still play it from memory.
 */
export async function attachFile(store: DeviceStore, item: Pick<StoredItem, "sha256">, bytes: Uint8Array): Promise<AttachResult> {
  if ((await sha256Hex(bytes)) !== item.sha256) return { ok: false, reason: "mismatch" };
  try {
    await store.put(romKey(item.sha256), bytes);
  } catch {
    return { ok: true, stored: false };
  }
  return { ok: true, stored: true };
}

function platformExt(ext: string): string {
  const clean = ext.trim().toLowerCase();
  return clean.startsWith(".") ? clean : `.${clean}`;
}

/* ---- changing ---- */

async function patchItem(store: DeviceStore, sha: string, patch: (base: StoredItem) => StoredItem): Promise<LibraryItem | null> {
  const current = await getItem(store, sha);
  if (!current) return null;
  const next = patch(stored(current));
  await store.put(metaKey(sha), MARKER, toMeta(next));
  return { ...next, hasSram: current.hasSram, slots: current.slots, hasFile: current.hasFile };
}

/** Rename. An empty (or all blank) title goes back to the header's. Null when the item is gone. */
export function renameItem(store: DeviceStore, sha: string, title: string): Promise<LibraryItem | null> {
  const userTitle = sanitiseUserTitle(title);
  return patchItem(store, sha, (base) => ({ ...base, userTitle }));
}

/** The game was played now, for `seconds` more seconds (0 when it only started). */
export function markPlayed(store: DeviceStore, sha: string, now: number = Date.now(), seconds = 0): Promise<LibraryItem | null> {
  const add = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  return patchItem(store, sha, (base) => ({ ...base, lastPlayedAt: now, playSeconds: base.playSeconds + add }));
}

/**
 * "Tirar da prateleira": the cartridge and everything that was saved for it, from this device.
 * Returns the keys deleted. Other games' rows are never touched: every prefix ends where the hash does.
 */
export async function removeItem(store: DeviceStore, sha: string): Promise<string[]> {
  if (!SHA_PATTERN.test(sha)) return [];
  const prefixes = [`${STATE_PREFIX}${sha}:`, `thumb:${sha}:`];
  // `sync:<sha>` is what this device last agreed with the account (Saves na conta); the account keeps its copy
  const keys = new Set<string>([romKey(sha), metaKey(sha), sramKey(sha), artKey(sha), `sync:${sha}`]);
  for (const prefix of prefixes) {
    for (const row of await store.list(prefix)) keys.add(row.key);
  }
  // meta last: if this is cut short the item is still on the shelf and can be removed again
  const ordered = [...keys].sort((a, b) => Number(a === metaKey(sha)) - Number(b === metaKey(sha)));
  const removed: string[] = [];
  for (const key of ordered) {
    await store.delete(key);
    removed.push(key);
  }
  return removed;
}

/* ---- views of the list ---- */

export type ShelfFilter = "all" | ConsoleGroup;
export type ShelfSort = "recent" | "name" | "console";

const collate = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

export function sortItems<T extends StoredItem>(items: readonly T[], sort: ShelfSort): T[] {
  const byName = (a: T, b: T) => collate(displayTitle(a), displayTitle(b)) || (a.sha256 < b.sha256 ? -1 : 1);
  const copy = [...items];
  switch (sort) {
    case "name":
      return copy.sort(byName);
    case "console":
      return copy.sort(
        (a, b) => GROUP_ORDER.indexOf(consoleGroup(a.platform)) - GROUP_ORDER.indexOf(consoleGroup(b.platform)) || byName(a, b),
      );
    case "recent":
      return copy.sort((a, b) => (b.lastPlayedAt || b.addedAt) - (a.lastPlayedAt || a.addedAt) || byName(a, b));
  }
}

export function filterItems<T extends StoredItem>(items: readonly T[], filter: ShelfFilter): T[] {
  return filter === "all" ? [...items] : items.filter((i) => consoleGroup(i.platform) === filter);
}

/** How many items each console group holds, groups with none left out, in shelf order. */
export function groupCounts(items: readonly StoredItem[]): Array<{ group: ConsoleGroup; count: number }> {
  return GROUP_ORDER.map((group) => ({ group, count: items.filter((i) => consoleGroup(i.platform) === group).length })).filter(
    (g) => g.count > 0,
  );
}

/**
 * The cartridge to offer on the Continuar card: the one played last, and none if nothing was ever played. A box with
 * no game file ("falta a fita", it came in a bundle) is never the one: Continuar would have nothing to run, so it
 * waits on the shelf until the file is attached.
 */
export function pickContinue<T extends StoredItem & { hasFile?: boolean }>(items: readonly T[]): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (item.hasFile === false) continue;
    if (item.lastPlayedAt > 0 && (best === null || item.lastPlayedAt > best.lastPlayedAt)) best = item;
  }
  return best;
}
