import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bridgeAppHelloSchema,
  bridgeAppMessageSchema,
  bridgeAppPortSchema,
  bridgeHostMessageSchema,
  bridgeResultSchemas,
} from "./bridge.js";
import { APP_END_REASONS, jsonProblem } from "./common.js";
import {
  APP_AVATAR_MAX_CHARS,
  APP_MAX_PARTICIPANTS,
  APP_PARTICIPANTS_AVATAR_BUDGET_CHARS,
} from "./limits.js";
import {
  APP_EVENT_MAX_BYTES,
  APP_EVENT_MAX_PER_SECOND,
  APP_PLATFORM_API,
  APP_STATE_MAX_BYTES,
  APP_STATE_MAX_WRITES_PER_SECOND,
} from "./manifest.js";

const SEAT = "seat_AAAAAAAAAAAAAAAA"; // 21 chars, in the alphabet
const SEAT_2 = "seat-BBBBBBBBBBBBBBBB";
const AVATAR = "data:image/png;base64,iVBORw0KGgo=";

describe("caps", () => {
  it("pins the numbers the manifest also states", () => {
    expect(APP_PLATFORM_API).toBe(1);
    expect(APP_STATE_MAX_BYTES).toBe(16384);
    expect(APP_EVENT_MAX_BYTES).toBe(1024);
    expect(APP_EVENT_MAX_PER_SECOND).toBe(20);
    expect(APP_STATE_MAX_WRITES_PER_SECOND).toBe(10);
  });
});

describe("handshake", () => {
  it("accepts app-hello and app-port", () => {
    expect(bridgeAppHelloSchema.safeParse({ pqp: "app-hello", platformApi: 1 }).success).toBe(true);
    expect(bridgeAppPortSchema.safeParse({ pqp: "app-port", platformApi: 1 }).success).toBe(true);
  });

  it("answers files.pickLocal with bytes and a closed-list extension, never a name", () => {
    const schema = bridgeResultSchemas["files.pickLocal"];
    const bytes = new ArrayBuffer(1);
    expect(schema.safeParse({ bytes, ext: ".gba" }).success).toBe(true);
    expect(schema.safeParse({ bytes }).success).toBe(false);
    expect(schema.safeParse({ bytes, ext: "gba" }).success).toBe(false);
    expect(schema.safeParse({ bytes, ext: ".GBA" }).success).toBe(false);
    expect(schema.safeParse({ bytes, ext: "mario.gba" }).success).toBe(false);
    // a stray key is stripped, so a file name cannot ride along
    expect(schema.parse({ bytes, ext: ".gba", name: "x.gba" })).not.toHaveProperty("name");
  });

  it("rejects unknown keys and a platform api the host does not speak", () => {
    expect(
      bridgeAppHelloSchema.safeParse({ pqp: "app-hello", platformApi: 1, x: 1 }).success,
    ).toBe(false);
    expect(bridgeAppPortSchema.safeParse({ pqp: "app-port", platformApi: 2 }).success).toBe(false);
    expect(bridgeAppHelloSchema.safeParse({ pqp: "app-hello", platformApi: 0 }).success).toBe(
      false,
    );
    expect(bridgeAppHelloSchema.safeParse({ pqp: "other", platformApi: 1 }).success).toBe(false);
  });
});

/** One minimal valid example of every app to host request. */
const requests: Record<string, Record<string, unknown>> = {
  "participants.get": {},
  "state.get": {},
  "state.patch": { patch: { score: 3, old: null } },
  "events.send": { name: "ping", data: { x: 1 } },
  "assets.get": { name: "core.wasm" },
  "files.pickLocal": {},
  "store.get": { key: "rom:abc" },
  "store.put": { key: "sram:abc", bytes: new ArrayBuffer(4), meta: { slot: 1 } },
  "store.delete": { key: "rom:abc" },
  "store.list": { prefix: "state:abc:" },
  "store.usage": {},
  "files.saveLocal": { bytes: new ArrayBuffer(4), ext: ".locadora" },
  "sync.status": {},
  "sync.list": { game: "a".repeat(64) },
  "sync.get": { save: "5b7b9f4e-8c0d-4f0a-9d6e-2a1c4d3b8e11" },
  "sync.put": {
    game: "a".repeat(64),
    kind: "state",
    slot: 1,
    baseRev: 0,
    bytes: new ArrayBuffer(4),
    thumb: new ArrayBuffer(2),
    platform: "nes",
    core: "fceumm",
    coreVersion: "4.2.3",
  },
  "sync.delete": { save: "5b7b9f4e-8c0d-4f0a-9d6e-2a1c4d3b8e11" },
  "sync.restore": { save: "5b7b9f4e-8c0d-4f0a-9d6e-2a1c4d3b8e11", baseRev: 2 },
  "sync.clear": {},
  "ui.resize": { height: 480 },
  "ui.fullscreen": { on: true },
  "share.request": { on: false },
  "session.end": {},
};

function req(type: string, extra: Record<string, unknown> = {}) {
  return { id: "r1", type, ...requests[type], ...extra };
}

describe("app to host requests", () => {
  it("sync.put carries a save, never a game: no name, no extra field, at most 1 MiB and a 16 KiB picture", () => {
    expect(bridgeAppMessageSchema.safeParse(req("sync.put", { name: "game.gba" })).success).toBe(false);
    expect(bridgeAppMessageSchema.safeParse(req("sync.put", { bytes: new ArrayBuffer(1024 * 1024 + 1) })).success).toBe(false);
    expect(bridgeAppMessageSchema.safeParse(req("sync.put", { thumb: new ArrayBuffer(16 * 1024 + 1) })).success).toBe(false);
    expect(bridgeAppMessageSchema.safeParse(req("sync.put", { game: "not-a-hash" })).success).toBe(false);
    expect(bridgeAppMessageSchema.safeParse(req("sync.put", { slot: 5 })).success).toBe(false);
    expect(bridgeAppMessageSchema.safeParse(req("sync.put", { kind: "rom" })).success).toBe(false);
    expect(bridgeAppMessageSchema.safeParse(req("sync.clear", { game: "a".repeat(64) })).success).toBe(true);
    // the save is named `save`: `id` is the request's own and cannot carry it
    expect(bridgeAppMessageSchema.safeParse({ id: "r1", type: "sync.get" }).success).toBe(false);
  });

  it.each(Object.keys(requests))("accepts %s", (type) => {
    expect(bridgeAppMessageSchema.safeParse(req(type)).success).toBe(true);
  });

  it("accepts state.patch with baseRev and any JSON patch value", () => {
    expect(bridgeAppMessageSchema.safeParse(req("state.patch", { baseRev: 0 })).success).toBe(true);
    expect(
      bridgeAppMessageSchema.safeParse({ id: "r", type: "state.patch", patch: [1, 2] }).success,
    ).toBe(true);
    expect(
      bridgeAppMessageSchema.safeParse({ id: "r", type: "state.patch", patch: null }).success,
    ).toBe(true);
  });

  it("rejects an unknown type", () => {
    expect(bridgeAppMessageSchema.safeParse({ id: "r", type: "net.fetch" }).success).toBe(false);
    expect(bridgeAppMessageSchema.safeParse({ id: "r" }).success).toBe(false);
  });

  it.each(Object.keys(requests))("rejects an unknown extra key on %s", (type) => {
    expect(bridgeAppMessageSchema.safeParse(req(type, { extra: 1 })).success).toBe(false);
  });

  it.each(["userId", "user_id", "channelId", "serverId", "token", "email"])(
    "rejects a request carrying %s",
    (key) => {
      expect(bridgeAppMessageSchema.safeParse(req("state.get", { [key]: "x" })).success).toBe(
        false,
      );
    },
  );

  it("bounds the request id", () => {
    expect(bridgeAppMessageSchema.safeParse(req("state.get", { id: "" })).success).toBe(false);
    expect(bridgeAppMessageSchema.safeParse(req("state.get", { id: "a".repeat(32) })).success).toBe(
      true,
    );
    expect(bridgeAppMessageSchema.safeParse(req("state.get", { id: "a".repeat(33) })).success).toBe(
      false,
    );
    expect(bridgeAppMessageSchema.safeParse(req("state.get", { id: 7 })).success).toBe(false);
  });

  it("rejects an oversize state patch at 16385 bytes and accepts exactly 16384", () => {
    // {"a":"..."} is 8 bytes of framing around the string
    const exact = { a: "x".repeat(APP_STATE_MAX_BYTES - 8) };
    expect(JSON.stringify(exact).length).toBe(APP_STATE_MAX_BYTES);
    expect(bridgeAppMessageSchema.safeParse(req("state.patch", { patch: exact })).success).toBe(
      true,
    );
    const over = { a: "x".repeat(APP_STATE_MAX_BYTES - 7) };
    expect(JSON.stringify(over).length).toBe(APP_STATE_MAX_BYTES + 1);
    expect(bridgeAppMessageSchema.safeParse(req("state.patch", { patch: over })).success).toBe(
      false,
    );
  });

  it("accepts values that fit exactly, whatever their shape", () => {
    const exactArray = ["x".repeat(APP_EVENT_MAX_BYTES - 4)];
    expect(JSON.stringify(exactArray).length).toBe(APP_EVENT_MAX_BYTES);
    expect(bridgeAppMessageSchema.safeParse(req("events.send", { data: exactArray })).success).toBe(
      true,
    );
    // 511 ones is 1023 bytes with brackets and commas, the last one widened to 11 makes 1024
    const numbers: number[] = Array.from({ length: 511 }, () => 1);
    numbers[510] = 11;
    expect(JSON.stringify(numbers).length).toBe(APP_EVENT_MAX_BYTES);
    expect(bridgeAppMessageSchema.safeParse(req("events.send", { data: numbers })).success).toBe(
      true,
    );
    const over = [...numbers, 1];
    expect(JSON.stringify(over).length).toBeGreaterThan(APP_EVENT_MAX_BYTES);
    expect(bridgeAppMessageSchema.safeParse(req("events.send", { data: over })).success).toBe(
      false,
    );
  });

  it("counts UTF-8 bytes, not characters", () => {
    // each "é" is 2 bytes: 8192 of them is 16384 bytes plus framing
    const wide = { a: "é".repeat(APP_STATE_MAX_BYTES / 2) };
    expect(bridgeAppMessageSchema.safeParse(req("state.patch", { patch: wide })).success).toBe(
      false,
    );
  });

  it("rejects an oversize event at 1025 bytes and accepts exactly 1024", () => {
    // a bare string is 2 bytes of quotes plus its content
    const exact = "x".repeat(APP_EVENT_MAX_BYTES - 2);
    expect(bridgeAppMessageSchema.safeParse(req("events.send", { data: exact })).success).toBe(
      true,
    );
    const over = "x".repeat(APP_EVENT_MAX_BYTES - 1);
    expect(bridgeAppMessageSchema.safeParse(req("events.send", { data: over })).success).toBe(
      false,
    );
  });

  it("rejects bad event names", () => {
    for (const name of ["", "Ping", "1ping", "a b", "a".repeat(33), "ping_x"]) {
      expect(bridgeAppMessageSchema.safeParse(req("events.send", { name })).success).toBe(false);
    }
    expect(
      bridgeAppMessageSchema.safeParse(req("events.send", { name: "a".repeat(32) })).success,
    ).toBe(true);
  });

  it("rejects values that are not JSON", () => {
    const bad: unknown[] = [
      () => 1,
      undefined,
      [1, undefined],
      // eslint-disable-next-line no-sparse-arrays
      [1, , 3],
      { a: undefined },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      { a: Number.NaN },
      BigInt(1),
      Symbol("x"),
      new Date(),
      new Map(),
      new Uint8Array(2),
      new (class Foo {})(),
    ];
    for (const value of bad) {
      expect(bridgeAppMessageSchema.safeParse(req("state.patch", { patch: value })).success).toBe(
        false,
      );
      expect(bridgeAppMessageSchema.safeParse(req("events.send", { data: value })).success).toBe(
        false,
      );
    }
  });

  it("stops reading an oversize value as soon as it cannot fit", () => {
    // an invalid element after the point where the budget runs out is never reached
    const big = [...Array.from({ length: 5000 }, () => "xxxxxxxxxx"), undefined];
    expect(jsonProblem(big, 0, { used: 0, max: APP_STATE_MAX_BYTES })).toMatch(/larger than/);
    expect(jsonProblem(big)).toMatch(/not a JSON value|undefined/);
    const huge = "x".repeat(5_000_000);
    expect(bridgeAppMessageSchema.safeParse(req("state.patch", { patch: huge })).success).toBe(
      false,
    );
  });

  it("rejects a cycle instead of looping", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(bridgeAppMessageSchema.safeParse(req("state.patch", { patch: loop })).success).toBe(
      false,
    );
  });

  it("allows nesting of 32 and rejects 33", () => {
    const nest = (depth: number) => {
      let value: unknown = 1;
      for (let i = 0; i < depth; i += 1) value = { a: value };
      return value;
    };
    expect(bridgeAppMessageSchema.safeParse(req("state.patch", { patch: nest(32) })).success).toBe(
      true,
    );
    expect(bridgeAppMessageSchema.safeParse(req("state.patch", { patch: nest(33) })).success).toBe(
      false,
    );
    let arrays: unknown = 1;
    for (let i = 0; i < 33; i += 1) arrays = [arrays];
    expect(bridgeAppMessageSchema.safeParse(req("events.send", { data: arrays })).success).toBe(
      false,
    );
  });

  it("rejects ui.resize out of range and non-integers", () => {
    for (const height of [119, 2001, 480.5, "480", Number.NaN]) {
      expect(bridgeAppMessageSchema.safeParse(req("ui.resize", { height })).success).toBe(false);
    }
    expect(bridgeAppMessageSchema.safeParse(req("ui.resize", { height: 120 })).success).toBe(true);
    expect(bridgeAppMessageSchema.safeParse(req("ui.resize", { height: 2000 })).success).toBe(true);
  });

  it("rejects non-boolean toggles, a bad baseRev and a bad asset name", () => {
    expect(bridgeAppMessageSchema.safeParse(req("ui.fullscreen", { on: "yes" })).success).toBe(
      false,
    );
    expect(bridgeAppMessageSchema.safeParse(req("share.request", { on: 1 })).success).toBe(false);
    expect(bridgeAppMessageSchema.safeParse(req("state.patch", { baseRev: -1 })).success).toBe(
      false,
    );
    expect(bridgeAppMessageSchema.safeParse(req("state.patch", { baseRev: 1.5 })).success).toBe(
      false,
    );
    expect(bridgeAppMessageSchema.safeParse(req("assets.get", { name: "../core" })).success).toBe(
      false,
    );
  });

  describe("the device store", () => {
    const ok = (type: string, extra: Record<string, unknown> = {}) =>
      bridgeAppMessageSchema.safeParse(req(type, extra)).success;

    it("takes keys of 1 to 128 characters of a-z 0-9 : . _ - and nothing else", () => {
      for (const key of ["a", "rom:abc", "state:abc:1", "prefs", "seen:onboarding", "a".repeat(128)]) {
        expect(ok("store.get", { key }), key).toBe(true);
      }
      for (const key of ["", "A", "rom abc", "rom/abc", "../x", "a".repeat(129), "ro\u0000m", "ROM:abc", "chaveé"]) {
        expect(ok("store.get", { key }), JSON.stringify(key)).toBe(false);
        expect(ok("store.delete", { key }), JSON.stringify(key)).toBe(false);
        expect(ok("store.put", { key }), JSON.stringify(key)).toBe(false);
      }
      expect(ok("store.get", { key: 5 })).toBe(false);
    });

    it("takes a prefix of 0 to 128 characters of the same alphabet", () => {
      for (const prefix of ["", "rom:", "a".repeat(128)]) expect(ok("store.list", { prefix }), prefix).toBe(true);
      for (const prefix of ["A", "a b", "a".repeat(129), "*"]) expect(ok("store.list", { prefix }), prefix).toBe(false);
      expect(bridgeAppMessageSchema.safeParse({ id: "r", type: "store.list" }).success).toBe(false);
    });

    it("takes the value as an ArrayBuffer only, a view or a string is refused", () => {
      expect(ok("store.put", { bytes: new Uint8Array(4) })).toBe(false);
      expect(ok("store.put", { bytes: "abcd" })).toBe(false);
      expect(ok("store.put", { bytes: [1, 2] })).toBe(false);
      expect(ok("files.saveLocal", { bytes: new Uint8Array(4) })).toBe(false);
      expect(bridgeAppMessageSchema.safeParse({ id: "r", type: "store.put", key: "a" }).success).toBe(false);
    });

    it("holds meta to JSON of at most 2048 bytes, exactly 2048 passing", () => {
      const fit = { s: "x".repeat(2048 - 8) }; // {"s":"..."} is 8 bytes of frame
      expect(new TextEncoder().encode(JSON.stringify(fit)).length).toBe(2048);
      expect(ok("store.put", { meta: fit })).toBe(true);
      expect(ok("store.put", { meta: { s: "x".repeat(2048 - 7) } })).toBe(false);
      expect(ok("store.put", { meta: undefined })).toBe(true);
      expect(ok("store.put", { meta: () => 1 })).toBe(false);
      expect(ok("store.put", { meta: new Date() })).toBe(false);
    });

    it("takes a save extension of the closed shape and no name", () => {
      expect(ok("files.saveLocal", { ext: ".locadora" })).toBe(true);
      for (const ext of ["locadora", ".", ".LOCADORA", ".a.b", "../x", ".toolongextension"]) {
        expect(ok("files.saveLocal", { ext }), ext).toBe(false);
      }
      expect(ok("files.saveLocal", { name: "save.locadora" })).toBe(false);
    });

    it("answers store.list with at most 500 entries and a key in the alphabet", () => {
      const entry = { key: "rom:abc", size: 1, meta: null, updatedAt: 1 };
      const schema = bridgeResultSchemas["store.list"];
      expect(schema.safeParse(Array.from({ length: 500 }, () => entry)).success).toBe(true);
      expect(schema.safeParse(Array.from({ length: 501 }, () => entry)).success).toBe(false);
      expect(schema.safeParse([{ ...entry, key: "Rom" }]).success).toBe(false);
    });

    it("answers store.get with null for a missing key and never reads one call's result as another's", () => {
      const parsed = bridgeHostMessageSchema.parse({ id: "r", ok: true, type: "store.get", result: null });
      expect(parsed).toMatchObject({ type: "store.get", result: null });
      expect(
        bridgeHostMessageSchema.safeParse({ id: "r", ok: true, type: "store.get", result: { used: 1, cap: 2, persisted: true } })
          .success,
      ).toBe(false);
      expect(
        bridgeHostMessageSchema.safeParse({ id: "r", ok: true, type: "store.usage", result: null }).success,
      ).toBe(false);
    });
  });
});

const participant = (extra: Record<string, unknown> = {}) => ({
  seatId: SEAT,
  displayName: "Bia",
  avatar: AVATAR,
  role: "player",
  isHost: true,
  connection: "present",
  ...extra,
});

const theme = { "--pqp-bg": "#101014", "--pqp-fg": "#fff" };

/** One minimal valid example of every host to app message. */
const hostMessages: Record<string, unknown> = {
  "response ok (state.get)": { id: "r1", ok: true, type: "state.get", result: { rev: 2, value: { a: 1 } } },
  "response ok (participants.get)": {
    id: "r1",
    ok: true,
    type: "participants.get",
    result: { participants: [participant()] },
  },
  "response ok (events.send)": { id: "r1", ok: true, type: "events.send", result: null },
  "response ok (assets.get)": {
    id: "r1",
    ok: true,
    type: "assets.get",
    result: { name: "core.wasm", bytes: new ArrayBuffer(4) },
  },
  "response error": { id: "r1", ok: false, error: "not-host" },
  hello: {
    type: "hello",
    platformApi: 1,
    app: { id: "eco", version: "1.0.0" },
    locale: "pt-BR",
    theme,
    reducedMotion: false,
    self: { seatId: SEAT, role: "spectator", isHost: false },
    connection: "online",
  },
  participants: { type: "participants", participants: [participant(), participant({ seatId: SEAT_2, avatar: null, role: "spectator", isHost: false, appUserId: "A".repeat(43) })] },
  state: { type: "state", rev: 0, value: {} },
  event: { type: "event", fromSeatId: SEAT, name: "ping", data: [1] },
  connection: { type: "connection", status: "reconnecting" },
  "session.ended": { type: "session.ended", reason: "host" },
  theme: { type: "theme", theme },
};

describe("host to app messages", () => {
  it.each(Object.keys(hostMessages))("accepts %s", (name) => {
    const result = bridgeHostMessageSchema.safeParse(hostMessages[name]);
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it("accepts a successful answer to every request type", () => {
    const results: Record<string, unknown> = {
      "participants.get": { participants: [] },
      "state.get": { rev: 1, value: null },
      "state.patch": { rev: 2 },
      "events.send": null,
      "assets.get": { name: "core.wasm", bytes: new ArrayBuffer(1) },
      "files.pickLocal": { bytes: new ArrayBuffer(1), ext: ".gba" },
      "store.get": { bytes: new ArrayBuffer(1), meta: null },
      "store.put": { usage: { used: 1, cap: 512, persisted: false } },
      "store.delete": null,
      "store.list": [{ key: "rom:abc", size: 1, meta: { a: 1 }, updatedAt: 1 }],
      "store.usage": { used: 0, cap: 512, persisted: true },
      "files.saveLocal": null,
      "sync.status": { mode: "on", used: 0, cap: 8, device: "computer" },
      "sync.list": {
        entries: [
          {
            id: "5b7b9f4e-8c0d-4f0a-9d6e-2a1c4d3b8e11",
            kind: "sram",
            slot: 0,
            rev: 1,
            size: 8,
            hash: "b".repeat(64),
            savedAt: 1,
            device: "phone",
            thisDevice: false,
            thumb: false,
            platform: "gba",
            core: "mgba",
            coreVersion: "4.2.3",
            history: 0,
          },
        ],
      },
      "sync.get": { rev: 1, bytes: new ArrayBuffer(1), thumb: null },
      "sync.put": { id: "5b7b9f4e-8c0d-4f0a-9d6e-2a1c4d3b8e11", rev: 1, used: 1, cap: 8 },
      "sync.delete": { used: 0, cap: 8 },
      "sync.restore": { id: "5b7b9f4e-8c0d-4f0a-9d6e-2a1c4d3b8e11", rev: 3 },
      "sync.clear": { deleted: 1, used: 0, cap: 8 },
      "ui.resize": { height: 300 },
      "ui.fullscreen": { on: true },
      "share.request": { on: true },
      "session.end": null,
    };
    expect(Object.keys(results).sort()).toEqual(Object.keys(requests).sort());
    for (const [type, result] of Object.entries(results)) {
      expect(bridgeResultSchemas[type as keyof typeof bridgeResultSchemas].safeParse(result).success, type).toBe(true);
      expect(bridgeHostMessageSchema.safeParse({ id: "r", ok: true, type, result }).success, type).toBe(true);
    }
  });

  it("never reads one call's result as another's, even when a newer host adds a field", () => {
    const parsed = bridgeHostMessageSchema.parse({
      id: "r",
      ok: true,
      type: "state.get",
      result: { rev: 3, value: { n: 1 }, participants: [] },
    });
    expect(parsed).toMatchObject({ type: "state.get", result: { rev: 3, value: { n: 1 } } });
    // a result that does not fit the call it claims to answer is refused
    expect(
      bridgeHostMessageSchema.safeParse({
        id: "r",
        ok: true,
        type: "state.get",
        result: { participants: [] },
      }).success,
    ).toBe(false);
    // an ok response without the request type is refused
    expect(
      bridgeHostMessageSchema.safeParse({ id: "r", ok: true, result: { rev: 1, value: 1 } })
        .success,
    ).toBe(false);
  });

  it("bounds the avatars of one participant list in total", () => {
    const prefix = "data:image/png;base64,";
    const big = prefix + "A".repeat(APP_AVATAR_MAX_CHARS - prefix.length);
    const list = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        participant({ seatId: `seat${String(i).padStart(12, "0")}`, avatar: big }),
      );
    const budgetFits = Math.floor(APP_PARTICIPANTS_AVATAR_BUDGET_CHARS / APP_AVATAR_MAX_CHARS);
    expect(
      bridgeHostMessageSchema.safeParse({ type: "participants", participants: list(budgetFits) })
        .success,
    ).toBe(true);
    expect(
      bridgeHostMessageSchema.safeParse({
        type: "participants",
        participants: list(budgetFits + 1),
      }).success,
    ).toBe(false);
    expect(
      bridgeResultSchemas["participants.get"].safeParse({ participants: list(budgetFits + 1) })
        .success,
    ).toBe(false);
  });

  it("does not take an object that merely claims to be an ArrayBuffer", () => {
    const spoof = { [Symbol.toStringTag]: "ArrayBuffer" };
    expect(
      bridgeHostMessageSchema.safeParse({ id: "r", ok: true, type: "files.pickLocal", result: { bytes: spoof } }).success,
    ).toBe(false);
    expect(
      bridgeHostMessageSchema.safeParse({ id: "r", ok: true, type: "files.pickLocal", result: { bytes: new Uint8Array(2) } })
        .success,
    ).toBe(false);
  });

  it("accepts every end reason of the data model and no other", () => {
    for (const reason of APP_END_REASONS) {
      expect(
        bridgeHostMessageSchema.safeParse({ type: "session.ended", reason }).success,
      ).toBe(true);
    }
    expect(
      bridgeHostMessageSchema.safeParse({ type: "session.ended", reason: "because" }).success,
    ).toBe(false);
    expect(APP_END_REASONS).toHaveLength(10);
  });

  it("accepts every error code and no other", () => {
    for (const error of [
      "not-allowed",
      "not-host",
      "too-large",
      "rate-limited",
      "stale-rev",
      "cancelled",
      "unavailable",
      "ended",
      "invalid",
    ]) {
      expect(bridgeHostMessageSchema.safeParse({ id: "r", ok: false, error }).success).toBe(true);
    }
    expect(bridgeHostMessageSchema.safeParse({ id: "r", ok: false, error: "boom" }).success).toBe(
      false,
    );
    expect(bridgeHostMessageSchema.safeParse({ id: "r", ok: false }).success).toBe(false);
  });

  it("rejects an unknown type", () => {
    expect(bridgeHostMessageSchema.safeParse({ type: "navigate", url: "x" }).success).toBe(false);
  });

  // The direction rule: strict toward the app (it is untrusted), tolerant of a newer host.
  it.each(Object.keys(hostMessages))("strips an unknown extra key on %s", (name) => {
    const message = { ...(hostMessages[name] as object), extra: 1 };
    const result = bridgeHostMessageSchema.safeParse(message);
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.success && "extra" in result.data).toBe(false);
  });

  it("strips an unknown key nested in a participant, a result and a hello", () => {
    const participants = bridgeHostMessageSchema.parse({
      type: "participants",
      participants: [participant({ futureField: 1, userId: "pqp-user-1" })],
    });
    expect(participants).toEqual({ type: "participants", participants: [participant()] });
    const state = bridgeHostMessageSchema.parse({
      id: "r",
      ok: true,
      type: "state.get",
      result: { rev: 1, value: { a: 1 }, futureField: true },
    });
    expect(state).toEqual({
      id: "r",
      ok: true,
      type: "state.get",
      result: { rev: 1, value: { a: 1 } },
    });
    const hello = bridgeHostMessageSchema.parse({
      ...(hostMessages.hello as object),
      app: { id: "eco", version: "1.0.0", serverId: "s" },
      self: { seatId: SEAT, role: "player", isHost: true, userId: "u" },
    });
    expect(hello).toMatchObject({
      app: { id: "eco", version: "1.0.0" },
      self: { seatId: SEAT, role: "player", isHost: true },
    });
    expect(JSON.stringify(hello)).not.toMatch(/serverId|userId/);
  });

  it("accepts a participant that is reconnecting and rejects any other connection", () => {
    const push = (connection: unknown) => ({
      type: "participants",
      participants: [participant({ connection })],
    });
    expect(bridgeHostMessageSchema.safeParse(push("reconnecting")).success).toBe(true);
    expect(bridgeHostMessageSchema.safeParse(push("gone")).success).toBe(false);
    expect(bridgeHostMessageSchema.safeParse(push(undefined)).success).toBe(false);
    expect(
      bridgeResultSchemas["participants.get"].safeParse({
        participants: [participant({ connection: "reconnecting" })],
      }).success,
    ).toBe(true);
  });

  it("rejects a seat id outside the 16 to 32 character alphabet", () => {
    for (const seatId of ["short", "a".repeat(15), "a".repeat(33), "has space 1234567890", "pqp:user:123456789"]) {
      expect(
        bridgeHostMessageSchema.safeParse({
          type: "event",
          fromSeatId: seatId,
          name: "ping",
          data: 1,
        }).success,
      ).toBe(false);
      expect(
        bridgeHostMessageSchema.safeParse({
          type: "participants",
          participants: [participant({ seatId })],
        }).success,
      ).toBe(false);
    }
    expect(
      bridgeHostMessageSchema.safeParse({
        type: "event",
        fromSeatId: "a".repeat(16),
        name: "ping",
        data: 1,
      }).success,
    ).toBe(true);
    expect(
      bridgeHostMessageSchema.safeParse({
        type: "event",
        fromSeatId: "a".repeat(32),
        name: "ping",
        data: 1,
      }).success,
    ).toBe(true);
  });

  it("rejects an avatar over 65536 characters and one that is not an image data URL", () => {
    const prefix = "data:image/png;base64,";
    const exact = prefix + "A".repeat(APP_AVATAR_MAX_CHARS - prefix.length);
    const over = exact + "A";
    const push = (avatar: unknown) => ({
      type: "participants",
      participants: [participant({ avatar })],
    });
    expect(bridgeHostMessageSchema.safeParse(push(exact)).success).toBe(true);
    expect(bridgeHostMessageSchema.safeParse(push(over)).success).toBe(false);
    expect(bridgeHostMessageSchema.safeParse(push("https://pqp.gg/a.png")).success).toBe(false);
    expect(bridgeHostMessageSchema.safeParse(push(undefined)).success).toBe(false);
  });

  it("bounds the display name", () => {
    const push = (displayName: string) => ({
      type: "participants",
      participants: [participant({ displayName })],
    });
    expect(bridgeHostMessageSchema.safeParse(push("")).success).toBe(false);
    expect(bridgeHostMessageSchema.safeParse(push("a".repeat(65))).success).toBe(false);
    expect(bridgeHostMessageSchema.safeParse(push("a".repeat(64))).success).toBe(true);
  });

  it("caps participants at 264", () => {
    const many = (count: number) => ({
      type: "participants",
      participants: Array.from({ length: count }, (_, i) =>
        participant({ seatId: `seat${String(i).padStart(12, "0")}` }),
      ),
    });
    expect(bridgeHostMessageSchema.safeParse(many(APP_MAX_PARTICIPANTS)).success).toBe(true);
    expect(bridgeHostMessageSchema.safeParse(many(APP_MAX_PARTICIPANTS + 1)).success).toBe(false);
    expect(
      bridgeResultSchemas["participants.get"].safeParse({
        participants: many(APP_MAX_PARTICIPANTS + 1).participants,
      }).success,
    ).toBe(false);
  });

  it("never lets a pqp identity through a participant, it is stripped", () => {
    for (const key of ["userId", "user_id", "email", "token"]) {
      const parsed = bridgeHostMessageSchema.parse({
        type: "participants",
        participants: [participant({ [key]: "x" })],
      });
      expect(JSON.stringify(parsed)).not.toContain(`"${key}"`);
    }
  });

  it("bounds the theme at 64 custom properties with valid names", () => {
    const tokens = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`--t${i}`, "1px"]));
    expect(bridgeHostMessageSchema.safeParse({ type: "theme", theme: tokens(64) }).success).toBe(
      true,
    );
    expect(bridgeHostMessageSchema.safeParse({ type: "theme", theme: tokens(65) }).success).toBe(
      false,
    );
    expect(
      bridgeHostMessageSchema.safeParse({ type: "theme", theme: { color: "red" } }).success,
    ).toBe(false);
    expect(
      bridgeHostMessageSchema.safeParse({ type: "theme", theme: { "--a": 1 } }).success,
    ).toBe(false);
  });

  it("holds state and event pushes to the same size and JSON rules", () => {
    const over = { a: "x".repeat(APP_STATE_MAX_BYTES - 7) };
    expect(bridgeHostMessageSchema.safeParse({ type: "state", rev: 1, value: over }).success).toBe(
      false,
    );
    expect(
      bridgeHostMessageSchema.safeParse({
        type: "event",
        fromSeatId: SEAT,
        name: "ping",
        data: "x".repeat(APP_EVENT_MAX_BYTES - 1),
      }).success,
    ).toBe(false);
    expect(
      bridgeHostMessageSchema.safeParse({ type: "state", rev: 1, value: { a: Number.NaN } })
        .success,
    ).toBe(false);
  });

  it("rejects a bad hello", () => {
    const hello = hostMessages.hello as Record<string, unknown>;
    expect(bridgeHostMessageSchema.safeParse({ ...hello, platformApi: 2 }).success).toBe(false);
    expect(bridgeHostMessageSchema.safeParse({ ...hello, connection: "gone" }).success).toBe(false);
    expect(
      bridgeHostMessageSchema.safeParse({ ...hello, self: { seatId: "short", role: "player", isHost: true } })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Structural guard: nothing an app can see may be able to name a pqp identity.

const FORBIDDEN_KEYS = new Set(["userId", "user_id", "email", "token", "serverId", "channelId"]);

/** Every property name reachable in a zod schema, with the path to it. */
function collectKeys(schema: z.ZodTypeAny, path: string, seen: Set<z.ZodTypeAny>): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = schema._def as { typeName: string } & Record<string, unknown>;
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      return Object.entries(shape).flatMap(([key, child]) => [
        `${path}.${key}`,
        ...collectKeys(child, `${path}.${key}`, seen),
      ]);
    }
    case z.ZodFirstPartyTypeKind.ZodUnion:
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const options = def.options as z.ZodTypeAny[] | Map<unknown, z.ZodTypeAny>;
      const list = Array.isArray(options) ? options : [...options.values()];
      return list.flatMap((option, i) => collectKeys(option, `${path}|${i}`, seen));
    }
    case z.ZodFirstPartyTypeKind.ZodArray:
      return collectKeys(def.type as z.ZodTypeAny, `${path}[]`, seen);
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return [
        ...collectKeys(def.keyType as z.ZodTypeAny, `${path}{key}`, seen),
        ...collectKeys(def.valueType as z.ZodTypeAny, `${path}{value}`, seen),
      ];
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return collectKeys(def.innerType as z.ZodTypeAny, path, seen);
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return collectKeys(def.schema as z.ZodTypeAny, path, seen);
    default:
      return [];
  }
}

describe("the bridge never names a pqp identity", () => {
  const roots: Array<[string, z.ZodTypeAny]> = [
    ["app-hello", bridgeAppHelloSchema],
    ["app-port", bridgeAppPortSchema],
    ["bridgeAppMessageSchema", bridgeAppMessageSchema],
    ["bridgeHostMessageSchema", bridgeHostMessageSchema],
    ...Object.entries(bridgeResultSchemas).map(
      ([name, schema]) => [`result ${name}`, schema] as [string, z.ZodTypeAny],
    ),
  ];

  it("walks a non-trivial number of keys (the walker itself works)", () => {
    const keys = collectKeys(bridgeHostMessageSchema, "host", new Set());
    const leaves = new Set(keys.map((path) => path.split(".").at(-1)));
    for (const leaf of ["seatId", "displayName", "avatar", "fromSeatId", "reason", "bytes"]) {
      expect(leaves.has(leaf), leaf).toBe(true);
    }
    expect(keys.length).toBeGreaterThan(30);
  });

  it("would catch a leak, however deeply it is nested", () => {
    const leaky = z.union([
      z.object({ type: z.literal("a") }).strict(),
      z.object({ list: z.array(z.object({ who: z.object({ userId: z.string() }) })).optional() }),
    ]);
    const keys = collectKeys(leaky, "leaky", new Set());
    expect(keys.some((path) => FORBIDDEN_KEYS.has(path.split(".").at(-1) ?? ""))).toBe(true);
  });

  it.each(roots)("%s has no forbidden key", (name, schema) => {
    const keys = collectKeys(schema, name, new Set());
    const leaks = keys.filter((path) => FORBIDDEN_KEYS.has(path.split(".").at(-1) ?? ""));
    expect(leaks).toEqual([]);
  });
});
