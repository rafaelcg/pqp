import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectWithSync, type PqpApp, type SyncApi } from "./index.js";
import { FakeHost, HELLO } from "./fake-host.fixture.js";

/**
 * `connectWithSync`: the same handshake as `connect` (the port only from the
 * parent), the same app, plus the `sync.*` calls on that port. The save is
 * named `save` on the wire, never `id`, which is the request's own.
 */

let host: FakeHost;
let app: PqpApp;
let sync: SyncApi;

beforeEach(async () => {
  host = new FakeHost();
  const pending = connectWithSync({ window: host.window, timeoutMs: 400 });
  host.accept();
  ({ app, sync } = await pending);
});
afterEach(() => {
  host.close();
});

async function exchange<T>(call: () => Promise<T>, answer: (request: Awaited<ReturnType<FakeHost["nextRequest"]>>) => void) {
  const result = call();
  answer(await host.nextRequest());
  return result;
}

describe("connectWithSync", () => {
  it("hands back the app of the handshake, hello and all", () => {
    expect(app.hello).toEqual(HELLO);
    expect(app.connection).toBe("online");
  });

  it("refuses a port from anybody but the parent", async () => {
    const other = new FakeHost();
    const pending = connectWithSync({ window: other.window, timeoutMs: 100 });
    const stray = new MessageChannel();
    other.deliver({ pqp: "app-port", platformApi: 1 }, { source: { postMessage() {} }, ports: [stray.port2] });
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    other.close();
    stray.port1.close();
  });

  it("sync.status and sync.list read the host's answer", async () => {
    expect(
      await exchange(
        () => sync.status(),
        (r) => host.respond(r.id, { mode: "on", used: 3, cap: 8, device: "phone" }),
      ),
    ).toEqual({ mode: "on", used: 3, cap: 8, device: "phone" });
    const entries = await exchange(
      () => sync.list("a".repeat(64)),
      (r) => {
        expect(r).toMatchObject({ type: "sync.list", game: "a".repeat(64) });
        host.respond(r.id, { entries: [{ id: "x", slot: 0 }] });
      },
    );
    expect(entries).toEqual([{ id: "x", slot: 0 }]);
  });

  it("sync.put sends a copy of the bytes and the picture, and nothing else", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const out = await exchange(
      () =>
        sync.put({ game: "b".repeat(64), kind: "state", slot: 2, baseRev: 4, bytes, thumb: new Uint8Array([9]), platform: "nes", core: "fceumm", coreVersion: "4.2.3" }),
      (r) => {
        expect(Object.keys(r).sort()).toEqual(["baseRev", "bytes", "core", "coreVersion", "game", "id", "kind", "platform", "slot", "thumb", "type"].sort());
        expect(Array.from(new Uint8Array(r.bytes as ArrayBuffer))).toEqual([1, 2, 3]);
        host.respond(r.id, { id: "s", rev: 5, used: 10, cap: 20 });
      },
    );
    expect(out).toEqual({ id: "s", rev: 5, used: 10, cap: 20 });
    expect(bytes.byteLength).toBe(3);
  });

  it("sync.get, sync.delete and sync.restore name the save `save`, and a null picture stays null", async () => {
    const got = await exchange(
      () => sync.get("save-id"),
      (r) => {
        expect(r).toMatchObject({ type: "sync.get", save: "save-id" });
        expect(r.id).not.toBe("save-id");
        host.respond(r.id, { rev: 2, bytes: new ArrayBuffer(4), thumb: null });
      },
    );
    expect(got.thumb).toBeNull();
    await exchange(
      () => sync.delete("save-id"),
      (r) => {
        expect(r).toMatchObject({ type: "sync.delete", save: "save-id" });
        host.respond(r.id, { used: 0, cap: 8 });
      },
    );
    await exchange(
      () => sync.restore("save-id", 3),
      (r) => {
        expect(r).toMatchObject({ type: "sync.restore", save: "save-id", baseRev: 3 });
        host.respond(r.id, { id: "save-id", rev: 4 });
      },
    );
  });

  it("sync.clear sends no game for the whole account", async () => {
    await exchange(
      () => sync.clear(),
      (r) => {
        expect(r).not.toHaveProperty("game");
        host.respond(r.id, { deleted: 2, used: 0, cap: 8 });
      },
    );
  });
});
