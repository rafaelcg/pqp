import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The push leg of the start-of-stream notice, at the seams `push.test.ts` uses:
 * a real database, the vendor transport and the cluster socket probe stubbed.
 *
 * WHO is told was decided before this (`stream-alerts.test.ts`); what is pinned
 * here is the narrowing that only a push can do (nobody with a live socket,
 * nobody on a stored DND), the shape of what is sent (a minute of TTL, a tag per
 * channel, a path that opens the channel, the person's language, names only) and
 * that nothing is sent at all with no push transport configured.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { mergePreferences } = await import("./preferences.js");
const {
  STREAM_START_PUSH_RETRY_MS,
  STREAM_START_PUSH_TTL_SECONDS,
  buildStreamStartedPayload,
  pushStreamStarted,
  savePushSubscription,
  sendStreamStartedPush,
  setLiveSocketProbeForTests,
  setPushSenderForTests,
} = await import("./push.js");
const { buildStreamStartedPushCopy, resolveStreamAlertLocale } = await import(
  "./push-copy.js"
);

type Sent = {
  userId: string;
  payload: { title: string; body: string; path: string; tag: string };
  ttlSeconds: number;
};

describe("the notice's copy", () => {
  it("says the same thing in three languages, with names only", () => {
    const input = { sharerName: "Alberto", channelLabel: "#filminho", serverName: "Filminho" };
    expect(buildStreamStartedPushCopy({ locale: "pt-BR", ...input })).toEqual({
      title: "Alberto começou a transmitir em #filminho",
      body: "Filminho · Assistir",
    });
    expect(buildStreamStartedPushCopy({ locale: "en", ...input })).toEqual({
      title: "Alberto started streaming in #filminho",
      body: "Filminho · Watch",
    });
    expect(buildStreamStartedPushCopy({ locale: "es", ...input })).toEqual({
      title: "Alberto empezó a transmitir en #filminho",
      body: "Filminho · Ver",
    });
  });

  it("reads the person's locale, defaulting to the instance's", () => {
    expect(resolveStreamAlertLocale("en")).toBe("en");
    expect(resolveStreamAlertLocale("es")).toBe("es");
    expect(resolveStreamAlertLocale("es-MX")).toBe("es");
    expect(resolveStreamAlertLocale("pt-BR")).toBe("pt-BR");
    expect(resolveStreamAlertLocale(undefined)).toBe("pt-BR");
    expect(resolveStreamAlertLocale("fr")).toBe("pt-BR");
  });

  it("builds a payload that opens the channel, one live notification per channel", () => {
    const channelId = randomUUID();
    const serverId = randomUUID();
    const payload = buildStreamStartedPayload(
      {
        userIds: [],
        serverId,
        channelId,
        serverName: "Filminho",
        channelLabel: "#filminho",
        sharerName: "Alberto",
      },
      "pt-BR",
    );
    expect(payload.path).toBe(`/app/server/${serverId}/channel/${channelId}`);
    expect(payload.tag).toBe(`stream:${channelId}`);
  });
});

describeDb("sendStreamStartedPush", () => {
  let sent: Sent[];
  let online: Set<string>;
  let ana: string;
  let bea: string;
  let caio: string;
  let dani: string;
  const event = () => ({
    userIds: [ana, bea, caio, dani],
    serverId: randomUUID(),
    channelId: randomUUID(),
    serverName: "Filminho",
    channelLabel: "#filminho",
    sharerName: "Alberto",
  });

  async function subscribe(userId: string): Promise<void> {
    await savePushSubscription(userId, {
      endpoint: `https://push.example.test/${userId}`,
      keys: { p256dh: "p", auth: "a" },
    });
  }

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    const make = async (name: string) =>
      (await upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null })).id;
    ana = await make("ana");
    bea = await make("bea");
    caio = await make("caio");
    dani = await make("dani");
    sent = [];
    online = new Set();
    process.env.VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";
    process.env.VAPID_SUBJECT = "mailto:push@example.test";
    setPushSenderForTests(async (subscription, payload, _config, delivery) => {
      sent.push({
        userId: subscription.user_id,
        payload: JSON.parse(payload) as Sent["payload"],
        ttlSeconds: delivery.ttlSeconds,
      });
    });
    setLiveSocketProbeForTests((userId) => online.has(userId));
  });

  afterEach(() => {
    setPushSenderForTests(null);
    setLiveSocketProbeForTests(null);
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  it("pushes only the people with no live socket and no stored DND, each in their language", async () => {
    for (const id of [ana, bea, caio, dani]) {
      await subscribe(id);
    }
    online.add(bea);
    await mergePreferences(caio, { status: "dnd" });
    await mergePreferences(dani, { locale: "en" } as never);

    const pushed = await sendStreamStartedPush(event());

    expect(pushed).toBe(2);
    expect(sent.map((s) => s.userId).sort()).toEqual([ana, dani].sort());
    const forAna = sent.find((s) => s.userId === ana)!;
    const forDani = sent.find((s) => s.userId === dani)!;
    expect(forAna.payload.title).toBe("Alberto começou a transmitir em #filminho");
    expect(forAna.payload.body).toBe("Filminho · Assistir");
    expect(forDani.payload.title).toBe("Alberto started streaming in #filminho");
    // A notice about a stream that started is wrong an hour later.
    expect(forAna.ttlSeconds).toBe(STREAM_START_PUSH_TTL_SECONDS);
    expect(STREAM_START_PUSH_TTL_SECONDS).toBe(60);
  });

  it("sends nothing when everybody is connected", async () => {
    await subscribe(ana);
    online.add(ana);
    expect(await sendStreamStartedPush({ ...event(), userIds: [ana] })).toBe(0);
    expect(sent).toEqual([]);
  });

  it("retries once after a failed attempt, says so, and gives up after that", async () => {
    await subscribe(ana);
    const pool = getPool();
    const real = pool.query.bind(pool);
    let failuresLeft = 2;
    const spy = vi.spyOn(pool, "query").mockImplementation(((text: unknown, ...rest: unknown[]) => {
      if (
        failuresLeft > 0 &&
        typeof text === "string" &&
        text.includes("FROM user_preferences")
      ) {
        failuresLeft -= 1;
        return Promise.reject(new Error("connection terminated"));
      }
      return (real as (...args: unknown[]) => unknown)(text, ...rest);
    }) as never);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const onSent = vi.fn();
      const onFailed = vi.fn();
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      pushStreamStarted({ ...event(), userIds: [ana] }, onSent, onFailed);
      const until = async (check: () => boolean) => {
        const deadline = Date.now() + 3_000;
        while (!check()) {
          if (Date.now() > deadline) throw new Error("timed out");
          await new Promise((resolve) => setImmediate(resolve));
        }
      };
      await until(() => onFailed.mock.calls.length === 1);
      expect(onSent).not.toHaveBeenCalled();
      // The second attempt fails too: told once more, and there is no third.
      await vi.advanceTimersByTimeAsync(STREAM_START_PUSH_RETRY_MS);
      await until(() => onFailed.mock.calls.length === 2);
      await vi.advanceTimersByTimeAsync(STREAM_START_PUSH_RETRY_MS * 3);
      await new Promise((resolve) => setImmediate(resolve));
      expect(onFailed).toHaveBeenCalledTimes(2);
      expect(onSent).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      quiet.mockRestore();
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });

  it("a failed first attempt followed by a good retry delivers once", async () => {
    await subscribe(ana);
    const pool = getPool();
    const real = pool.query.bind(pool);
    let failuresLeft = 1;
    const spy = vi.spyOn(pool, "query").mockImplementation(((text: unknown, ...rest: unknown[]) => {
      if (
        failuresLeft > 0 &&
        typeof text === "string" &&
        text.includes("FROM user_preferences")
      ) {
        failuresLeft -= 1;
        return Promise.reject(new Error("statement timeout"));
      }
      return (real as (...args: unknown[]) => unknown)(text, ...rest);
    }) as never);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const onSent = vi.fn();
      const onFailed = vi.fn();
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      pushStreamStarted({ ...event(), userIds: [ana] }, onSent, onFailed);
      const until = async (check: () => boolean) => {
        const deadline = Date.now() + 3_000;
        while (!check()) {
          if (Date.now() > deadline) throw new Error("timed out");
          await new Promise((resolve) => setImmediate(resolve));
        }
      };
      await until(() => onFailed.mock.calls.length === 1);
      await vi.advanceTimersByTimeAsync(STREAM_START_PUSH_RETRY_MS);
      await until(() => onSent.mock.calls.length === 1);
      expect(onSent).toHaveBeenCalledWith(1);
      expect(sent).toHaveLength(1);
      quiet.mockRestore();
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });

  it("is inert without a push transport", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    await subscribe(ana);
    expect(await sendStreamStartedPush({ ...event(), userIds: [ana] })).toBe(0);
    expect(sent).toEqual([]);
  });
});
