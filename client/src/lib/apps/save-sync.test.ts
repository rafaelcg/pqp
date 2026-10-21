import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { baseApp, baseSnapshot, rig, type Rig } from "./bridge-host.fixture";
import { createSaveSync, deviceId, deviceKindOf, SaveSyncError, type ApiCall, type SaveSyncClient } from "./save-sync";

/**
 * SAVES NA CONTA, the host half: the key is the account's HMAC of the game's
 * hash and the hash itself never reaches the API; the bytes go to presigned
 * URLs and never through the API; refusals become the bridge's codes; and the
 * bridge host answers `sync.*` for Locadora's player seats only.
 */

const SALT = Buffer.alloc(32, 7);
const SALT64 = SALT.toString("base64url");
const GAME = "ab".repeat(32);
const SESSION = "33333333-3333-4333-8333-333333333333";
const SAVE_ID = "5b7b9f4e-8c0d-4f0a-9d6e-2a1c4d3b8e11";
const ROW = {
  id: SAVE_ID,
  kind: "state",
  slot: 1,
  rev: 3,
  size: 4,
  sha256: "c".repeat(64),
  hasThumb: true,
  platform: "nes",
  core: "fceumm",
  coreVersion: "4.2.3",
  deviceKind: "phone",
  deviceId: "other-device-0000",
  updatedAt: 1000,
  history: 0,
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly details: unknown = null,
  ) {
    super(`api ${status}`);
  }
}

function fakeApi(routes: Record<string, (init?: RequestInit) => unknown>) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api: ApiCall = async (path, init) => {
    calls.push({ path, init });
    const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
    const handler = routes[key];
    if (!handler) throw new ApiError(404);
    return handler(init);
  };
  return { api, calls };
}

function fakeFetch(objects: Map<string, ArrayBuffer>) {
  const calls: Array<{ url: string; method: string }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "PUT") {
      objects.set(url, init!.body as ArrayBuffer);
      return new Response(null, { status: 200 });
    }
    const found = objects.get(url);
    return found ? new Response(found, { status: 200 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const device = { kind: "computer" as const, id: "this-device-00000" };
const keyOf = (game: string) => createHmac("sha256", SALT).update(Buffer.from(game, "hex")).digest("base64url");

describe("deviceKindOf", () => {
  it("names a computer, a phone or a tablet from what the browser says", () => {
    const of = (userAgent: string, maxTouchPoints = 0, mobile?: boolean) =>
      deviceKindOf({ userAgent, maxTouchPoints, ...(mobile === undefined ? {} : { userAgentData: { mobile } }) });
    expect(of("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130")).toBe("computer");
    expect(of("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605")).toBe("computer");
    expect(of("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148")).toBe("phone");
    expect(of("Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/130 Mobile Safari/537")).toBe("phone");
    expect(of("Mozilla/5.0 (Linux; Android 14; SM-X700) Chrome/130 Safari/537")).toBe("tablet");
    expect(of("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605", 5)).toBe("tablet");
    expect(of("anything", 0, true)).toBe("phone");
  });

  it("keeps one random id per browser, and a fresh one when storage is blocked", () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    const first = deviceId(storage);
    expect(first).toMatch(/^[A-Za-z0-9_-]{16,32}$/);
    expect(deviceId(storage)).toBe(first);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(deviceId(blocked)).toMatch(/^[A-Za-z0-9_-]{16,32}$/);
  });
});

describe("createSaveSync", () => {
  const status = () => ({ mode: "on", salt: SALT64, usage: { used: 10, cap: 8 * 1024 * 1024 } });

  it("turns the game's hash into the account's key, and the hash itself never reaches the API", async () => {
    const { api, calls } = fakeApi({
      "GET /api/apps/pqp-locadora/saves/status": status,
      "GET /api/apps/pqp-locadora/saves": () => ({ saves: [ROW] }),
    });
    const sync = createSaveSync({ api, device });
    const entries = await sync.list(SESSION, GAME);
    expect(entries).toEqual([
      expect.objectContaining({ id: SAVE_ID, kind: "state", slot: 1, rev: 3, hash: "c".repeat(64), device: "phone", thisDevice: false, thumb: true }),
    ]);
    const listCall = calls.find((call) => call.path.startsWith("/api/apps/pqp-locadora/saves?"))!;
    expect(listCall.path).toContain(`gameKey=${keyOf(GAME)}`);
    for (const call of calls) {
      expect(call.path).not.toContain(GAME);
      expect(String(call.init?.body ?? "")).not.toContain(GAME);
    }
    // the salt is asked once for the client's life
    await sync.list(SESSION, "cd".repeat(32));
    expect(calls.filter((call) => call.path.includes("/status")).length).toBe(1);
  });

  it("a put asks for the presigned URLs, PUTs the bytes there, never to the API, and commits", async () => {
    const objects = new Map<string, ArrayBuffer>();
    const bucket = fakeFetch(objects);
    let uploadBody: Record<string, unknown> = {};
    const { api, calls } = fakeApi({
      "GET /api/apps/pqp-locadora/saves/status": status,
      "POST /api/apps/pqp-locadora/saves/upload": (init) => {
        uploadBody = JSON.parse(String(init!.body));
        return {
          uploadId: "44444444-4444-4444-8444-444444444444",
          put: { url: "https://bucket.test/state", contentType: "application/octet-stream" },
          thumbPut: { url: "https://bucket.test/thumb", contentType: "image/png" },
        };
      },
      "POST /api/apps/pqp-locadora/saves/uploads/44444444-4444-4444-8444-444444444444/commit": () => ({
        save: { ...ROW, rev: 4, deviceKind: "computer", deviceId: device.id },
        usage: { used: 99, cap: 100 },
      }),
    });
    const sync = createSaveSync({ api, device, fetchImpl: bucket.impl });
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const out = await sync.put(SESSION, {
      game: GAME,
      kind: "state",
      slot: 1,
      baseRev: 3,
      bytes,
      thumb: new Uint8Array([9]).buffer,
      platform: "nes",
      core: "fceumm",
      coreVersion: "4.2.3",
    });
    expect(out).toEqual({ id: SAVE_ID, rev: 4, used: 99, cap: 100 });
    expect(uploadBody).toMatchObject({
      sessionId: SESSION,
      gameKey: keyOf(GAME),
      kind: "state",
      slot: 1,
      baseRev: 3,
      size: 4,
      thumbSize: 1,
      deviceKind: "computer",
      deviceId: device.id,
      // sha256 of 01 02 03 04
      sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
    });
    expect(Object.keys(uploadBody)).not.toContain("bytes");
    expect(bucket.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "PUT https://bucket.test/state",
      "PUT https://bucket.test/thumb",
    ]);
    for (const call of calls) expect(call.init?.body instanceof ArrayBuffer).toBe(false);
  });

  it("reads the API's refusals as the bridge's codes, and a 409 carries what is on the account", async () => {
    const refuse = (status: number, details?: unknown) => () => {
      throw new ApiError(status, details);
    };
    const make = (route: () => unknown) =>
      createSaveSync({
        api: fakeApi({ "GET /api/apps/pqp-locadora/saves/status": status, "POST /api/apps/pqp-locadora/saves/upload": route }).api,
        device,
      });
    const put = (sync: SaveSyncClient) =>
      sync.put(SESSION, { game: GAME, kind: "sram", slot: 0, baseRev: 0, bytes: new ArrayBuffer(2), platform: "gba", core: "mgba", coreVersion: "4.2.3" });
    await expect(put(make(refuse(409, { error: "stale_rev", save: ROW })))).rejects.toMatchObject({ code: "stale", current: expect.objectContaining({ rev: 3 }) });
    await expect(put(make(refuse(409, { error: "stale_rev", save: null })))).rejects.toMatchObject({ code: "stale", current: null });
    await expect(put(make(refuse(413)))).rejects.toMatchObject({ code: "too-large" });
    await expect(put(make(refuse(429)))).rejects.toMatchObject({ code: "rate-limited" });
    await expect(put(make(refuse(404)))).rejects.toMatchObject({ code: "off" });
    await expect(put(make(refuse(500)))).rejects.toMatchObject({ code: "unavailable" });
    // a flag that is off answers the status with a 404 too
    const off = createSaveSync({ api: fakeApi({}).api, device });
    await expect(off.status(SESSION)).rejects.toBeInstanceOf(SaveSyncError);
  });

  it("a get fetches the save and its picture from their presigned URLs", async () => {
    const objects = new Map<string, ArrayBuffer>([
      ["https://bucket.test/s", new Uint8Array([5, 6]).buffer],
      ["https://bucket.test/t", new Uint8Array([7]).buffer],
    ]);
    const { api } = fakeApi({
      [`GET /api/apps/pqp-locadora/saves/${SAVE_ID}/download`]: () => ({ rev: 2, url: "https://bucket.test/s", thumbUrl: "https://bucket.test/t" }),
    });
    const got = await createSaveSync({ api, device, fetchImpl: fakeFetch(objects).impl }).get(SESSION, SAVE_ID);
    expect(got.rev).toBe(2);
    expect([...new Uint8Array(got.bytes)]).toEqual([5, 6]);
    expect([...new Uint8Array(got.thumb!)]).toEqual([7]);
  });
});

describe("the bridge host's sync.*", () => {
  const rigs: Rig[] = [];
  afterEach(() => {
    for (const r of rigs.splice(0)) r.host.detach();
  });

  function stub(overrides: Partial<SaveSyncClient> = {}) {
    const calls: Array<[string, ...unknown[]]> = [];
    const client: SaveSyncClient = {
      status: async (sessionId) => {
        calls.push(["status", sessionId]);
        return { mode: "on", used: 1, cap: 8, device: "computer" };
      },
      list: async (sessionId, game) => {
        calls.push(["list", sessionId, game]);
        return [];
      },
      get: async (sessionId, id) => {
        calls.push(["get", sessionId, id]);
        return { rev: 1, bytes: new Uint8Array([1, 2]).buffer, thumb: null };
      },
      put: async (sessionId, input) => {
        calls.push(["put", sessionId, input.slot]);
        return { id: SAVE_ID, rev: 1, used: 1, cap: 8 };
      },
      remove: async () => ({ used: 0, cap: 8 }),
      restore: async () => ({ id: SAVE_ID, rev: 2 }),
      clear: async () => ({ deleted: 0, used: 0, cap: 8 }),
      ...overrides,
    };
    return { client, calls };
  }

  async function make(options: Parameters<typeof rig>[0]) {
    const r = await rig(options);
    rigs.push(r);
    return r;
  }

  it("answers Locadora with the host's own session id, which no message names", async () => {
    const { client, calls } = stub();
    const r = await make({ app: baseApp({ id: "pqp-locadora" }), host: { saveSync: client } });
    expect(await r.app.call({ type: "sync.status" })).toMatchObject({
      ok: true,
      type: "sync.status",
      result: { mode: "on", used: 1, cap: 8, device: "computer" },
    });
    expect(await r.app.call({ type: "sync.list", game: GAME })).toMatchObject({ ok: true, result: { entries: [] } });
    const got = await r.app.call({ type: "sync.get", save: SAVE_ID });
    expect([...new Uint8Array((got.result as { bytes: ArrayBuffer }).bytes)]).toEqual([1, 2]);
    expect(calls).toEqual([
      ["status", baseSnapshot().sessionId],
      ["list", baseSnapshot().sessionId, GAME],
      ["get", baseSnapshot().sessionId, SAVE_ID],
    ]);
    // a session id in the message is a stray key: refused before anything runs
    expect(await r.app.call({ type: "sync.status", sessionId: SESSION })).toMatchObject({ ok: false, error: "invalid" });
  });

  it("is not-allowed for any other app and for a spectator, without a call", async () => {
    const { client, calls } = stub();
    const other = await make({ app: baseApp({ id: "pqp-eco" }), host: { saveSync: client } });
    expect(await other.app.call({ type: "sync.status" })).toMatchObject({ ok: false, error: "not-allowed" });
    const watcher = await make({
      app: baseApp({ id: "pqp-locadora" }),
      snapshot: baseSnapshot({ role: "spectator", isHost: false }),
      host: { saveSync: client },
    });
    expect(await watcher.app.call({ type: "sync.status" })).toMatchObject({ ok: false, error: "not-allowed" });
    expect(calls).toEqual([]);
  });

  it("maps the client's refusals to the bridge's codes", async () => {
    for (const [code, expected] of [
      ["off", "not-allowed"],
      ["stale", "stale-rev"],
      ["too-large", "too-large"],
      ["rate-limited", "rate-limited"],
      ["unavailable", "unavailable"],
    ] as const) {
      const { client } = stub({
        put: async () => {
          throw new SaveSyncError(code);
        },
      });
      const r = await make({ app: baseApp({ id: "pqp-locadora" }), host: { saveSync: client } });
      const bytes = new ArrayBuffer(4);
      const answer = await r.app.call(
        { type: "sync.put", game: GAME, kind: "state", slot: 1, baseRev: 0, bytes, platform: "nes", core: "fceumm", coreVersion: "4.2.3" },
        [bytes],
      );
      expect(answer, code).toMatchObject({ ok: false, error: expected });
    }
  });
});
