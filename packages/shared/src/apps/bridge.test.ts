import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bridgeAppHelloSchema,
  bridgeAppMessageSchema,
  bridgeAppPortSchema,
  bridgeHostMessageSchema,
  bridgeResultSchemas,
} from "./bridge.js";
import { APP_END_REASONS } from "./common.js";
import {
  APP_AVATAR_MAX_CHARS,
  APP_EVENT_MAX_BYTES,
  APP_EVENT_MAX_PER_SECOND,
  APP_MAX_PARTICIPANTS,
  APP_PLATFORM_API,
  APP_STATE_MAX_BYTES,
  APP_STATE_MAX_WRITES_PER_SECOND,
} from "./limits.js";

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

  it("rejects unknown keys and a platform api the host does not speak", () => {
    expect(
      bridgeAppHelloSchema.safeParse({ pqp: "app-hello", platformApi: 1, x: 1 }).success,
    ).toBe(false);
    expect(bridgeAppPortSchema.safeParse({ pqp: "app-port", platformApi: 1, x: 1 }).success).toBe(
      false,
    );
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
  "ui.resize": { height: 480 },
  "ui.fullscreen": { on: true },
  "share.request": { on: false },
  "session.end": {},
};

function req(type: string, extra: Record<string, unknown> = {}) {
  return { id: "r1", type, ...requests[type], ...extra };
}

describe("app to host requests", () => {
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
});

const participant = (extra: Record<string, unknown> = {}) => ({
  seatId: SEAT,
  displayName: "Bia",
  avatar: AVATAR,
  role: "player",
  isHost: true,
  ...extra,
});

const theme = { "--pqp-bg": "#101014", "--pqp-fg": "#fff" };

/** One minimal valid example of every host to app message. */
const hostMessages: Record<string, unknown> = {
  "response ok (state.get)": { id: "r1", ok: true, result: { rev: 2, value: { a: 1 } } },
  "response ok (participants.get)": {
    id: "r1",
    ok: true,
    result: { participants: [participant()] },
  },
  "response ok (events.send)": { id: "r1", ok: true, result: {} },
  "response ok (assets.get)": {
    id: "r1",
    ok: true,
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

  it.each(Object.keys(hostMessages))("rejects an unknown extra key on %s", (name) => {
    const message = { ...(hostMessages[name] as object), extra: 1 };
    expect(bridgeHostMessageSchema.safeParse(message).success).toBe(false);
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

  it("rejects a participant carrying a pqp identity", () => {
    for (const key of ["userId", "user_id", "email", "token"]) {
      expect(
        bridgeHostMessageSchema.safeParse({
          type: "participants",
          participants: [participant({ [key]: "x" })],
        }).success,
      ).toBe(false);
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
      bridgeHostMessageSchema.safeParse({
        ...hello,
        self: { seatId: SEAT, role: "player", isHost: true, userId: "x" },
      }).success,
    ).toBe(false);
    expect(
      bridgeHostMessageSchema.safeParse({ ...hello, app: { id: "eco", version: "1", serverId: "x" } })
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
