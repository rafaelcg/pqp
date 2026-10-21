/**
 * Saves (SPEC 4.5, 9): the game's own battery save and the machine-state slots,
 * kept in the device store and nowhere else.
 *
 * Two different things, on purpose:
 *  - SRAM is what the cartridge itself writes (a battery save). It is persisted
 *    every 30 s when it changed, when the page goes hidden, on Ejetar and when
 *    the session ends. Nobody asks for it, nothing says so but the drawer's line.
 *  - Slots are the whole machine, a rolling autosave plus four a person fills by
 *    hand. Each is a gzipped state, a 160 px PNG thumbnail and a small meta record
 *    `{core, coreVersion, savedAt, origin}`, because a state from another build of
 *    the core may not open.
 *
 * It talks to the console through `EmulatorRuntime` (so tests use a fake) and to
 * the disk through `DeviceStore` (`memoryStore()` in tests). It draws nothing and
 * shows no toast: it emits events, and the wire-up (L8) turns them into toasts.
 *
 * Store keys (SPEC 9): `sram:<sha>`, `state:<sha>:<slot>`, `thumb:<sha>:<slot>`,
 * with slot `auto` or `1` to `4`.
 */
import type { StateInfo } from "./emulator";
import type { EmulatorRuntime } from "./runtime";
import { StoreError, type DeviceStore, type StoreEntry, type StoreMeta } from "./store";

export type ManualSlot = 1 | 2 | 3 | 4;
export type SlotId = "auto" | ManualSlot;

export const MANUAL_SLOTS: readonly ManualSlot[] = [1, 2, 3, 4];
export const SLOT_IDS: readonly SlotId[] = ["auto", 1, 2, 3, 4];

export const SRAM_INTERVAL_MS = 30_000;
export const AUTOSAVE_INTERVAL_MS = 120_000;
export const UNDO_WINDOW_MS = 10_000;
export const THUMB_WIDTH = 160;
/** Ejetar writes the autosave only for a game that was really played: a title screen must not replace a good one. */
export const EJECT_AUTOSAVE_MIN_PLAY_MS = 10_000;

export const sramKey = (sha: string) => `sram:${sha}`;
export const stateKey = (sha: string, slot: SlotId) => `state:${sha}:${slot}`;
export const thumbKey = (sha: string, slot: SlotId) => `thumb:${sha}:${slot}`;

/** Where a slot was saved: here, or (copied from the account by Saves na conta) on which kind of device. */
export type SlotOrigin = "device" | "phone" | "computer" | "tablet";
type Encoding = "gzip" | "raw";

/** What a drawer row needs to know about one slot. */
export interface SlotInfo {
  slot: SlotId;
  empty: boolean;
  savedAt: number | null;
  /** Bytes on disk (state plus thumbnail). */
  size: number;
  origin: SlotOrigin;
  core: string | null;
  coreVersion: string | null;
  /** False when the state was made by another core or core version, null when empty or the running console is unknown. */
  sameConsole: boolean | null;
  /** The PNG, or null when there is none. */
  thumb: Uint8Array | null;
}

export type SramReason = "interval" | "hidden" | "eject" | "end";

export type SavesEvent =
  /** A manual save landed. `overwrote` says whether it replaced something, and `undoUntil` is when Desfazer stops working. */
  | { type: "slot-saved"; slot: ManualSlot; overwrote: boolean; undoUntil: number }
  | { type: "autosaved"; reason: "timer" | "eject" }
  | { type: "slot-loaded"; slot: SlotId }
  | { type: "slot-deleted"; slot: SlotId; undoUntil: number }
  | { type: "slot-selected"; slot: ManualSlot }
  /** The slot was put back the way it was before the last save or delete. */
  | { type: "undone"; slot: SlotId }
  | { type: "undo-expired" }
  /** A load was refused because the state is from another console build; `loadSlot(slot, {force: true})` tries anyway. */
  | { type: "old-core"; slot: SlotId; saved: StateInfo; current: StateInfo | null }
  | { type: "sram-saved"; reason: SramReason; bytes: number }
  | { type: "autosave-switched"; on: boolean }
  /** The disk is full: the person has to remove something. */
  | { type: "storage-full" }
  | { type: "error"; where: "sram" | "save" | "load" | "delete" | "undo" | "restore"; error: unknown };

export type SaveResult =
  | { ok: true; slot: SlotId }
  | { ok: false; reason: "not-started" | "too-large" | "failed" | "not-shelved" };

export type LoadResult =
  | { ok: true; slot: SlotId }
  | { ok: false; reason: "not-started" | "empty" | "failed" }
  | { ok: false; reason: "other-console"; saved: StateInfo; current: StateInfo | null };

/** What `EmulatorRuntime` gives us, plus the two methods `EjsRuntime` adds for stamping states. */
export type SavesRuntime = Pick<
  EmulatorRuntime,
  "getState" | "loadState" | "screenshot" | "readSram" | "writeSram"
> & {
  getStateRecord?(): Promise<StateInfo & { data: Uint8Array }>;
  stateInfo?(): StateInfo;
};

export interface SavesOptions {
  store: DeviceStore;
  runtime: SavesRuntime;
  /** The cartridge's hash, the key everything of this game hangs from. */
  sha: string;
  /** Rolling autosave on (default) or off. The persisted preference is the caller's; this is the live switch. */
  autosave?: boolean;
  /** Where a new state says it came from; the account sync (flagged) writes `phone` for what it copies in. */
  origin?: SlotOrigin;
  /** The PNG for a slot from the frame, at most 160 px wide, or null. The browser one is `thumbnailPng`. */
  thumbnail?: (frame: Blob) => Promise<Uint8Array | null>;
  /** Defaults to the real document's `visibilitychange` and `pagehide`; false in a test that drives `flush` by hand. */
  watchVisibility?: boolean;
  /**
   * Write nothing for a cartridge that is not on the shelf (`meta:<sha>` is missing: the device was full when it was
   * put in). A save for it would be an orphan nobody can ever load, and "Salvo" would be a lie. Off by default, so the
   * module still works on a bare store; the game session turns it on.
   */
  requireShelf?: boolean;
}

export interface Saves {
  /** The game is on screen: timers start. */
  start(): void;
  /** The HUD's pause: the autosave clock stops with the game and resumes where it left off. */
  setPaused(paused: boolean): void;
  /** Before the console boots: writes the stored battery save into it. True when there was one. */
  restoreSram(): Promise<boolean>;
  /** Persists the battery save now if it changed. True when it wrote. */
  flushSram(reason: SramReason): Promise<boolean>;
  readonly sramSavedAt: number | null;
  /** The game has a battery save of its own: one was restored or written. False for a cartridge that never wrote one. */
  readonly hasBattery: boolean;

  readonly currentSlot: ManualSlot;
  selectSlot(slot: ManualSlot): void;
  /** F3 and Shift+F3: wraps around 1 to 4. */
  cycleSlot(delta: 1 | -1): ManualSlot;
  saveSlot(slot: SlotId): Promise<SaveResult>;
  loadSlot(slot: SlotId, options?: { force?: boolean }): Promise<LoadResult>;
  /** F2 and F4: the selected slot. */
  quickSave(): Promise<SaveResult>;
  quickLoad(options?: { force?: boolean }): Promise<LoadResult>;
  deleteSlot(slot: SlotId): Promise<boolean>;
  listSlots(): Promise<SlotInfo[]>;

  /** True while Desfazer would still work. */
  readonly canUndo: boolean;
  undo(): Promise<boolean>;

  readonly autosaveEnabled: boolean;
  setAutosave(on: boolean): void;

  /** Ejetar: battery save, then the rolling autosave when the game was played, then everything stops. */
  eject(): Promise<void>;
  /** The session ended: battery save, then everything stops. The console may already be gone, so no state is taken. */
  end(): Promise<void>;
  /** Stops the timers and listeners without writing anything. */
  dispose(): void;
  /** Resolves when every write started so far has finished (the timers' saves run unattended). */
  settled(): Promise<void>;
  /** Returns the function that removes the listener. */
  on(listener: (event: SavesEvent) => void): () => void;
}

/* ---- pure helpers, exported for the tests and the drawer ---- */

/** The size a frame is scaled to: 160 wide, the height following, and never bigger than the source. */
export function thumbSize(width: number, height: number, target = THUMB_WIDTH): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: target, height: Math.round((target * 2) / 3) };
  if (width <= target) return { width, height };
  return { width: target, height: Math.max(1, Math.round((height * target) / width)) };
}

/**
 * A battery save that holds nothing: every byte 0x00 or every byte 0xFF (a fresh SRAM, an erased flash). The core
 * hands such a buffer back for a cartridge that has no battery at all, and writing it would put a save on the shelf
 * for a game that never makes one.
 */
export function isBlankSave(data: Uint8Array): boolean {
  if (data.length === 0) return true;
  const first = data[0] as number;
  if (first !== 0x00 && first !== 0xff) return false;
  for (let i = 1; i < data.length; i++) if (data[i] !== first) return false;
  return true;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function pipeThrough(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Gzip with the platform's `CompressionStream`; null when this browser has none (the state is then stored as it is). */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  return pipeThrough(bytes, new CompressionStream("gzip"));
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot read a compressed state");
  return pipeThrough(bytes, new DecompressionStream("gzip"));
}

/** The browser's downscale of a screenshot to 160 px wide, as a PNG. Null when anything about it fails: a slot without a picture is still a slot. */
export async function thumbnailPng(frame: Blob, width = THUMB_WIDTH): Promise<Uint8Array | null> {
  try {
    const bitmap = await createImageBitmap(frame);
    const size = thumbSize(bitmap.width, bitmap.height, width);
    if (size.width === bitmap.width && size.height === bitmap.height) {
      bitmap.close();
      return new Uint8Array(await frame.arrayBuffer());
    }
    let png: Blob | null;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(size.width, size.height);
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      png = await canvas.convertToBlob({ type: "image/png" });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    }
    bitmap.close();
    return png ? new Uint8Array(await png.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

function slotFromKey(key: string, prefix: string): SlotId | null {
  const rest = key.slice(prefix.length);
  if (rest === "auto") return "auto";
  return rest === "1" || rest === "2" || rest === "3" || rest === "4" ? (Number(rest) as ManualSlot) : null;
}

function text(meta: StoreMeta | undefined, field: string): string | null {
  const value = meta?.[field];
  return typeof value === "string" ? value : null;
}

function number(meta: StoreMeta | undefined, field: string): number | null {
  const value = meta?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function originOf(raw: string | null): SlotOrigin {
  return raw === "phone" || raw === "computer" || raw === "tablet" ? raw : "device";
}

function infoOf(meta: StoreMeta | undefined): StateInfo | null {
  const core = text(meta, "core");
  const coreVersion = text(meta, "coreVersion");
  return core && coreVersion ? ({ core, coreVersion } as StateInfo) : null;
}

/** The slot's two entries as they were, kept for Desfazer. */
interface Previous {
  state: StoreEntry | null;
  thumb: StoreEntry | null;
}

export function createSaves(options: SavesOptions): Saves {
  const { store, runtime, sha } = options;
  const thumbnail = options.thumbnail ?? thumbnailPng;
  const origin: SlotOrigin = options.origin ?? "device";
  const listeners = new Set<(event: SavesEvent) => void>();

  let started = false;
  let ended = false;
  let running = false;
  let current: ManualSlot = 1;
  let autosaveOn = options.autosave ?? true;

  // battery save
  let lastSram: Uint8Array | null = null;
  let sramSavedAt: number | null = null;
  let sramTimer: ReturnType<typeof setInterval> | undefined;

  // play time, for the eject rule
  let playedMs = 0;
  let runStartedAt = 0;

  // autosave clock: what is left of the interval, which only runs while the game does
  let autosaveLeft = AUTOSAVE_INTERVAL_MS;
  let autosaveArmedAt = 0;
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

  // undo
  let pending: { slot: SlotId; previous: Previous; until: number; timer: ReturnType<typeof setTimeout> } | null = null;

  // everything that touches the store runs one after another
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const next = chain.then(job);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function emit(event: SavesEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // a toast that throws must not stop a save
      }
    }
  }

  function fail(where: Extract<SavesEvent, { type: "error" }>["where"], error: unknown): void {
    if (error instanceof StoreError && error.code === "too-large") emit({ type: "storage-full" });
    emit({ type: "error", where, error });
  }

  /** Whether this cartridge is on the shelf: only then is anything of its own written (see `requireShelf`). */
  async function onShelf(): Promise<boolean> {
    if (!options.requireShelf) return true;
    try {
      const key = `meta:${sha}`;
      return (await store.list(key)).some((row) => row.key === key);
    } catch {
      return false;
    }
  }

  /* ---- battery save ---- */

  function persistSram(reason: SramReason): Promise<boolean> {
    return serial(async () => {
      let data: Uint8Array | null;
      try {
        data = await runtime.readSram();
      } catch (error) {
        fail("sram", error);
        return false;
      }
      if (!data || data.length === 0) return false;
      if (lastSram && equalBytes(lastSram, data)) return false;
      // nothing the game wrote: no row, so the shelf and the drawer never claim a save that is not there
      if (!lastSram && isBlankSave(data)) return false;
      if (!(await onShelf())) return false;
      const copy = data.slice();
      const at = Date.now();
      try {
        await store.put(sramKey(sha), copy, { savedAt: at, size: copy.length });
      } catch (error) {
        fail("sram", error);
        return false;
      }
      lastSram = copy;
      sramSavedAt = at;
      emit({ type: "sram-saved", reason, bytes: copy.length });
      return true;
    });
  }

  function restoreSram(): Promise<boolean> {
    return serial(async () => {
      try {
        const entry = await store.get(sramKey(sha));
        if (!entry || entry.bytes.length === 0) return false;
        await runtime.writeSram(entry.bytes);
        lastSram = entry.bytes.slice();
        sramSavedAt = number(entry.meta, "savedAt");
        return true;
      } catch (error) {
        fail("restore", error);
        return false;
      }
    });
  }

  /* ---- slots ---- */

  async function readPrevious(slot: SlotId): Promise<Previous> {
    const [state, thumb] = await Promise.all([store.get(stateKey(sha, slot)), store.get(thumbKey(sha, slot))]);
    return { state, thumb };
  }

  async function writePrevious(slot: SlotId, previous: Previous): Promise<void> {
    if (previous.state) await store.put(stateKey(sha, slot), previous.state.bytes, previous.state.meta);
    else await store.delete(stateKey(sha, slot));
    if (previous.thumb) await store.put(thumbKey(sha, slot), previous.thumb.bytes, previous.thumb.meta);
    else await store.delete(thumbKey(sha, slot));
  }

  function clearPending(): void {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  function armUndo(slot: SlotId, previous: Previous): number {
    clearPending();
    const until = Date.now() + UNDO_WINDOW_MS;
    const timer = setTimeout(() => {
      pending = null;
      emit({ type: "undo-expired" });
    }, UNDO_WINDOW_MS);
    pending = { slot, previous, until, timer };
    return until;
  }

  function stateInfoNow(): StateInfo | null {
    try {
      return runtime.stateInfo?.() ?? null;
    } catch {
      return null;
    }
  }

  async function takeRecord(): Promise<StateInfo & { data: Uint8Array }> {
    if (runtime.getStateRecord) return runtime.getStateRecord();
    const data = await runtime.getState();
    return { core: "unknown" as StateInfo["core"], coreVersion: "unknown", data };
  }

  /** The body of a save, run inside the queue. */
  async function writeSlot(slot: SlotId): Promise<SaveResult> {
    if (!(await onShelf())) {
      // a manual save says the disk could not take it (it did not: the cartridge is not on it); the rolling one stays quiet
      if (slot !== "auto") emit({ type: "storage-full" });
      return { ok: false, reason: "not-shelved" };
    }
    let record: StateInfo & { data: Uint8Array };
    let frame: Uint8Array | null = null;
    try {
      record = await takeRecord();
    } catch (error) {
      fail("save", error);
      return { ok: false, reason: "failed" };
    }
    try {
      frame = await thumbnail(await runtime.screenshot());
    } catch {
      frame = null;
    }
    const manual = slot !== "auto";
    try {
      const previous = manual ? await readPrevious(slot) : null;
      const packed = await gzip(record.data);
      const at = Date.now();
      const meta: StoreMeta = {
        core: record.core,
        coreVersion: record.coreVersion,
        savedAt: at,
        origin,
        enc: (packed ? "gzip" : "raw") satisfies Encoding,
        size: record.data.length,
      };
      await store.put(stateKey(sha, slot), packed ?? record.data, meta);
      if (frame) await store.put(thumbKey(sha, slot), frame, { savedAt: at }).catch(() => undefined);
      else await store.delete(thumbKey(sha, slot)).catch(() => undefined);
      if (manual && previous) {
        const until = armUndo(slot, previous);
        emit({ type: "slot-saved", slot, overwrote: previous.state !== null, undoUntil: until });
      }
      return { ok: true, slot };
    } catch (error) {
      fail("save", error);
      return { ok: false, reason: error instanceof StoreError && error.code === "too-large" ? "too-large" : "failed" };
    }
  }

  function saveSlot(slot: SlotId): Promise<SaveResult> {
    if (!started || ended) return Promise.resolve({ ok: false, reason: "not-started" });
    return serial(() => writeSlot(slot));
  }

  function loadSlot(slot: SlotId, loadOptions: { force?: boolean } = {}): Promise<LoadResult> {
    if (!started || ended) return Promise.resolve({ ok: false, reason: "not-started" });
    return serial(async (): Promise<LoadResult> => {
      let entry: StoreEntry | null;
      try {
        entry = await store.get(stateKey(sha, slot));
      } catch (error) {
        fail("load", error);
        return { ok: false, reason: "failed" };
      }
      if (!entry) return { ok: false, reason: "empty" };
      const saved = infoOf(entry.meta);
      const nowInfo = stateInfoNow();
      if (!loadOptions.force && saved && nowInfo && (saved.core !== nowInfo.core || saved.coreVersion !== nowInfo.coreVersion)) {
        emit({ type: "old-core", slot, saved, current: nowInfo });
        return { ok: false, reason: "other-console", saved, current: nowInfo };
      }
      try {
        const raw = text(entry.meta, "enc") === "raw" ? entry.bytes : await gunzip(entry.bytes);
        await runtime.loadState(raw);
      } catch (error) {
        fail("load", error);
        return { ok: false, reason: "failed" };
      }
      if (slot !== "auto") current = slot;
      emit({ type: "slot-loaded", slot });
      return { ok: true, slot };
    });
  }

  function deleteSlot(slot: SlotId): Promise<boolean> {
    return serial(async () => {
      try {
        const previous = await readPrevious(slot);
        if (!previous.state && !previous.thumb) return false;
        await store.delete(stateKey(sha, slot));
        await store.delete(thumbKey(sha, slot));
        const until = armUndo(slot, previous);
        emit({ type: "slot-deleted", slot, undoUntil: until });
        return true;
      } catch (error) {
        fail("delete", error);
        return false;
      }
    });
  }

  function undo(): Promise<boolean> {
    return serial(async () => {
      const wanted = pending;
      if (!wanted || Date.now() > wanted.until) return false;
      clearPending();
      try {
        await writePrevious(wanted.slot, wanted.previous);
      } catch (error) {
        fail("undo", error);
        return false;
      }
      emit({ type: "undone", slot: wanted.slot });
      return true;
    });
  }

  async function listSlots(): Promise<SlotInfo[]> {
    const [states, thumbs] = await Promise.all([store.list(`state:${sha}:`), store.list(`thumb:${sha}:`)]);
    const stateBySlot = new Map<SlotId, (typeof states)[number]>();
    for (const row of states) {
      const slot = slotFromKey(row.key, `state:${sha}:`);
      if (slot !== null) stateBySlot.set(slot, row);
    }
    const thumbBySlot = new Map<SlotId, (typeof thumbs)[number]>();
    for (const row of thumbs) {
      const slot = slotFromKey(row.key, `thumb:${sha}:`);
      if (slot !== null) thumbBySlot.set(slot, row);
    }
    const nowInfo = stateInfoNow();
    return Promise.all(
      SLOT_IDS.map(async (slot): Promise<SlotInfo> => {
        const row = stateBySlot.get(slot);
        if (!row) {
          return { slot, empty: true, savedAt: null, size: 0, origin: "device", core: null, coreVersion: null, sameConsole: null, thumb: null };
        }
        const saved = infoOf(row.meta);
        const thumbRow = thumbBySlot.get(slot);
        let thumb: Uint8Array | null = null;
        if (thumbRow) {
          try {
            thumb = (await store.get(thumbRow.key))?.bytes ?? null;
          } catch {
            thumb = null;
          }
        }
        return {
          slot,
          empty: false,
          savedAt: number(row.meta, "savedAt") ?? row.updatedAt,
          size: row.size + (thumbRow?.size ?? 0),
          origin: originOf(text(row.meta, "origin")),
          core: saved?.core ?? null,
          coreVersion: saved?.coreVersion ?? null,
          sameConsole: saved && nowInfo ? saved.core === nowInfo.core && saved.coreVersion === nowInfo.coreVersion : null,
          thumb,
        };
      }),
    );
  }

  /* ---- clocks ---- */

  function armAutosave(): void {
    if (autosaveTimer !== undefined) clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
    if (!started || ended || !running || !autosaveOn) return;
    autosaveArmedAt = Date.now();
    autosaveTimer = setTimeout(() => {
      autosaveTimer = undefined;
      autosaveLeft = AUTOSAVE_INTERVAL_MS;
      armAutosave();
      void serial(() => writeSlot("auto")).then((result) => {
        if (result.ok) emit({ type: "autosaved", reason: "timer" });
      });
    }, autosaveLeft);
  }

  /** Takes what has run of the interval off the clock and stops it. */
  function freezeAutosave(): void {
    if (autosaveTimer === undefined) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
    autosaveLeft = Math.max(1, autosaveLeft - (Date.now() - autosaveArmedAt));
  }

  function playedNow(): number {
    return playedMs + (running ? Date.now() - runStartedAt : 0);
  }

  const onHidden = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") void persistSram("hidden");
  };
  const onPageHide = () => void persistSram("hidden");

  function stopClocks(): void {
    freezeAutosave();
    if (sramTimer !== undefined) clearInterval(sramTimer);
    sramTimer = undefined;
    if (options.watchVisibility !== false && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onHidden);
      if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
    }
    clearPending();
  }

  function stopNow(): void {
    if (ended) return;
    playedMs = playedNow();
    running = false;
    ended = true;
    stopClocks();
  }

  return {
    start() {
      if (started || ended) return;
      started = true;
      running = true;
      runStartedAt = Date.now();
      sramTimer = setInterval(() => void persistSram("interval"), SRAM_INTERVAL_MS);
      if (options.watchVisibility !== false && typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onHidden);
        if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);
      }
      armAutosave();
    },
    setPaused(paused) {
      if (!started || ended) return;
      if (paused && running) {
        playedMs += Date.now() - runStartedAt;
        running = false;
        freezeAutosave();
      } else if (!paused && !running) {
        running = true;
        runStartedAt = Date.now();
        armAutosave();
      }
    },
    restoreSram,
    flushSram: persistSram,
    get sramSavedAt() {
      return sramSavedAt;
    },
    get hasBattery() {
      return lastSram !== null;
    },

    get currentSlot() {
      return current;
    },
    selectSlot(slot) {
      if (slot === current) return;
      current = slot;
      emit({ type: "slot-selected", slot });
    },
    cycleSlot(delta) {
      const next = ((((current - 1 + delta) % 4) + 4) % 4) + 1;
      current = next as ManualSlot;
      emit({ type: "slot-selected", slot: current });
      return current;
    },
    saveSlot,
    loadSlot,
    quickSave: () => saveSlot(current),
    quickLoad: (loadOptions) => loadSlot(current, loadOptions),
    deleteSlot,
    listSlots,

    get canUndo() {
      return pending !== null && Date.now() <= pending.until;
    },
    undo,

    get autosaveEnabled() {
      return autosaveOn;
    },
    setAutosave(on) {
      if (on === autosaveOn) return;
      autosaveOn = on;
      if (on) {
        // a fresh interval: switching it on is not a promise to save at once
        autosaveLeft = AUTOSAVE_INTERVAL_MS;
        armAutosave();
      } else {
        freezeAutosave();
        autosaveLeft = AUTOSAVE_INTERVAL_MS;
      }
      emit({ type: "autosave-switched", on });
    },

    async eject() {
      if (ended) return;
      const played = playedNow();
      const wasStarted = started;
      // nothing may fire in the middle of the last writes
      freezeAutosave();
      if (sramTimer !== undefined) clearInterval(sramTimer);
      sramTimer = undefined;
      await persistSram("eject");
      if (wasStarted && autosaveOn && played >= EJECT_AUTOSAVE_MIN_PLAY_MS) {
        const result = await serial(() => writeSlot("auto"));
        if (result.ok) emit({ type: "autosaved", reason: "eject" });
      }
      stopNow();
    },
    async end() {
      if (ended) return;
      freezeAutosave();
      if (sramTimer !== undefined) clearInterval(sramTimer);
      sramTimer = undefined;
      await persistSram("end");
      stopNow();
    },
    dispose() {
      stopNow();
    },
    settled: () => chain.then(() => undefined),
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
