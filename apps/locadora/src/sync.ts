/**
 * SAVES NA CONTA (SPEC 10, flag `locadora_save_sync`): the app's half. The
 * device store stays the truth on this device; the account is a copy the host
 * keeps through the bridge's `sync.*` requests, so the same game picked on
 * another device finds its saves there.
 *
 * What goes: the battery save and the save states (their bytes, as the drawer
 * keeps them, and the slot's little picture). Never the game file, never its
 * title. The game is named to the host by its SHA-256 and the host turns that
 * into an account-salted key, so the server only ever sees the key.
 *
 * How two devices agree: every save on the account has a `rev`. This device
 * remembers, per slot, the rev it last agreed with and the SHA-256 of the
 * bytes it held then (`sync:<sha>`, one small row). A slot is "dirty" when what
 * it holds now is not those bytes: content, not clocks, because the account's
 * time and this device's are two different clocks. Every write names the rev it replaces, and the account
 * refuses a write over a newer one (`stale-rev`), which is a conflict:
 *  - the battery save is never resolved by itself (SPEC 10): the person picks;
 *  - the autosave is rolling: the newer one wins, and a newer one written on
 *    another device is the "Tu parou no computador" moment;
 *  - a manual slot asks, with both pictures, and can keep both (the other goes
 *    to a free slot).
 *
 * Uploads of the autosave and the battery save are at most every 5 minutes,
 * plus Ejetar; a manual save goes at once. Nothing here draws: the game
 * session turns what this reports into the sheet, the prompt and the chip.
 */
import type { SyncApi } from "@pqp/app-sdk";
import { gzip, MANUAL_SLOTS, sramKey, stateKey, thumbKey, thumbnailPng, type ManualSlot, type SavesEvent, type SlotId, UNDO_WINDOW_MS } from "./saves";
import type { DeviceStore, StoreEntry, StoreMeta } from "./store";

export type DeviceKind = "computer" | "phone" | "tablet";
/** `sram` is the battery save; the rest are the drawer's slots. */
export type SyncSlot = "sram" | SlotId;
export type SyncMode = "on" | "read-only";

export const SYNC_MAX_BYTES = 1024 * 1024;
export const SYNC_SRAM_MAX_BYTES = 256 * 1024;
export const SYNC_THUMB_MAX_BYTES = 16 * 1024;
/** The autosave and the battery save go up at most this often (and on Ejetar). */
export const SYNC_THROTTLE_MS = 5 * 60_000;
/** Boot does not wait longer than this on the account. */
export const PREPARE_TIMEOUT_MS = 8_000;

export const syncKey = (sha: string) => `sync:${sha}`;

/** The slice of the SDK this needs, so a test can stand a fake account in. */
export type SyncHost = SyncApi;
export type SyncEntry = Awaited<ReturnType<SyncHost["list"]>>[number];

export interface SyncAccount {
  readonly mode: SyncMode;
  readonly device: DeviceKind;
  readonly usage: { used: number; cap: number };
  /** Asks the account again. */
  refresh(): Promise<void>;
  /** Every Locadora save off the account. This device keeps its own. */
  clearAll(): Promise<void>;
  forGame(input: GameSyncInput): GameSync;
  onChange(listener: () => void): () => void;
}

/** One slot as the conflict sheet draws it. */
export interface ConflictSide {
  savedAt: number;
  device: DeviceKind;
  thumb: Uint8Array | null;
}

export interface SyncConflict {
  slot: SyncSlot;
  local: ConflictSide;
  remote: ConflictSide & { entry: SyncEntry; bytes: Uint8Array };
  /** "Guardar os dois": a manual slot, with a slot free here and on the account. Null when there is none. */
  freeSlot: ManualSlot | null;
}

export type ConflictChoice = "local" | "remote" | "both" | "later";

/** The account's autosave is newer than this device's and was written somewhere else. */
export interface ContinueOffer {
  remote: { savedAt: number; device: DeviceKind; thumb: Uint8Array | null };
  local: { savedAt: number; thumb: Uint8Array | null } | null;
}

export interface PrepareResult {
  /** The battery save differs here and on the account, and both changed: the person picks before the game boots. */
  sramConflict: SyncConflict | null;
  continueOffer: ContinueOffer | null;
  /** Manual slots that differ on both sides: asked once the game is up. */
  conflicts: SyncConflict[];
}

export type SyncStatus = "idle" | "busy" | "error";

export interface GameSyncInput {
  sha: string;
  platform: string;
  /** The core that runs this game, for a battery save's record (a state carries its own). */
  console: () => { core: string; coreVersion: string } | null;
  now?: () => number;
}

export interface GameSync {
  readonly status: SyncStatus;
  /** Before the console boots: pulls what is clean, reports what needs the person. */
  prepare(options?: { timeoutMs?: number }): Promise<PrepareResult>;
  /** The saves module's events: what to send, and when. */
  onSavesEvent(event: SavesEvent): void;
  /** Sends one slot now (a manual save does this; the throttled ones wait). Resolves to a conflict, if there is one. */
  push(slot: SyncSlot, options?: { force?: boolean }): Promise<SyncConflict | null>;
  resolve(conflict: SyncConflict, choice: ConflictChoice): Promise<void>;
  /** "Bora": the account's autosave becomes this device's. */
  acceptContinue(): Promise<void>;
  /** The person kept this device's: from now on its autosave overwrites the account's. */
  declineContinue(): Promise<void>;
  /** Ejetar: everything waiting goes now. */
  flush(): Promise<void>;
  dispose(): void;
  /** A conflict found while playing (a manual save that met a newer one). */
  onConflict(listener: (conflict: SyncConflict) => void): () => void;
  onChange(listener: () => void): () => void;
}

/* ---- pure helpers, exported for the tests ---- */

interface Book {
  id: string;
  rev: number;
  /** SHA-256 of the bytes this device held when it agreed with this rev. */
  hash: string;
}
type Books = Partial<Record<string, Book>>;

export const slotName = (slot: SyncSlot): string => String(slot);
export const slotOf = (entry: Pick<SyncEntry, "kind" | "slot">): SyncSlot | null =>
  entry.kind === "sram" ? "sram" : entry.slot === 0 ? "auto" : entry.slot >= 1 && entry.slot <= 4 ? (entry.slot as ManualSlot) : null;
const wireSlot = (slot: SyncSlot): { kind: "sram" | "state"; slot: number } =>
  slot === "sram" ? { kind: "sram", slot: 0 } : { kind: "state", slot: slot === "auto" ? 0 : slot };

/** What to do with one slot, from the account's row, this device's copy and what they last agreed on. */
export type Plan = "nothing" | "pull" | "push" | "adopt" | "conflict" | "forget";

export function planSlot(
  remote: { rev: number; hash: string } | null,
  local: { hash: string } | null,
  book: Book | undefined,
): Plan {
  if (!remote && !local) return book ? "forget" : "nothing";
  if (remote && !local) return "pull";
  const dirty = !book || local!.hash !== book.hash;
  if (!remote) {
    // deleted on the account: a slot saved here since is new progress, one that was not is let go of
    if (!book) return "push";
    return dirty ? "push" : "forget";
  }
  if (book && book.rev === remote.rev) return dirty ? "push" : "nothing";
  if (remote.hash === local!.hash) return "adopt";
  if (book && !dirty) return "pull";
  return "conflict";
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

function looksGzipped(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function numberOf(meta: StoreMeta | undefined, field: string): number | null {
  const value = meta?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOf(meta: StoreMeta | undefined, field: string): string | null {
  const value = meta?.[field];
  return typeof value === "string" ? value : null;
}

const TAG = /^[A-Za-z0-9._+-]{1,32}$/;
const tag = (value: string | null | undefined, fallback: string) => (value && TAG.test(value) ? value : fallback);

/** The host said no: off here, or an old host. Nothing to do but stay local. */
function isRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "not-allowed" || code === "invalid";
}
const isStale = (error: unknown) => (error as { code?: unknown } | null)?.code === "stale-rev";

/* ---- the account ---- */

/**
 * Asks the host whether this session has Saves na conta. Null when it does not
 * (the flag is off, the host predates it, a spectator): the app then says what
 * it always said, that everything stays on this device.
 */
export async function openSyncAccount(host: SyncHost, store: DeviceStore): Promise<SyncAccount | null> {
  return (await openSync(host, store)).account;
}

/**
 * Why Saves na conta is not working when the server says it is on. `off` is not here: that is the host saying no
 * (the flag is off, a watcher, an old host) and the app stays quiet, as it always did. These two are the ones a
 * person has to be told about, because a feature that is on but silently missing is worse than one that says so:
 *  - `unreachable`: the status call failed or took too long (the API or the bucket's host is down, a rate limit);
 *  - `no-store`: the account answered but this browser keeps nothing between visits, so there is nothing to sync.
 */
export type SyncProblem = "unreachable" | "no-store";

export interface SyncOpen {
  account: SyncAccount | null;
  problem: SyncProblem | null;
}

/** The status call may not hold the shelf back longer than this. */
export const STATUS_TIMEOUT_MS = 6_000;

export interface OpenSyncOptions {
  timeoutMs?: number;
  /** Where a failure is told to the console. The default is `console.warn`; a test passes its own. */
  warn?: (message: string, detail?: unknown) => void;
}

/**
 * Asks the host whether this session has Saves na conta, and says WHY when it cannot be had. A refusal
 * (`not-allowed`, `invalid`) is the quiet "off". Anything else, a timeout included, is `unreachable`: logged, and
 * returned, so the shelf and the drawer can say the account did not answer instead of drawing nothing.
 */
export async function openSync(host: SyncHost, store: DeviceStore, options: OpenSyncOptions = {}): Promise<SyncOpen> {
  const warn = options.warn ?? ((message, detail) => console.warn(`[locadora] ${message}`, detail ?? ""));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: Awaited<ReturnType<SyncHost["status"]>>;
  try {
    status = await Promise.race([
      host.status(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "timeout" })), options.timeoutMs ?? STATUS_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (isRefusal(error)) return { account: null, problem: null };
    warn("Saves na conta: the account did not answer, so saves stay on this device", error);
    return { account: null, problem: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
  if (!store.durable) {
    warn("Saves na conta: this browser keeps nothing between visits, so nothing is sent to the account");
    return { account: null, problem: "no-store" };
  }
  return { account: createSyncAccount(host, store, status), problem: null };
}

/** The games this device has agreed saves for on the account (a `sync:<sha>` row each): what the shelf marks "na conta". */
export async function gamesOnAccount(store: DeviceStore): Promise<Set<string>> {
  try {
    return new Set((await store.list("sync:")).map((row) => row.key.slice("sync:".length)));
  } catch {
    return new Set();
  }
}

export function createSyncAccount(
  host: SyncHost,
  store: DeviceStore,
  initial: Awaited<ReturnType<SyncHost["status"]>>,
): SyncAccount {
  let status = initial;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const games = new Set<GameSync>();

  const account: SyncAccount = {
    get mode() {
      return status.mode;
    },
    get device() {
      return status.device;
    },
    get usage() {
      return { used: status.used, cap: status.cap };
    },
    async refresh() {
      try {
        status = await host.status();
      } catch {
        return;
      }
      changed();
    },
    async clearAll() {
      const out = await host.clear();
      status = { ...status, used: out.used, cap: out.cap };
      // this device no longer agrees with anything on the account
      for (const row of await store.list("sync:")) await store.delete(row.key);
      changed();
    },
    forGame(input) {
      const game = createGameSync(host, store, account, input, (usage) => {
        status = { ...status, ...usage };
        changed();
      });
      games.add(game);
      return game;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return account;
}

/* ---- one game ---- */

function createGameSync(
  host: SyncHost,
  store: DeviceStore,
  account: SyncAccount,
  input: GameSyncInput,
  setUsage: (usage: { used: number; cap: number }) => void,
): GameSync {
  const { sha } = input;
  const now = input.now ?? Date.now;
  const conflictListeners = new Set<(conflict: SyncConflict) => void>();
  const changeListeners = new Set<() => void>();
  let status: SyncStatus = "idle";
  let disposed = false;
  let offer: { entry: SyncEntry; bytes: Uint8Array; thumb: Uint8Array | null } | null = null;
  const lastPush = new Map<string, number>();
  const pending = new Set<SyncSlot>();
  let throttleTimer: ReturnType<typeof setTimeout> | undefined;
  const deleteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The account's rows of this game, from the last list. */
  let remote: SyncEntry[] = [];

  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const next = chain.then(job);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function setStatus(next: SyncStatus) {
    if (status === next) return;
    status = next;
    for (const listener of [...changeListeners]) listener();
  }
  const notify = () => {
    for (const listener of [...changeListeners]) listener();
  };

  async function readBooks(): Promise<Books> {
    const row = await store.get(syncKey(sha)).catch(() => null);
    const raw = row?.meta?.e;
    if (typeof raw !== "object" || raw === null) return {};
    const out: Books = {};
    for (const [slot, value] of Object.entries(raw as Record<string, unknown>)) {
      const book = value as Partial<Book>;
      if (typeof book.id === "string" && typeof book.rev === "number" && typeof book.hash === "string") {
        out[slot] = { id: book.id, rev: book.rev, hash: book.hash };
      }
    }
    return out;
  }

  async function writeBook(slot: SyncSlot, book: Book | null): Promise<void> {
    const books = await readBooks();
    if (book) books[slotName(slot)] = book;
    else delete books[slotName(slot)];
    if (Object.keys(books).length === 0) await store.delete(syncKey(sha)).catch(() => undefined);
    else await store.put(syncKey(sha), new Uint8Array([1]), { v: 1, e: books as unknown as StoreMeta }).catch(() => undefined);
  }

  /** This device's copy of one slot: its bytes, when it was saved and its picture. */
  async function readLocal(slot: SyncSlot): Promise<{ entry: StoreEntry; at: number; thumb: Uint8Array | null } | null> {
    if (slot === "sram") {
      const entry = await store.get(sramKey(sha));
      if (!entry) return null;
      return { entry, at: numberOf(entry.meta, "savedAt") ?? 0, thumb: null };
    }
    const entry = await store.get(stateKey(sha, slot));
    if (!entry) return null;
    const thumb = await store.get(thumbKey(sha, slot)).catch(() => null);
    return { entry, at: numberOf(entry.meta, "savedAt") ?? 0, thumb: thumb?.bytes ?? null };
  }

  /** The account's copy becomes this device's, picture and all. */
  async function writeLocal(slot: SyncSlot, entry: SyncEntry, bytes: Uint8Array, thumb: Uint8Array | null): Promise<void> {
    const origin = entry.thisDevice ? "device" : entry.device;
    if (slot === "sram") {
      await store.put(sramKey(sha), bytes, { savedAt: entry.savedAt, size: bytes.length, origin });
    } else {
      await store.put(stateKey(sha, slot), bytes, {
        core: entry.core,
        coreVersion: entry.coreVersion,
        savedAt: entry.savedAt,
        origin,
        enc: looksGzipped(bytes) ? "gzip" : "raw",
        size: bytes.length,
      });
      if (thumb) await store.put(thumbKey(sha, slot), thumb, { savedAt: entry.savedAt });
      else await store.delete(thumbKey(sha, slot)).catch(() => undefined);
    }
    await writeBook(slot, { id: entry.id, rev: entry.rev, hash: await sha256(bytes) });
  }

  async function pull(slot: SyncSlot, entry: SyncEntry): Promise<void> {
    const got = await host.get(entry.id);
    await writeLocal(slot, { ...entry, rev: got.rev }, new Uint8Array(got.bytes), got.thumb ? new Uint8Array(got.thumb) : null);
  }

  /** A picture small enough for the account: the drawer's, or a smaller one drawn from it, or none. */
  async function syncThumb(thumb: Uint8Array | null): Promise<Uint8Array | null> {
    if (!thumb) return null;
    if (thumb.length <= SYNC_THUMB_MAX_BYTES) return thumb;
    const smaller = await thumbnailPng(new Blob([thumb as BlobPart], { type: "image/png" }), 96).catch(() => null);
    return smaller && smaller.length <= SYNC_THUMB_MAX_BYTES ? smaller : null;
  }

  async function list(): Promise<SyncEntry[]> {
    remote = await host.list(sha);
    return remote;
  }

  const remoteOf = (slot: SyncSlot) => remote.find((entry) => slotOf(entry) === slot) ?? null;

  async function freeSlot(): Promise<ManualSlot | null> {
    for (const slot of MANUAL_SLOTS) {
      if (remoteOf(slot)) continue;
      if (await store.get(stateKey(sha, slot)).catch(() => null)) continue;
      return slot;
    }
    return null;
  }

  async function conflictFor(slot: SyncSlot, entry: SyncEntry, local: { at: number; thumb: Uint8Array | null }): Promise<SyncConflict> {
    const got = await host.get(entry.id);
    return {
      slot,
      local: { savedAt: local.at, device: account.device, thumb: local.thumb },
      remote: {
        savedAt: entry.savedAt,
        device: entry.device,
        thumb: got.thumb ? new Uint8Array(got.thumb) : null,
        entry: { ...entry, rev: got.rev },
        bytes: new Uint8Array(got.bytes),
      },
      freeSlot: slot === "sram" || slot === "auto" ? null : await freeSlot(),
    };
  }

  /** Sends one slot as this device has it, over `baseRev`. A stale rev comes back as the account's row. */
  async function upload(slot: SyncSlot, baseRev: number): Promise<{ ok: true } | { ok: false; stale: boolean }> {
    const local = await readLocal(slot);
    if (!local) return { ok: true };
    let bytes = local.entry.bytes;
    if (slot !== "sram" && textOf(local.entry.meta, "enc") === "raw") bytes = (await gzip(bytes)) ?? bytes;
    if (bytes.length > (slot === "sram" ? SYNC_SRAM_MAX_BYTES : SYNC_MAX_BYTES)) return { ok: false, stale: false };
    const consoleNow = input.console();
    const thumb = slot === "sram" ? null : await syncThumb(local.thumb);
    const wire = wireSlot(slot);
    try {
      const out = await host.put({
        game: sha,
        ...wire,
        baseRev,
        bytes,
        ...(thumb ? { thumb } : {}),
        platform: tag(input.platform, "unknown"),
        core: tag(textOf(local.entry.meta, "core") ?? consoleNow?.core, "unknown"),
        coreVersion: tag(textOf(local.entry.meta, "coreVersion") ?? consoleNow?.coreVersion, "unknown"),
      });
      setUsage({ used: out.used, cap: out.cap });
      await writeBook(slot, { id: out.id, rev: out.rev, hash: await sha256(local.entry.bytes) });
      lastPush.set(slotName(slot), now());
      remote = [
        ...remote.filter((entry) => slotOf(entry) !== slot),
        {
          id: out.id,
          ...wire,
          rev: out.rev,
          size: bytes.length,
          hash: await sha256(bytes),
          savedAt: now(),
          device: account.device,
          thisDevice: true,
          thumb: thumb !== null,
          platform: tag(input.platform, "unknown"),
          core: "unknown",
          coreVersion: "unknown",
          history: 0,
        },
      ];
      return { ok: true };
    } catch (error) {
      if (isStale(error)) return { ok: false, stale: true };
      throw error;
    }
  }

  async function pushNow(slot: SyncSlot, force: boolean): Promise<SyncConflict | null> {
    if (account.mode !== "on" || disposed) return null;
    pending.delete(slot);
    const books = await readBooks();
    const book = books[slotName(slot)];
    const local = await readLocal(slot);
    if (!local) return null;
    const localHash = await sha256(local.entry.bytes);
    if (!force && book && localHash === book.hash) return null;
    setStatus("busy");
    try {
      let result = await upload(slot, book?.rev ?? 0);
      if (!result.ok && result.stale) {
        await list();
        const current = remoteOf(slot);
        if (!current) {
          // deleted on the account meanwhile: this is new progress, it goes up as new
          result = await upload(slot, 0);
        } else if (current.hash === localHash) {
          await writeBook(slot, { id: current.id, rev: current.rev, hash: localHash });
          result = { ok: true };
        } else if (slot === "auto") {
          // rolling: the newer one wins, and this one was just made
          result = await upload(slot, current.rev);
        } else {
          setStatus("idle");
          return conflictFor(slot, current, local);
        }
      }
      setStatus("idle");
      return null;
    } catch (error) {
      if (isRefusal(error)) {
        setStatus("idle");
        return null;
      }
      pending.add(slot);
      setStatus("error");
      return null;
    }
  }

  function push(slot: SyncSlot, options: { force?: boolean } = {}): Promise<SyncConflict | null> {
    return serial(() => pushNow(slot, options.force === true));
  }

  function emitConflict(conflict: SyncConflict | null) {
    if (!conflict) return;
    for (const listener of [...conflictListeners]) listener(conflict);
  }

  /** The autosave and the battery save: at most every 5 minutes, then whatever is waiting goes in one go. */
  function throttled(slot: SyncSlot) {
    pending.add(slot);
    const last = lastPush.get(slotName(slot)) ?? 0;
    const wait = Math.max(0, last + SYNC_THROTTLE_MS - now());
    if (wait === 0) {
      void push(slot).then(emitConflict);
      return;
    }
    if (throttleTimer !== undefined) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = undefined;
      for (const waiting of [...pending]) void push(waiting).then(emitConflict);
    }, wait);
  }

  function scheduleDelete(slot: SlotId) {
    const key = slotName(slot);
    clearTimeout(deleteTimers.get(key));
    deleteTimers.set(
      key,
      setTimeout(() => {
        deleteTimers.delete(key);
        void serial(async () => {
          if (account.mode !== "on" || disposed) return;
          if (await store.get(stateKey(sha, slot)).catch(() => null)) return; // it came back (Desfazer)
          const book = (await readBooks())[key];
          if (!book) return;
          try {
            setUsage(await host.delete(book.id));
          } catch {
            // gone already, or the account is out of reach: either way this device forgets it, and
            // the 365 day sweep takes what the account still holds
          }
          remote = remote.filter((entry) => slotOf(entry) !== slot);
          await writeBook(slot, null);
          notify();
        });
      }, UNDO_WINDOW_MS + 500),
    );
  }

  async function prepareNow(): Promise<PrepareResult> {
    const result: PrepareResult = { sramConflict: null, continueOffer: null, conflicts: [] };
    await list();
    const books = await readBooks();
    for (const slot of ["sram", "auto", ...MANUAL_SLOTS] as SyncSlot[]) {
      const entry = remoteOf(slot);
      const local = await readLocal(slot);
      const book = books[slotName(slot)];
      const localHash = local ? await sha256(local.entry.bytes) : null;
      const plan = planSlot(entry ? { rev: entry.rev, hash: entry.hash } : null, localHash ? { hash: localHash } : null, book);
      if (slot === "auto" && entry && !entry.thisDevice && (plan === "pull" || plan === "conflict") && entry.savedAt > (local?.at ?? 0)) {
        // the moment: a newer autosave from somewhere else. Fetched now, so the click that answers is the Start
        const got = await host.get(entry.id);
        offer = { entry: { ...entry, rev: got.rev }, bytes: new Uint8Array(got.bytes), thumb: got.thumb ? new Uint8Array(got.thumb) : null };
        result.continueOffer = {
          remote: { savedAt: entry.savedAt, device: entry.device, thumb: offer.thumb },
          local: local ? { savedAt: local.at, thumb: local.thumb } : null,
        };
        continue;
      }
      switch (plan) {
        case "pull":
          await pull(slot, entry!);
          break;
        case "adopt":
          await writeBook(slot, { id: entry!.id, rev: entry!.rev, hash: localHash! });
          break;
        case "forget":
          await writeBook(slot, null);
          break;
        case "push":
          if (account.mode === "on") pending.add(slot);
          break;
        case "conflict":
          if (slot === "auto") {
            if (account.mode === "on") pending.add(slot);
          } else if (slot === "sram") {
            result.sramConflict = await conflictFor(slot, entry!, local!);
          } else {
            result.conflicts.push(await conflictFor(slot, entry!, local!));
          }
          break;
        default:
      }
    }
    return result;
  }

  return {
    get status() {
      return status;
    },
    async prepare(options = {}) {
      const empty: PrepareResult = { sramConflict: null, continueOffer: null, conflicts: [] };
      setStatus("busy");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), options.timeoutMs ?? PREPARE_TIMEOUT_MS);
      });
      try {
        const out = await Promise.race([serial(prepareNow), timeout]);
        clearTimeout(timer);
        if (out === "timeout") {
          setStatus("error");
          return empty;
        }
        setStatus("idle");
        return out;
      } catch (error) {
        clearTimeout(timer);
        setStatus(isRefusal(error) ? "idle" : "error");
        return empty;
      }
    },
    onSavesEvent(event) {
      if (account.mode !== "on" || disposed) return;
      switch (event.type) {
        case "slot-saved":
          void push(event.slot).then(emitConflict);
          break;
        case "autosaved":
          if (event.reason === "eject") void push("auto").then(emitConflict);
          else throttled("auto");
          break;
        case "sram-saved":
          if (event.reason === "eject") void push("sram").then(emitConflict);
          else throttled("sram");
          break;
        case "slot-deleted":
          scheduleDelete(event.slot);
          break;
        case "undone":
          clearTimeout(deleteTimers.get(slotName(event.slot)));
          deleteTimers.delete(slotName(event.slot));
          void push(event.slot, { force: true }).then(emitConflict);
          break;
        default:
      }
    },
    push,
    resolve(conflict, choice) {
      return serial(async () => {
        if (choice === "later") return;
        const { slot } = conflict;
        const entry = conflict.remote.entry;
        try {
          if (choice === "remote") {
            await writeLocal(slot, entry, conflict.remote.bytes, conflict.remote.thumb);
          } else {
            if (choice === "both" && conflict.freeSlot !== null) {
              await writeLocal(conflict.freeSlot, entry, conflict.remote.bytes, conflict.remote.thumb);
              await writeBook(conflict.freeSlot, null);
              await upload(conflict.freeSlot, 0);
            }
            if (account.mode === "on") await upload(slot, entry.rev);
          }
          setStatus("idle");
        } catch {
          setStatus("error");
        }
        notify();
      });
    },
    acceptContinue() {
      return serial(async () => {
        const taken = offer;
        offer = null;
        if (!taken) return;
        await writeLocal("auto", taken.entry, taken.bytes, taken.thumb);
        notify();
      });
    },
    declineContinue() {
      return serial(async () => {
        const taken = offer;
        offer = null;
        if (!taken) return;
        const local = await readLocal("auto");
        // this device's autosave stands and goes up over the account's (an empty hash: nothing here agreed with it)
        await writeBook("auto", { id: taken.entry.id, rev: taken.entry.rev, hash: "" });
        if (local && account.mode === "on") pending.add("auto");
      });
    },
    async flush() {
      if (throttleTimer !== undefined) clearTimeout(throttleTimer);
      throttleTimer = undefined;
      for (const slot of [...pending]) emitConflict(await push(slot));
      await chain;
    },
    dispose() {
      disposed = true;
      if (throttleTimer !== undefined) clearTimeout(throttleTimer);
      for (const timer of deleteTimers.values()) clearTimeout(timer);
      deleteTimers.clear();
      conflictListeners.clear();
      changeListeners.clear();
    },
    onConflict(listener) {
      conflictListeners.add(listener);
      return () => conflictListeners.delete(listener);
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
  };
}
