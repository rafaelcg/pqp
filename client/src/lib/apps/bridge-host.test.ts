import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_AVATAR_MAX_CHARS, APP_PARTICIPANTS_AVATAR_BUDGET_CHARS } from "@pqp/shared";
import { cleanDisplayName, fitAvatarBudget, mapTransportError } from "./bridge-host";
import {
  BIA_SEAT,
  BIA_USER,
  PNG_BYTES,
  SELF_SEAT,
  SELF_USER,
  baseApp,
  baseSnapshot,
  pngFetch,
  rig,
  type Rig,
} from "./bridge-host.fixture";
import { AppTransportError } from "./types";

const rigs: Rig[] = [];
async function make(options: Parameters<typeof rig>[0] = {}) {
  const r = await rig(options);
  rigs.push(r);
  return r;
}
afterEach(() => {
  for (const r of rigs.splice(0)) r.host.detach();
  vi.restoreAllMocks();
});

/** Every string and key reachable from a value. */
function walk(value: unknown, out: { keys: string[]; strings: string[] } = { keys: [], strings: [] }) {
  if (typeof value === "string") out.strings.push(value);
  else if (Array.isArray(value)) value.forEach((v) => walk(v, out));
  else if (value && typeof value === "object" && !(value instanceof ArrayBuffer)) {
    for (const [key, v] of Object.entries(value)) {
      out.keys.push(key);
      walk(v, out);
    }
  }
  return out;
}

describe("responses", () => {
  it("a successful answer echoes the request type, so its result is never guessed from its shape", async () => {
    const r = await make();
    expect(await r.app.call({ type: "state.get" })).toMatchObject({ ok: true, type: "state.get" });
    expect(await r.app.call({ type: "participants.get" })).toMatchObject({ ok: true, type: "participants.get" });
    expect(await r.app.call({ type: "events.send", name: "ping", data: 1 })).toMatchObject({ ok: true, type: "events.send", result: null });
    // an error carries no type: there is no result to read
    expect(await r.app.call({ type: "nope" })).not.toHaveProperty("type");
  });
});

describe("fitAvatarBudget", () => {
  const person = (seat: string, avatar: string | null) =>
    ({ seatId: seat, displayName: seat, avatar, role: "player", isHost: false, connection: "present" }) as const;

  it("leaves a roster that fits alone, as the same list", () => {
    const list = [person("a", "data:image/png;base64,AA"), person("b", null)];
    expect(fitAvatarBudget([...list])).toEqual(list);
  });

  it("drops the largest avatars first until the list fits the budget", () => {
    const big = `data:image/png;base64,${"A".repeat(APP_AVATAR_MAX_CHARS - 30)}`;
    const small = "data:image/png;base64,AA";
    // 70 big ones are far past 4 MiB; the small one stays
    const list = [...Array.from({ length: 70 }, (_, i) => person(`big${i}`, big)), person("small", small)];
    const fitted = fitAvatarBudget(list);
    const total = fitted.reduce((sum, p) => sum + (p.avatar?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(APP_PARTICIPANTS_AVATAR_BUDGET_CHARS);
    expect(fitted.at(-1)!.avatar).toBe(small);
    expect(fitted.filter((p) => p.avatar === null).length).toBeGreaterThan(0);
    expect(fitted.map((p) => p.seatId)).toEqual(list.map((p) => p.seatId));
    // nothing about the people changed but the avatar
    expect(fitted[0]).toMatchObject({ displayName: "big0", role: "player" });
  });
});

describe("hello", () => {
  it("carries the seat, the locale, the theme and reduced motion, and no user id", async () => {
    const r = await make();
    const hello = await r.app.hello;
    expect(hello).toMatchObject({
      type: "hello",
      platformApi: 1,
      app: { id: "pqp-eco", version: "1.0.0" },
      locale: "pt-BR",
      reducedMotion: false,
      self: { seatId: SELF_SEAT, role: "player", isHost: true },
      connection: "online",
    });
    expect((hello.theme as Record<string, string>)["--color-text"]).toBe("paper");
    const seen = walk(hello);
    expect(seen.strings).not.toContain(SELF_USER);
  });

  it("falls back to en for a locale the bridge would refuse", async () => {
    const r = await make({ host: { locale: () => "not a locale!" } });
    expect((await r.app.hello).locale).toBe("en");
  });

  it("reports reduced motion", async () => {
    const r = await make();
    r.theme.motion = true;
    const again = await make({ host: {} });
    expect((await again.app.hello).reducedMotion).toBe(false);
    expect((await r.app.hello).reducedMotion).toBe(false); // read at attach, which was before the flip
  });
});

describe("what the app is told about people", () => {
  it("maps participants without a user id, with the avatar as a data URL and appUserId only when present", async () => {
    const r = await make();
    const answer = await r.app.call({ type: "participants.get" });
    expect(answer.ok).toBe(true);
    const list = (answer.result as { participants: Array<Record<string, unknown>> }).participants;
    expect(list).toHaveLength(2);
    const [self, bia] = list;
    expect(self).toEqual({
      seatId: SELF_SEAT,
      displayName: "Raf",
      avatar: null,
      role: "player",
      isHost: true,
      connection: "present",
    });
    expect(bia!.seatId).toBe(BIA_SEAT);
    expect(bia!.avatar).toMatch(/^data:image\/png;base64,/);
    expect(bia!.appUserId).toBe("derived-id-1234567890");
    expect(self).not.toHaveProperty("appUserId");
  });

  it("never lets a pqp user id or a key that could carry one reach the app, in any message it is sent", async () => {
    const r = await make();
    await r.app.call({ type: "participants.get" });
    r.transport.handlers!.onSession(
      baseSnapshot({
        state: { rev: 3, value: { n: 1 } },
        participants: [
          ...baseSnapshot().participants,
          { seatId: "seat-carolcarolcarol", userId: "44444444-4444-4444-8444-444444444444", role: "spectator", isHost: false, connection: "reconnecting" },
        ],
      }),
    );
    r.transport.handlers!.onEvent({ fromSeatId: BIA_SEAT, name: "ping", data: { hi: 1 } });
    r.transport.handlers!.onConnection("reconnecting");
    await r.app.settle();
    const seen = walk([await r.app.hello, ...r.app.pushes, ...r.app.responses.values()]);
    for (const id of [SELF_USER, BIA_USER, "44444444-4444-4444-8444-444444444444"]) {
      expect(seen.strings, id).not.toContain(id);
    }
    for (const key of ["userId", "user_id", "email", "token", "serverId", "channelId", "sessionId"]) {
      expect(seen.keys, key).not.toContain(key);
    }
    // and the pushes did happen
    expect(r.app.pushes.map((p) => p.type)).toEqual(expect.arrayContaining(["participants", "state", "event", "connection"]));
  });

  it("gives an unknown user a placeholder name, and cleans control and bidi characters out of names", () => {
    expect(cleanDisplayName(undefined)).toBe("?");
    expect(cleanDisplayName("  ‮evil‬\u0007 name  ")).toBe("evil name");
    expect(cleanDisplayName("x".repeat(100))).toHaveLength(64);
    expect(cleanDisplayName("\u{1F600}".repeat(40)).length).toBeLessThanOrEqual(64);
  });

  it("takes no avatar that is not a small png, jpeg, webp or gif", async () => {
    const svg = await make({ host: { fetchImpl: pngFetch("image/svg+xml") } });
    const list = (await svg.app.call({ type: "participants.get" })).result as { participants: Array<{ avatar: unknown }> };
    expect(list.participants.every((p) => p.avatar === null)).toBe(true);

    const huge = await make({ host: { fetchImpl: pngFetch("image/png", new Uint8Array(APP_AVATAR_MAX_CHARS)) } });
    const big = (await huge.app.call({ type: "participants.get" })).result as { participants: Array<{ avatar: unknown }> };
    expect(big.participants.every((p) => p.avatar === null)).toBe(true);

    const broken = await make({
      host: { fetchImpl: (async () => new Response("no", { status: 404 })) as typeof fetch },
    });
    const none = (await broken.app.call({ type: "participants.get" })).result as { participants: Array<{ avatar: unknown }> };
    expect(none.participants.every((p) => p.avatar === null)).toBe(true);
  });

  it("fetches an avatar once, however many pushes follow", async () => {
    const fetchImpl = vi.fn(pngFetch());
    const r = await make({ host: { fetchImpl } });
    await r.app.call({ type: "participants.get" });
    r.transport.handlers!.onSession(baseSnapshot({ state: { rev: 1, value: null } }));
    r.transport.handlers!.onSession(baseSnapshot({ state: { rev: 2, value: null } }));
    await r.app.settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("pushes participants when the roster changes and not when it does not", async () => {
    const r = await make();
    await r.app.call({ type: "participants.get" });
    r.app.pushes.length = 0;
    r.transport.handlers!.onSession(baseSnapshot()); // same people
    await r.app.settle();
    expect(r.app.pushes.filter((p) => p.type === "participants")).toHaveLength(0);
    r.transport.handlers!.onSession(
      baseSnapshot({ participants: baseSnapshot().participants.map((p) => ({ ...p, connection: "reconnecting" as const })) }),
    );
    await r.app.settle();
    const pushes = r.app.pushes.filter((p) => p.type === "participants");
    expect(pushes).toHaveLength(1);
    expect((pushes[0]!.participants as Array<{ connection: string }>).every((p) => p.connection === "reconnecting")).toBe(true);
  });
});

describe("messages from the app", () => {
  it("answers a message that fails the strict schema with invalid", async () => {
    const r = await make();
    for (const bad of [
      { type: "state.get", extra: 1 },
      { type: "nope" },
      { type: "state.patch" },
      { type: "events.send", name: "Not Valid", data: 1 },
      { type: "ui.resize", height: 5 },
      { type: "assets.get", name: "../x" },
    ]) {
      const answer = await r.app.call({ id: "x1", ...bad });
      expect(answer, JSON.stringify(bad)).toMatchObject({ id: "x1", ok: false, error: "invalid" });
    }
  });

  it("answers an oversize message (past the hard cap) with invalid, and drops one with no usable id", async () => {
    const r = await make();
    const big = await r.app.call({ type: "state.patch", patch: { blob: "x".repeat(20000) } });
    expect(big).toMatchObject({ ok: false, error: "invalid" });
    r.app.port.postMessage({ type: "state.get", extra: true }); // no id
    r.app.port.postMessage({ id: "y".repeat(40), type: "nope" }); // id too long to be an id
    r.app.port.postMessage("hello");
    r.app.port.postMessage(null);
    await r.app.settle();
    expect(r.app.responses.size).toBe(0);
  });

  it("answers a state.get with the current revision and value", async () => {
    const r = await make();
    r.transport.handlers!.onState(4, { n: 4 });
    await r.app.settle();
    expect(await r.app.call({ type: "state.get" })).toMatchObject({ ok: true, result: { rev: 4, value: { n: 4 } } });
  });

  it("ignores a state push with an older or equal revision", async () => {
    const r = await make();
    r.transport.handlers!.onState(5, { n: 5 });
    r.transport.handlers!.onState(4, { n: 4 });
    r.transport.handlers!.onState(5, { n: 99 });
    await r.app.settle();
    expect(r.app.pushes.filter((p) => p.type === "state")).toHaveLength(1);
    expect(await r.app.call({ type: "state.get" })).toMatchObject({ result: { rev: 5, value: { n: 5 } } });
  });
});

describe("state.patch", () => {
  it("forwards a patch and answers with the revision the server gave", async () => {
    const r = await make();
    const answer = await r.app.call({ type: "state.patch", patch: { n: 1 }, baseRev: 0 });
    expect(answer).toMatchObject({ ok: true, result: { rev: 1 } });
    expect(r.transport.patches).toEqual([{ patch: { n: 1 }, baseRev: 0 }]);
  });

  it("refuses a patch that would push the state past the manifest's cap, counting the merged state", async () => {
    const r = await make(); // state cap is 64 bytes in the fixture
    expect(await r.app.call({ type: "state.patch", patch: { text: "x".repeat(80) } })).toMatchObject({ ok: false, error: "too-large" });
    // a small patch on top of a big state is measured after the merge
    r.transport.handlers!.onState(2, { text: "y".repeat(50) });
    await r.app.settle();
    expect(await r.app.call({ type: "state.patch", patch: { more: "z".repeat(30) } })).toMatchObject({ error: "too-large" });
    // deleting a key makes room
    expect(await r.app.call({ type: "state.patch", patch: { text: null, more: "z".repeat(30) } })).toMatchObject({ ok: true });
    expect(r.transport.patches).toHaveLength(1);
  });

  it("refuses a non-host writer when the manifest says only the host writes", async () => {
    const r = await make({
      app: { state: { maxBytes: 64, writers: "host" } },
      snapshot: baseSnapshot({ isHost: false }),
    });
    expect(await r.app.call({ type: "state.patch", patch: { n: 1 } })).toMatchObject({ ok: false, error: "not-host" });
    expect(r.transport.patches).toHaveLength(0);
  });

  it("rate limits writes to the manifest's rate", async () => {
    let clock = 1000;
    const r = await make({ app: { state: { maxBytes: 4096, maxWritesPerSecond: 2 } }, now: () => clock });
    const results: unknown[] = [];
    for (let i = 0; i < 4; i += 1) results.push((await r.app.call({ type: "state.patch", patch: { i } })).ok);
    expect(results).toEqual([true, true, false, false]);
    clock += 1000;
    expect(await r.app.call({ type: "state.patch", patch: { i: 9 } })).toMatchObject({ ok: true });
  });

  it("maps the transport's refusals to bridge errors", async () => {
    const r = await make();
    for (const [code, expected] of [
      ["stale-rev", "stale-rev"],
      ["rate-limited", "rate-limited"],
      ["too-large", "too-large"],
      ["not-allowed", "not-allowed"],
      ["ended", "ended"],
      ["full", "unavailable"],
      ["unavailable", "unavailable"],
    ] as const) {
      r.transport.patchError = new AppTransportError(code);
      expect(await r.app.call({ type: "state.patch", patch: { n: 1 } }), code).toMatchObject({ ok: false, error: expected });
    }
    r.transport.patchError = new Error("socket exploded");
    expect(await r.app.call({ type: "state.patch", patch: { n: 1 } })).toMatchObject({ error: "unavailable" });
    expect(mapTransportError("not-allowed", true)).toBe("not-host");
  });
});

describe("events.send", () => {
  it("sends the event, answers null, and holds the manifest's byte cap", async () => {
    const r = await make();
    expect(await r.app.call({ type: "events.send", name: "ping", data: { a: 1 } })).toMatchObject({ ok: true, result: null });
    expect(r.transport.events).toEqual([{ name: "ping", data: { a: 1 } }]);
    expect(await r.app.call({ type: "events.send", name: "ping", data: "x".repeat(40) })).toMatchObject({ ok: false, error: "too-large" });
    expect(r.transport.events).toHaveLength(1);
  });

  it("rate limits to the manifest's events per second", async () => {
    let clock = 5000;
    const r = await make({ now: () => clock }); // 5 a second in the fixture
    const ok: boolean[] = [];
    for (let i = 0; i < 8; i += 1) ok.push((await r.app.call({ type: "events.send", name: "ping", data: i })).ok as boolean);
    expect(ok).toEqual([true, true, true, true, true, false, false, false]);
    clock += 400;
    expect(await r.app.call({ type: "events.send", name: "ping", data: 1 })).toMatchObject({ ok: true });
  });

  it("is not allowed at all when the manifest gives no events", async () => {
    const r = await make({ app: { events: { maxPerSecond: 0, maxBytes: 0 } } });
    expect(await r.app.call({ type: "events.send", name: "ping", data: 1 })).toMatchObject({ error: "not-allowed" });
  });

  it("relays events from others as pushes", async () => {
    const r = await make();
    r.transport.handlers!.onEvent({ fromSeatId: BIA_SEAT, name: "ping", data: { who: "Bia" } });
    await r.app.settle();
    expect(r.app.pushes.find((p) => p.type === "event")).toEqual({
      type: "event",
      fromSeatId: BIA_SEAT,
      name: "ping",
      data: { who: "Bia" },
    });
  });
});

describe("capabilities", () => {
  it("share.request needs a pane app on a server that allows sharing", async () => {
    const none = await make();
    expect(await none.app.call({ type: "share.request", on: true })).toMatchObject({ error: "not-allowed" });

    const paneButNotAllowed = await make({ app: { capabilities: { share: "pane", localFiles: { allowed: false } }, shareAllowed: false } });
    expect(await paneButNotAllowed.app.call({ type: "share.request", on: true })).toMatchObject({ error: "not-allowed" });

    const share = vi.fn(async (on: boolean) => on);
    const allowed = await make({
      app: { capabilities: { share: "pane", localFiles: { allowed: false } }, shareAllowed: true },
      host: { ui: { share } },
    });
    expect(await allowed.app.call({ type: "share.request", on: true })).toMatchObject({ ok: true, result: { on: true } });
    expect(share).toHaveBeenCalledWith(true);

    const noFlow = await make({ app: { capabilities: { share: "pane", localFiles: { allowed: false } }, shareAllowed: true } });
    expect(await noFlow.app.call({ type: "share.request", on: true })).toMatchObject({ error: "unavailable" });
  });

  it("ui.fullscreen needs the page to offer it, and ui.resize reaches the page", async () => {
    const resize = vi.fn();
    const r = await make({ host: { ui: { resize } } });
    expect(await r.app.call({ type: "ui.resize", height: 480 })).toMatchObject({ ok: true, result: { height: 480 } });
    expect(resize).toHaveBeenCalledWith(480);
    expect(await r.app.call({ type: "ui.fullscreen", on: true })).toMatchObject({ error: "not-allowed" });
    const fullscreen = vi.fn(async (on: boolean) => on);
    const withFs = await make({ host: { ui: { fullscreen } } });
    expect(await withFs.app.call({ type: "ui.fullscreen", on: true })).toMatchObject({ ok: true, result: { on: true } });
  });

  it("session.end is for the host", async () => {
    const guest = await make({ snapshot: baseSnapshot({ isHost: false }) });
    expect(await guest.app.call({ type: "session.end" })).toMatchObject({ error: "not-host" });
    expect(guest.transport.endCalls).toBe(0);

    const host = await make();
    expect(await host.app.call({ type: "session.end" })).toMatchObject({ ok: true, result: null });
    expect(host.transport.endCalls).toBe(1);
    host.transport.endError = new AppTransportError("not-allowed");
    expect(await host.app.call({ type: "session.end" })).toMatchObject({ error: "not-host" });
  });
});

describe("files.pickLocal", () => {
  const files = { allowed: true as const, accept: [".gba", ".nes"], maxBytes: 1024 };

  it("is refused when the manifest allows no files", async () => {
    const pickFile = vi.fn();
    const r = await make({ host: { pickFile } });
    expect(await r.app.call({ type: "files.pickLocal" })).toMatchObject({ error: "not-allowed" });
    expect(pickFile).not.toHaveBeenCalled();
  });

  it("opens the picker with the manifest's accept list and cap, and answers bytes and an extension, never a name", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const pickFile = vi.fn(async () => ({ kind: "picked" as const, bytes, ext: ".gba" }));
    const r = await make({ app: { capabilities: { share: "none", localFiles: files } }, host: { pickFile } });
    const answer = await r.app.call({ type: "files.pickLocal" });
    expect(pickFile).toHaveBeenCalledWith(expect.objectContaining({ accept: [".gba", ".nes"], maxBytes: 1024 }));
    expect(answer.ok).toBe(true);
    const result = answer.result as { bytes: ArrayBuffer; ext: string };
    expect(Object.keys(result).sort()).toEqual(["bytes", "ext"]);
    expect(result.ext).toBe(".gba");
    expect(Array.from(new Uint8Array(result.bytes))).toEqual([1, 2, 3]);
  });

  it("answers cancelled, too-large and not-allowed for the other outcomes", async () => {
    const outcomes = [
      [{ kind: "cancelled" as const }, "cancelled"],
      [{ kind: "too-large" as const }, "too-large"],
      [{ kind: "wrong-type" as const }, "not-allowed"],
    ] as const;
    for (const [outcome, error] of outcomes) {
      const r = await make({
        app: { capabilities: { share: "none", localFiles: files } },
        host: { pickFile: async () => outcome },
      });
      expect(await r.app.call({ type: "files.pickLocal" }), error).toMatchObject({ ok: false, error });
    }
  });

  it("allows one picker at a time", async () => {
    let release!: () => void;
    const pickFile = () =>
      new Promise<{ kind: "cancelled" }>((resolve) => {
        release = () => resolve({ kind: "cancelled" });
      });
    const r = await make({ app: { capabilities: { share: "none", localFiles: files } }, host: { pickFile } });
    const first = r.app.call({ type: "files.pickLocal" });
    await r.app.settle();
    expect(await r.app.call({ type: "files.pickLocal" })).toMatchObject({ error: "rate-limited" });
    release();
    expect(await first).toMatchObject({ error: "cancelled" });
  });
});

describe("assets.get", () => {
  const body: Uint8Array<ArrayBuffer> = new Uint8Array([10, 20, 30, 40]);
  async function sha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  const asset = async () => ({ name: "core.wasm", url: "http://localhost:5175/pqp-eco/1.0.0/core.wasm", sha256: await sha256(body), bytes: 4 });

  it("fetches with force-cache, checks size and hash, and transfers a copy each time", async () => {
    const assetFetches: Array<string | undefined> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (!String(url).endsWith("core.wasm")) return new Response("no", { status: 404 }); // an avatar
      assetFetches.push(init?.cache);
      return new Response(body as BodyInit);
    }) as unknown as typeof fetch;
    const r = await make({ app: { assets: [await asset()] }, host: { fetchImpl } });
    const first = await r.app.call({ type: "assets.get", name: "core.wasm" });
    expect(first).toMatchObject({ ok: true, result: { name: "core.wasm" } });
    expect(Array.from(new Uint8Array((first.result as { bytes: ArrayBuffer }).bytes))).toEqual([10, 20, 30, 40]);
    const second = await r.app.call({ type: "assets.get", name: "core.wasm" });
    expect(Array.from(new Uint8Array((second.result as { bytes: ArrayBuffer }).bytes))).toEqual([10, 20, 30, 40]);
    expect(assetFetches).toEqual(["force-cache"]);
  });

  it("answers unavailable on a hash mismatch, a wrong size or a failed fetch, and logs each asset once", async () => {
    const wrongBytes = new Uint8Array([9, 9, 9, 9]);
    const mismatch = await make({
      app: { assets: [await asset()] },
      host: { fetchImpl: (async () => new Response(wrongBytes as BodyInit)) as typeof fetch },
    });
    expect(await mismatch.app.call({ type: "assets.get", name: "core.wasm" })).toMatchObject({ ok: false, error: "unavailable" });
    expect(await mismatch.app.call({ type: "assets.get", name: "core.wasm" })).toMatchObject({ error: "unavailable" });
    expect(mismatch.logs.filter((l) => l.message.includes("core.wasm"))).toHaveLength(1);
    expect(mismatch.logs[0]!.message).toContain("hash");

    const short = await make({
      app: { assets: [await asset()] },
      host: { fetchImpl: (async () => new Response(new Uint8Array([1]) as BodyInit)) as typeof fetch },
    });
    expect(await short.app.call({ type: "assets.get", name: "core.wasm" })).toMatchObject({ error: "unavailable" });
    expect(short.logs[0]!.message).toContain("size");

    const down = await make({
      app: { assets: [await asset()] },
      host: { fetchImpl: (async () => new Response("no", { status: 503 })) as typeof fetch },
    });
    expect(await down.app.call({ type: "assets.get", name: "core.wasm" })).toMatchObject({ error: "unavailable" });
  });

  it("refuses a name that is not in the manifest", async () => {
    const r = await make({ app: { assets: [await asset()] } });
    expect(await r.app.call({ type: "assets.get", name: "other.wasm" })).toMatchObject({ error: "invalid" });
  });
});

describe("connection, theme and the end", () => {
  it("pushes connection changes and refuses writes while reconnecting", async () => {
    const r = await make();
    r.transport.handlers!.onConnection("reconnecting");
    await r.app.settle();
    expect(r.app.pushes.find((p) => p.type === "connection")).toEqual({ type: "connection", status: "reconnecting" });
    expect(await r.app.call({ type: "state.patch", patch: { n: 1 } })).toMatchObject({ error: "unavailable" });
    expect(await r.app.call({ type: "events.send", name: "ping", data: 1 })).toMatchObject({ error: "unavailable" });
    expect(await r.app.call({ type: "state.get" })).toMatchObject({ ok: true }); // reads keep working
    r.transport.handlers!.onConnection("online");
    expect(await r.app.call({ type: "state.patch", patch: { n: 1 } })).toMatchObject({ ok: true });
  });

  it("pushes the theme again when it changes, and only then", async () => {
    const r = await make();
    r.theme.listener!();
    await r.app.settle();
    expect(r.app.pushes.filter((p) => p.type === "theme")).toHaveLength(0);
    r.theme.theme = { "--color-text": "ink", "--pqp-color-scheme": "light" };
    r.theme.listener!();
    await r.app.settle();
    expect(r.app.pushes.find((p) => p.type === "theme")).toEqual({
      type: "theme",
      theme: { "--color-text": "ink", "--pqp-color-scheme": "light" },
    });
  });

  it("session end pushes session.ended, tells the page, and every later call is answered ended", async () => {
    const r = await make();
    r.transport.handlers!.onEnded("host");
    await r.app.settle();
    expect(r.app.pushes.find((p) => p.type === "session.ended")).toEqual({ type: "session.ended", reason: "host" });
    expect(r.ended).toEqual(["host"]);
    expect(await r.app.call({ type: "state.get" })).toMatchObject({ ok: false, error: "ended" });
    expect(await r.app.call({ type: "events.send", name: "ping", data: 1 })).toMatchObject({ error: "ended" });
    r.host.leave();
    expect(r.transport.left).toBe(0); // nothing to leave
  });

  it("leave releases the seat of a live session", async () => {
    const r = await make();
    r.host.leave();
    expect(r.transport.left).toBe(1);
  });
});

describe("a flood", () => {
  it("is answered rate-limited without parsing, and reported when it keeps going", async () => {
    const r = await make({ now: () => 0 });
    // 200 are free (the burst), the rest are refused
    const answers = await Promise.all(
      Array.from({ length: 800 }, (_, i) => r.app.call({ id: `f${i}`, type: "state.get" })),
    );
    expect(answers.filter((a) => a.ok === true).length).toBe(200);
    expect(answers.filter((a) => a.error === "rate-limited").length).toBe(600);
    expect(r.violations).toEqual(["flood"]);
  });
});

describe("join", () => {
  it("rejects start with the transport's error and does not stay subscribed", async () => {
    const { BridgeHost } = await import("./bridge-host");
    const { FakeTransport, users } = await import("./bridge-host.fixture");
    const transport = new FakeTransport();
    transport.joinError = new AppTransportError("full");
    const host = new BridgeHost({ app: baseApp(), transport, users, locale: () => "en" });
    await expect(host.start()).rejects.toMatchObject({ code: "full" });
    expect(transport.handlers).toBeNull();
    host.detach();
  });

  it("does not send hello before the seat exists", async () => {
    const { BridgeHost } = await import("./bridge-host");
    const { FakeTransport, FakeTheme, users } = await import("./bridge-host.fixture");
    const host = new BridgeHost({ app: baseApp(), transport: new FakeTransport(), users, locale: () => "en", theme: new FakeTheme() });
    const channel = new MessageChannel();
    const received: unknown[] = [];
    channel.port2.onmessage = (event: MessageEvent) => received.push(event.data);
    host.attach(channel.port1); // not started: no snapshot, no hello
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(received).toEqual([]);
    host.detach();
    channel.port2.close();
    expect(PNG_BYTES.length).toBeGreaterThan(0);
  });
});
