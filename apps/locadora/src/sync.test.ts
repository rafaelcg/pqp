import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sramKey, stateKey, thumbKey, UNDO_WINDOW_MS } from "./saves";
import { memoryStore, type DeviceStore } from "./store";
import {
  createSyncAccount,
  gamesOnAccount,
  openSync,
  openSyncAccount,
  planSlot,
  SYNC_THROTTLE_MS,
  syncKey,
  type DeviceKind,
  type GameSync,
  type SyncHost,
} from "./sync";

/**
 * SAVES NA CONTA, the app's half: what one device sends and what another finds,
 * with the account stood in by a fake that keeps revs the way the server does
 * (a write over a newer rev is `stale-rev`). Two devices are two device stores
 * and two views of the same account. No game: the "game" is a hash of nothing.
 */

const GAME = "e".repeat(64);
const hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (...values: number[]) => new Uint8Array(values);

interface Row {
  id: string;
  kind: "sram" | "state";
  slot: number;
  rev: number;
  bytes: Uint8Array;
  thumb: Uint8Array | null;
  savedAt: number;
  deviceId: string;
  device: DeviceKind;
  core: string;
  coreVersion: string;
  platform: string;
}

class FakeAccount {
  rows = new Map<string, Row>();
  puts: Array<{ device: string; kind: string; slot: number; baseRev: number }> = [];
  deletes: string[] = [];
  private next = 1;
  now = 1_000_000;

  view(deviceId: string, device: DeviceKind): SyncHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const account = this;
    const entryOf = (row: Row) => ({
      id: row.id,
      kind: row.kind,
      slot: row.slot,
      rev: row.rev,
      size: row.bytes.length,
      hash: hex(row.bytes),
      savedAt: row.savedAt,
      device: row.device,
      thisDevice: row.deviceId === deviceId,
      thumb: row.thumb !== null,
      platform: row.platform,
      core: row.core,
      coreVersion: row.coreVersion,
      history: 0,
    });
    const usage = () => {
      let used = 0;
      for (const row of account.rows.values()) used += row.bytes.length + (row.thumb?.length ?? 0);
      return { used, cap: 8 * 1024 * 1024 };
    };
    const find = (id: string) => [...account.rows.entries()].find(([, row]) => row.id === id);
    return {
      status: async () => ({ mode: "on", ...usage(), device }),
      list: async (game) => [...account.rows.entries()].filter(([key]) => key.startsWith(`${game}:`)).map(([, row]) => entryOf(row)),
      get: async (id) => {
        const row = find(id)?.[1];
        if (!row) throw Object.assign(new Error("gone"), { code: "not-allowed" });
        return { rev: row.rev, bytes: row.bytes.slice().buffer, thumb: row.thumb ? row.thumb.slice().buffer : null };
      },
      put: async (save) => {
        account.puts.push({ device: deviceId, kind: save.kind, slot: save.slot, baseRev: save.baseRev });
        const key = `${save.game}:${save.kind}:${save.slot}`;
        const current = account.rows.get(key);
        if ((current?.rev ?? 0) !== save.baseRev) throw Object.assign(new Error("stale"), { code: "stale-rev" });
        const view = (value: ArrayBuffer | ArrayBufferView) =>
          ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice() : new Uint8Array(value).slice();
        const row: Row = {
          id: current?.id ?? `5b7b9f4e-8c0d-4f0a-9d6e-${String(account.next++).padStart(12, "0")}`,
          kind: save.kind,
          slot: save.slot,
          rev: (current?.rev ?? 0) + 1,
          bytes: view(save.bytes),
          thumb: save.thumb ? view(save.thumb) : null,
          savedAt: (account.now += 1000),
          deviceId,
          device,
          core: save.core,
          coreVersion: save.coreVersion,
          platform: save.platform,
        };
        account.rows.set(key, row);
        return { id: row.id, rev: row.rev, ...usage() };
      },
      delete: async (id) => {
        const found = find(id);
        if (found) account.rows.delete(found[0]);
        account.deletes.push(id);
        return usage();
      },
      restore: async () => {
        throw Object.assign(new Error("no"), { code: "not-allowed" });
      },
      clear: async (game) => {
        let deleted = 0;
        for (const key of [...account.rows.keys()]) {
          if (!game || key.startsWith(`${game}:`)) {
            account.rows.delete(key);
            deleted += 1;
          }
        }
        return { deleted, ...usage() };
      },
    };
  }
}

/** A device store that says it keeps things, like the host's. */
function durableStore(): DeviceStore {
  const store = memoryStore();
  return Object.defineProperty(store, "durable", { value: true });
}

interface Device {
  store: DeviceStore;
  sync: GameSync;
  /** Puts a slot in the device store the way `saves.ts` does, saved at `at`. */
  saveState(slot: "auto" | 1 | 2 | 3 | 4, bytes: Uint8Array, at: number, thumb?: Uint8Array): Promise<void>;
  saveSram(bytes: Uint8Array, at: number): Promise<void>;
}

async function device(account: FakeAccount, id: string, kind: DeviceKind, now = () => 5_000_000): Promise<Device> {
  const store = durableStore();
  const host = account.view(id, kind);
  const status = await host.status();
  const sync = createSyncAccount(host, store, status).forGame({
    sha: GAME,
    platform: "gba",
    console: () => ({ core: "mgba", coreVersion: "4.2.3" }),
    now,
  });
  return {
    store,
    sync,
    async saveState(slot, bytes, at, thumb) {
      await store.put(stateKey(GAME, slot), bytes, { core: "mgba", coreVersion: "4.2.3", savedAt: at, origin: "device", enc: "gzip", size: bytes.length });
      if (thumb) await store.put(thumbKey(GAME, slot), thumb, { savedAt: at });
    },
    async saveSram(bytes, at) {
      await store.put(sramKey(GAME), bytes, { savedAt: at, size: bytes.length });
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("planSlot", () => {
  const book = { id: "x", rev: 2, hash: "agreed" };
  it("decides from the account's row, this device's copy and the bytes they last agreed on", () => {
    expect(planSlot(null, null, undefined)).toBe("nothing");
    expect(planSlot(null, null, book)).toBe("forget");
    expect(planSlot({ rev: 1, hash: "a" }, null, undefined)).toBe("pull");
    expect(planSlot(null, { hash: "a" }, undefined)).toBe("push");
    // deleted on the account: unchanged here is let go, changed here is new progress
    expect(planSlot(null, { hash: "agreed" }, book)).toBe("forget");
    expect(planSlot(null, { hash: "newer" }, book)).toBe("push");
    expect(planSlot({ rev: 2, hash: "agreed" }, { hash: "agreed" }, book)).toBe("nothing");
    expect(planSlot({ rev: 2, hash: "agreed" }, { hash: "newer" }, book)).toBe("push");
    expect(planSlot({ rev: 3, hash: "theirs" }, { hash: "agreed" }, book)).toBe("pull");
    expect(planSlot({ rev: 3, hash: "theirs" }, { hash: "newer" }, book)).toBe("conflict");
    expect(planSlot({ rev: 3, hash: "same" }, { hash: "same" }, book)).toBe("adopt");
    expect(planSlot({ rev: 1, hash: "theirs" }, { hash: "mine" }, undefined)).toBe("conflict");
  });
});

describe("openSyncAccount", () => {
  it("is null where the host says no, and on a store that keeps nothing", async () => {
    const refusing = { status: async () => Promise.reject(Object.assign(new Error("no"), { code: "not-allowed" })) } as unknown as SyncHost;
    expect(await openSyncAccount(refusing, durableStore())).toBeNull();
    const account = new FakeAccount();
    expect(await openSyncAccount(account.view("dev-a-00000000000", "computer"), memoryStore())).toBeNull();
    expect(await openSyncAccount(account.view("dev-a-00000000000", "computer"), durableStore())).not.toBeNull();
  });
});

/**
 * "Can't see cloud saves": with the flag on at the server and the account unreachable, `openSyncAccount` answered
 * null, the same null as "the feature is off", and the app drew nothing and logged nothing. A feature that is ON but
 * silently missing is the bug; these pin that it says why.
 */
describe("openSync: a failure is said, never swallowed", () => {
  const failing = (error: unknown) => ({ status: async () => Promise.reject(error) }) as unknown as SyncHost;

  it("a refusal is the quiet off: no problem, nothing logged", async () => {
    const warn = vi.fn();
    for (const code of ["not-allowed", "invalid"]) {
      const out = await openSync(failing(Object.assign(new Error("no"), { code })), durableStore(), { warn });
      expect(out).toEqual({ account: null, problem: null });
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("an account that does not answer (unavailable, rate limited, a network error) is `unreachable`, and logged", async () => {
    for (const error of [
      Object.assign(new Error("down"), { code: "unavailable" }),
      Object.assign(new Error("slow down"), { code: "rate-limited" }),
      new TypeError("Failed to fetch"),
    ]) {
      const warn = vi.fn();
      const out = await openSync(failing(error), durableStore(), { warn });
      expect(out).toEqual({ account: null, problem: "unreachable" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("Saves na conta");
    }
  });

  it("a status call that never comes back does not hold the shelf: `unreachable` after the timeout", async () => {
    const warn = vi.fn();
    const hung = { status: () => new Promise<never>(() => undefined) } as unknown as SyncHost;
    const out = await openSync(hung, durableStore(), { timeoutMs: 20, warn });
    expect(out).toEqual({ account: null, problem: "unreachable" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("an account that answers on a browser that keeps nothing is `no-store`, and logged", async () => {
    const warn = vi.fn();
    const account = new FakeAccount();
    const out = await openSync(account.view("dev-a-00000000000", "computer"), memoryStore(), { warn });
    expect(out).toEqual({ account: null, problem: "no-store" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a working account has no problem", async () => {
    const warn = vi.fn();
    const out = await openSync(new FakeAccount().view("dev-a-00000000000", "computer"), durableStore(), { warn });
    expect(out.problem).toBeNull();
    expect(out.account?.mode).toBe("on");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("gamesOnAccount", () => {
  it("lists the games this device has agreed saves for with the account, from the `sync:` rows alone", async () => {
    const store = durableStore();
    expect((await gamesOnAccount(store)).size).toBe(0);
    await store.put(syncKey(GAME), new Uint8Array([1]), { v: 1 });
    await store.put("state:" + "f".repeat(64) + ":1", new Uint8Array([1]));
    expect([...(await gamesOnAccount(store))]).toEqual([GAME]);
  });
});

describe("two devices, one account", () => {
  it("a manual save goes up at once, with its picture, and the other device finds it before the game boots", async () => {
    const account = new FakeAccount();
    const pc = await device(account, "dev-pc-0000000000", "computer");
    const phone = await device(account, "dev-phone-00000000", "phone");

    await pc.saveState(1, bytesOf(1, 2, 3), 200, bytesOf(9, 9));
    pc.sync.onSavesEvent({ type: "slot-saved", slot: 1, overwrote: false, undoUntil: 0 });
    await pc.sync.flush();
    expect(account.puts).toEqual([{ device: "dev-pc-0000000000", kind: "state", slot: 1, baseRev: 0 }]);

    const prepared = await phone.sync.prepare();
    expect(prepared).toEqual({ sramConflict: null, continueOffer: null, conflicts: [] });
    const pulled = await phone.store.get(stateKey(GAME, 1));
    expect([...pulled!.bytes]).toEqual([1, 2, 3]);
    expect(pulled!.meta).toMatchObject({ origin: "computer", core: "mgba", enc: "raw" });
    expect([...(await phone.store.get(thumbKey(GAME, 1)))!.bytes]).toEqual([9, 9]);
    expect((await phone.store.get(syncKey(GAME)))?.meta).toMatchObject({ e: { "1": { rev: 1 } } });

    // nothing changed since: a second boot does nothing at all
    const putsBefore = account.puts.length;
    await phone.sync.prepare();
    await phone.sync.flush();
    expect(account.puts.length).toBe(putsBefore);
  });

  it("the account's newer autosave from another device is the 'Tu parou no computador' moment, and Bora makes it this device's", async () => {
    const account = new FakeAccount();
    const pc = await device(account, "dev-pc-0000000000", "computer");
    const phone = await device(account, "dev-phone-00000000", "phone");
    await phone.saveState("auto", bytesOf(7), 10);
    await pc.saveState("auto", bytesOf(8, 8), 999_999_999, bytesOf(1));
    await pc.sync.push("auto", { force: true });

    const prepared = await phone.sync.prepare();
    expect(prepared.continueOffer).toMatchObject({
      remote: { device: "computer", thumb: bytesOf(1) },
      local: { savedAt: 10 },
    });
    // nothing was written yet: the person has not answered
    expect([...(await phone.store.get(stateKey(GAME, "auto")))!.bytes]).toEqual([7]);
    await phone.sync.acceptContinue();
    expect([...(await phone.store.get(stateKey(GAME, "auto")))!.bytes]).toEqual([8, 8]);
  });

  it("keeping this device's autosave instead makes its next one overwrite the account's", async () => {
    const account = new FakeAccount();
    const pc = await device(account, "dev-pc-0000000000", "computer");
    const phone = await device(account, "dev-phone-00000000", "phone");
    await phone.saveState("auto", bytesOf(7), 10);
    await pc.saveState("auto", bytesOf(8, 8), 999_999_999);
    await pc.sync.push("auto", { force: true });
    expect((await phone.sync.prepare()).continueOffer).not.toBeNull();
    await phone.sync.declineContinue();
    await phone.sync.flush();
    const row = [...account.rows.values()].find((r) => r.slot === 0 && r.kind === "state")!;
    expect(row).toMatchObject({ rev: 2, deviceId: "dev-phone-00000000" });
    expect([...row.bytes]).toEqual([7]);
  });

  it("a slot saved on both sides is a conflict with both pictures, and 'Guardar os dois' puts the other one in a free slot", async () => {
    const account = new FakeAccount();
    const pc = await device(account, "dev-pc-0000000000", "computer");
    const phone = await device(account, "dev-phone-00000000", "phone");
    await pc.saveState(2, bytesOf(1), 100);
    await pc.sync.push(2);
    await phone.sync.prepare();
    // both change slot 2 after agreeing
    await pc.saveState(2, bytesOf(2), 300, bytesOf(5));
    await pc.sync.push(2);
    await phone.saveState(2, bytesOf(3), 400, bytesOf(6));
    const conflict = await phone.sync.push(2);
    expect(conflict).toMatchObject({
      slot: 2,
      local: { device: "phone", thumb: bytesOf(6) },
      remote: { device: "computer", thumb: bytesOf(5), entry: { rev: 2 } },
      freeSlot: 1,
    });
    await phone.sync.resolve(conflict!, "both");
    // the phone's stays in 2 and went up over rev 2; the computer's is now slot 1, here and on the account
    expect([...(await phone.store.get(stateKey(GAME, 2)))!.bytes]).toEqual([3]);
    expect([...(await phone.store.get(stateKey(GAME, 1)))!.bytes]).toEqual([2]);
    const onAccount = new Map([...account.rows.values()].filter((r) => r.kind === "state").map((r) => [r.slot, [...r.bytes]]));
    expect(onAccount.get(2)).toEqual([3]);
    // it came in raw, so it goes back up gzipped, the way a state always travels
    expect(onAccount.get(1)?.slice(0, 2)).toEqual([0x1f, 0x8b]);
  });

  it("'Usar o do computador' takes the account's, 'Usar o deste' sends this one over it", async () => {
    const account = new FakeAccount();
    const pc = await device(account, "dev-pc-0000000000", "computer");
    const phone = await device(account, "dev-phone-00000000", "phone");
    await pc.saveState(3, bytesOf(1), 100);
    await pc.sync.push(3);
    await phone.saveState(3, bytesOf(2), 200);
    const first = await phone.sync.push(3);
    expect(first).not.toBeNull();
    await phone.sync.resolve(first!, "remote");
    expect([...(await phone.store.get(stateKey(GAME, 3)))!.bytes]).toEqual([1]);

    await phone.saveState(3, bytesOf(4), 900);
    await pc.saveState(3, bytesOf(5), 950);
    await pc.sync.push(3);
    const second = await phone.sync.push(3);
    await phone.sync.resolve(second!, "local");
    expect([...[...account.rows.values()].find((r) => r.slot === 3)!.bytes]).toEqual([4]);
  });

  it("the battery save is never resolved by itself: both changed is a question before the game boots", async () => {
    const account = new FakeAccount();
    const pc = await device(account, "dev-pc-0000000000", "computer");
    const phone = await device(account, "dev-phone-00000000", "phone");
    await pc.saveSram(bytesOf(1, 1), 100);
    await pc.sync.push("sram");
    await phone.saveSram(bytesOf(2, 2), 200);
    const prepared = await phone.sync.prepare();
    expect(prepared.sramConflict).toMatchObject({ slot: "sram", remote: { device: "computer" }, freeSlot: null });
    // untouched until the person picks
    expect([...(await phone.store.get(sramKey(GAME)))!.bytes]).toEqual([2, 2]);
    await phone.sync.resolve(prepared.sramConflict!, "remote");
    expect([...(await phone.store.get(sramKey(GAME)))!.bytes]).toEqual([1, 1]);
  });

  it("a save deleted from the account is let go of here, not sent back, unless it changed here since", async () => {
    const account = new FakeAccount();
    const phone = await device(account, "dev-phone-00000000", "phone");
    await phone.saveState(4, bytesOf(1), 100);
    await phone.sync.push(4);
    account.rows.clear();
    await phone.sync.prepare();
    await phone.sync.flush();
    expect(account.rows.size).toBe(0);
    expect((await phone.store.get(syncKey(GAME)))).toBeNull();
    // the slot itself stays on this device
    expect(await phone.store.get(stateKey(GAME, 4))).not.toBeNull();
  });

  it("the autosave and the battery save go up at most every 5 minutes, and Ejetar sends what waits", async () => {
    vi.useFakeTimers();
    let clock = 10_000_000;
    const account = new FakeAccount();
    const pc = await device(account, "dev-pc-0000000000", "computer", () => clock);
    await pc.saveState("auto", bytesOf(1), 1);
    pc.sync.onSavesEvent({ type: "autosaved", reason: "timer" });
    await vi.advanceTimersByTimeAsync(10);
    await pc.sync.flush();
    expect(account.puts.length).toBe(1);
    await pc.saveState("auto", bytesOf(2), 2);
    pc.sync.onSavesEvent({ type: "autosaved", reason: "timer" });
    await vi.advanceTimersByTimeAsync(60_000);
    clock += 60_000;
    expect(account.puts.length).toBe(1);
    clock += SYNC_THROTTLE_MS;
    await vi.advanceTimersByTimeAsync(SYNC_THROTTLE_MS);
    // the timer fired; the upload itself hashes with the platform's crypto, which no fake clock drives
    await vi.waitFor(() => expect(account.puts.length).toBe(2));
    await pc.saveSram(bytesOf(3), 3);
    pc.sync.onSavesEvent({ type: "sram-saved", reason: "interval", bytes: 1 });
    await vi.advanceTimersByTimeAsync(10);
    const before = account.puts.length;
    await pc.saveState("auto", bytesOf(4), 4);
    pc.sync.onSavesEvent({ type: "autosaved", reason: "eject" });
    await pc.sync.flush();
    expect(account.puts.length).toBeGreaterThan(before);
    expect([...[...account.rows.values()].find((r) => r.kind === "state" && r.slot === 0)!.bytes]).toEqual([4]);
  });

  it("a slot deleted here goes off the account after the Desfazer window, and Desfazer keeps it", async () => {
    vi.useFakeTimers();
    const account = new FakeAccount();
    const pc = await device(account, "dev-pc-0000000000", "computer");
    await pc.saveState(1, bytesOf(1), 1);
    await pc.saveState(2, bytesOf(2), 1);
    await pc.sync.push(1);
    await pc.sync.push(2);
    await pc.store.delete(stateKey(GAME, 1));
    pc.sync.onSavesEvent({ type: "slot-deleted", slot: 1, undoUntil: 0 });
    pc.sync.onSavesEvent({ type: "slot-deleted", slot: 2, undoUntil: 0 });
    pc.sync.onSavesEvent({ type: "undone", slot: 2 });
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS + 1000);
    await pc.sync.flush();
    expect([...account.rows.values()].map((r) => r.slot)).toEqual([2]);
    expect(account.deletes.length).toBe(1);
  });

  it("clearing the account forgets every agreement here and keeps this device's saves", async () => {
    const account = new FakeAccount();
    const store = durableStore();
    const host = account.view("dev-pc-0000000000", "computer");
    const sync = createSyncAccount(host, store, await host.status());
    const game = sync.forGame({ sha: GAME, platform: "nes", console: () => null });
    await store.put(stateKey(GAME, 1), bytesOf(1), { savedAt: 1, enc: "gzip", core: "fceumm", coreVersion: "4.2.3" });
    await game.push(1);
    expect(sync.usage.used).toBe(1);
    await sync.clearAll();
    expect(account.rows.size).toBe(0);
    expect(await store.get(syncKey(GAME))).toBeNull();
    expect(await store.get(stateKey(GAME, 1))).not.toBeNull();
    expect(sync.usage.used).toBe(0);
  });

  it("never hands the account a key, a title or anything but the save, its picture and its console", async () => {
    const account = new FakeAccount();
    const seen: unknown[] = [];
    const host = account.view("dev-pc-0000000000", "computer");
    const spy: SyncHost = { ...host, put: async (save) => (seen.push(Object.keys(save).sort()), host.put(save)) };
    const store = durableStore();
    const game = createSyncAccount(spy, store, await spy.status()).forGame({ sha: GAME, platform: "gba", console: () => null });
    await store.put(stateKey(GAME, 1), bytesOf(1), { savedAt: 1, enc: "gzip", core: "mgba", coreVersion: "4.2.3" });
    await store.put(thumbKey(GAME, 1), bytesOf(2), { savedAt: 1 });
    await game.push(1);
    expect(seen).toEqual([["baseRev", "bytes", "core", "coreVersion", "game", "kind", "platform", "slot", "thumb"]]);
  });
});
