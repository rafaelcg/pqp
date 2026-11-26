import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The push leg of the Jam take notices, at the seams `push-stream-started.test.ts`
 * uses: a real database, the vendor transport and the cluster socket probe
 * stubbed. WHO is told (never the recorder, never past a block, once per item per
 * half hour) is `api/jam-take-notices.test.ts`; pinned here is what only a push
 * decides: a live socket, a stored DND and an explicit mute stop it, the copy is in
 * the person's language and names the song, and a tap opens that song.
 */

// This suite TRUNCATEs: it runs only against a localhost database, so a staging or
// production `DATABASE_URL` in the environment makes it skip instead of wiping users.
function localTestDatabase(): string | undefined {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    return undefined;
  }
  try {
    const host = new URL(url).hostname;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) ? url : undefined;
  } catch {
    return undefined;
  }
}
const DATABASE_URL = localTestDatabase();
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { mergePreferences } = await import("./preferences.js");
const {
  buildJamTakePayload,
  resolveJamPushLevel,
  savePushSubscription,
  sendJamTakePush,
  setLiveSocketProbeForTests,
  setPushSenderForTests,
} = await import("./push.js");
const { buildJamTakePushCopy } = await import("./push-copy.js");

type Sent = { userId: string; payload: { title: string; body: string; path: string; tag: string } };

describe("the notice's copy", () => {
  const base = { title: "Lua cheia", count: 1, instrument: "bass" };

  it("says what happened in three languages, naming the instrument and never a person", () => {
    expect(buildJamTakePushCopy({ ...base, locale: "pt-BR", kind: "take" }).body).toBe("Uma parte de baixo esperando tua resposta");
    expect(buildJamTakePushCopy({ ...base, locale: "en", kind: "take" }).body).toBe("A bass part is waiting for your answer");
    expect(buildJamTakePushCopy({ ...base, locale: "es", kind: "take" }).body).toBe("Una parte de bajo espera tu respuesta");
    expect(buildJamTakePushCopy({ ...base, locale: "pt-BR", kind: "accepted" }).body).toBe("Tua parte de baixo entrou na música");
    expect(buildJamTakePushCopy({ ...base, locale: "en", kind: "refused" }).body).toBe("Your bass part did not make it in");
    expect(buildJamTakePushCopy({ ...base, locale: "es", kind: "refused" }).body).toBe("Tu parte de bajo no entró");
  });

  it("a burst is one line with a count, and an instrument with no name says nothing about it", () => {
    expect(buildJamTakePushCopy({ ...base, locale: "pt-BR", kind: "take", count: 3 }).body).toBe("3 partes esperando tua resposta");
    expect(buildJamTakePushCopy({ ...base, locale: "en", kind: "accepted", count: 2 }).body).toBe("2 of your parts are in the song");
    expect(buildJamTakePushCopy({ ...base, locale: "pt-BR", kind: "take", instrument: "other" }).body).toBe("Uma parte esperando tua resposta");
    expect(buildJamTakePushCopy({ ...base, locale: "pt-BR", kind: "take", instrument: null }).body).toBe("Uma parte esperando tua resposta");
  });

  it("uses no em dash, in any language", () => {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      for (const kind of ["take", "accepted", "refused"] as const) {
        for (const count of [1, 4]) {
          const copy = buildJamTakePushCopy({ ...base, locale, kind, count });
          expect(`${copy.title} ${copy.body}`).not.toMatch(/—/);
        }
      }
    }
  });

  it("opens the song in the app, one live notification per song and kind", () => {
    const songId = randomUUID();
    const payload = buildJamTakePayload({ kind: "take", songId, title: "Lua cheia", count: 1, instrument: "bass" }, "pt-BR");
    expect(payload.path).toBe(`/app/jam/${songId}`);
    expect(payload.tag).toBe(`jam-take:${songId}:take`);
    expect(payload.title).toBe("Lua cheia");
  });
});

describe("the mute rule", () => {
  it("only an explicit none stops it, on the channel, the server or the account", () => {
    expect(resolveJamPushLevel(null, null, null)).toBe("all");
    // The account-wide "mentions" default must not silence a notice about your own song.
    expect(resolveJamPushLevel({ notifications: { default: "mentions", serverDefault: "mentions" } } as never, "s", "c")).toBe("all");
    expect(resolveJamPushLevel({ notifications: { default: "none" } } as never, null, null)).toBe("none");
    expect(resolveJamPushLevel({ notifications: { servers: { s: "none" } } } as never, "s", "c")).toBe("none");
    expect(resolveJamPushLevel({ notifications: { channels: { c: "none" } } } as never, "s", "c")).toBe("none");
    expect(resolveJamPushLevel({ notifications: { channels: { other: "none" } } } as never, "s", "c")).toBe("all");
  });
});

describeDb("sendJamTakePush", () => {
  let sent: Sent[];
  let online: Set<string>;
  let ana: string;
  const event = () => ({
    userId: ana,
    kind: "take" as const,
    songId: randomUUID(),
    title: "Lua cheia",
    count: 1,
    instrument: "bass",
    serverId: null,
    channelId: null,
  });

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    ana = (await upsertUser({ clerkId: "clerk_jt_ana", displayName: "ana", avatarUrl: null })).id;
    await savePushSubscription(ana, { endpoint: `https://push.example.test/${ana}`, keys: { p256dh: "p", auth: "a" } });
    sent = [];
    online = new Set();
    process.env.VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";
    process.env.VAPID_SUBJECT = "mailto:push@example.test";
    setPushSenderForTests(async (subscription, payload) => {
      sent.push({ userId: subscription.user_id, payload: JSON.parse(payload) as Sent["payload"] });
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

  it("pushes a person with no socket, in their language", async () => {
    await mergePreferences(ana, { locale: "es" } as never);
    expect(await sendJamTakePush(event())).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.body).toBe("Una parte de bajo espera tu respuesta");
  });

  it("sends nothing to somebody with the app open: the card and the frame are that notice", async () => {
    online.add(ana);
    expect(await sendJamTakePush(event())).toBe(false);
    expect(sent).toEqual([]);
  });

  it("sends nothing on a stored do-not-disturb", async () => {
    await mergePreferences(ana, { status: "dnd" });
    expect(await sendJamTakePush(event())).toBe(false);
    expect(sent).toEqual([]);
  });

  it("sends nothing to an account that muted everything, or the song's server", async () => {
    await mergePreferences(ana, { notifications: { default: "none" } } as never);
    expect(await sendJamTakePush(event())).toBe(false);
    await mergePreferences(ana, { notifications: { default: "all", servers: { srv: "none" } } } as never);
    expect(await sendJamTakePush({ ...event(), serverId: "srv", channelId: "chn" })).toBe(false);
    expect(sent).toEqual([]);
  });

  it("sends nothing with no push transport configured", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    expect(await sendJamTakePush(event())).toBe(false);
    expect(sent).toEqual([]);
  });
});
