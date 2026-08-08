import { generateKeyPairSync } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

/**
 * Web Push, pinned at the three seams that matter.
 *
 * The pure decision matrix (`shouldPush`) is walked exhaustively because it is
 * the requirement itself: mentions, replies and DMs only — never every
 * message. The fan-out is exercised against a real database with the vendor
 * transport and the cluster socket probe stubbed, because those are the two
 * things a test must not depend on. And the whole surface is asserted inert
 * when the VAPID env is absent, the same posture the attachment tests pin for
 * S3.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer } = await import("./servers.js");
const { openConversation } = await import("./dms.js");
const {
  CALL_PUSH_TTL_SECONDS,
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  PUSH_TTL_SECONDS,
  buildApnsBody,
  buildCallPushPayload,
  buildPushPayload,
  deleteApnsSubscription,
  deletePushSubscription,
  isAnyPushEnabled,
  isPushEnabled,
  getVapidPublicKey,
  listPushSubscriptions,
  pushRegistrationSchema,
  resolvePushLevel,
  saveApnsSubscription,
  savePushRegistration,
  savePushSettings,
  savePushSubscription,
  sendCallPush,
  sendChannelPush,
  setLiveSocketProbeForTests,
  setPushSenderForTests,
  shouldPush,
  truncateLabel,
  wantsDmDetails,
} = await import("./push.js");
const {
  resetApnsJwtCacheForTests,
  setApnsTransportForTests,
} = await import("./apns.js");
// Erased at compile time, so this static import cannot run module side effects
// before the DATABASE_URL patching above.
type ChannelAudienceView = import("./push.js").ChannelAudienceView;
type StoredPushSubscription = import("./push.js").StoredPushSubscription;
type ApnsRequest = import("./apns.js").ApnsRequest;

const VAPID_ENV = {
  VAPID_PUBLIC_KEY: "test-public-key",
  VAPID_PRIVATE_KEY: "test-private-key",
  VAPID_SUBJECT: "mailto:push@example.test",
};

function setVapidEnv(): void {
  Object.assign(process.env, VAPID_ENV);
}

function clearVapidEnv(): void {
  for (const key of Object.keys(VAPID_ENV)) {
    delete process.env[key];
  }
}

// A real P-256 key: `buildApnsJwt` verifies the curve before signing, so a
// placeholder string would make every APNs case throw for the wrong reason.
const { privateKey: apnsPrivateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const APNS_ENV = {
  APNS_KEY_ID: "ABCD123456",
  APNS_TEAM_ID: "WXBFUF9WMA",
  APNS_PRIVATE_KEY: apnsPrivateKey,
  APNS_TOPIC: "gg.pqp.app",
};

function setApnsEnv(): void {
  Object.assign(process.env, APNS_ENV);
}

function clearApnsEnv(): void {
  for (const key of Object.keys(APNS_ENV)) {
    delete process.env[key];
  }
  delete process.env.APNS_ENVIRONMENT;
}

// --------------------------------------------------------- pure decisions

describe("shouldPush", () => {
  it("pushes mentions and replies at both audible levels", () => {
    for (const level of ["all", "mentions"] as const) {
      expect(
        shouldPush({
          mention: true,
          channelKind: "server",
          manualStatus: undefined,
          level,
        }),
      ).toBe(true);
    }
  });

  it("never pushes a plain server-channel message, even at 'all'", () => {
    expect(
      shouldPush({
        mention: false,
        channelKind: "server",
        manualStatus: undefined,
        level: "all",
      }),
    ).toBe(false);
  });

  it("pushes a plain DM at 'all' but not at 'mentions'", () => {
    expect(
      shouldPush({
        mention: false,
        channelKind: "dm",
        manualStatus: undefined,
        level: "all",
      }),
    ).toBe(true);
    expect(
      shouldPush({
        mention: false,
        channelKind: "dm",
        manualStatus: undefined,
        level: "mentions",
      }),
    ).toBe(false);
  });

  it("treats a group conversation like a DM", () => {
    expect(
      shouldPush({
        mention: false,
        channelKind: "group",
        manualStatus: undefined,
        level: "all",
      }),
    ).toBe(true);
  });

  it("'none' mutes everything, mentions included", () => {
    for (const kind of ["server", "dm", "group"] as const) {
      expect(
        shouldPush({
          mention: true,
          channelKind: kind,
          manualStatus: undefined,
          level: "none",
        }),
      ).toBe(false);
    }
  });

  it("DND wins over everything", () => {
    expect(
      shouldPush({
        mention: true,
        channelKind: "dm",
        manualStatus: "dnd",
        level: "all",
      }),
    ).toBe(false);
  });

  it("invisible is not DND — an invisible-and-offline user still gets pushed", () => {
    expect(
      shouldPush({
        mention: true,
        channelKind: "server",
        manualStatus: "invisible",
        level: "all",
      }),
    ).toBe(true);
  });
});

describe("resolvePushLevel", () => {
  const serverId = "11111111-1111-1111-1111-111111111111";
  const channelId = "22222222-2222-2222-2222-222222222222";

  it("defaults to 'all' with nothing stored", () => {
    expect(resolvePushLevel(null, serverId, channelId)).toBe("all");
    expect(resolvePushLevel({}, serverId, channelId)).toBe("all");
  });

  it("most specific wins: channel over server over default", () => {
    const settings = {
      notifications: {
        default: "none" as const,
        servers: { [serverId]: "mentions" as const },
        channels: { [channelId]: "all" as const },
      },
    };
    expect(resolvePushLevel(settings, serverId, channelId)).toBe("all");
    expect(
      resolvePushLevel(settings, serverId, "33333333-3333-3333-3333-333333333333"),
    ).toBe("mentions");
    expect(resolvePushLevel(settings, null, "44444444-4444-4444-4444-444444444444")).toBe(
      "none",
    );
  });
});

describe("buildPushPayload / truncation", () => {
  const base = {
    channelId: "22222222-2222-2222-2222-222222222222",
    serverId: "11111111-1111-1111-1111-111111111111",
  };

  it("names channel, server and author for a server mention — no message text", () => {
    const payload = buildPushPayload({
      ...base,
      channelKind: "server",
      mention: true,
      reply: false,
      dmDetails: false,
      channelName: "general",
      serverName: "Friends",
      authorName: "Ana",
    });
    expect(payload.title).toBe("#general — Friends");
    expect(payload.body).toBe("Ana mentioned you");
    expect(payload.path).toBe(
      `/app/server/${base.serverId}/channel/${base.channelId}`,
    );
    expect(payload.tag).toBe(base.channelId);
  });

  it("says 'replied' for a reply", () => {
    const payload = buildPushPayload({
      ...base,
      channelKind: "server",
      mention: false,
      reply: true,
      dmDetails: false,
      channelName: "general",
      serverName: "Friends",
      authorName: "Ana",
    });
    expect(payload.body).toBe("Ana replied to you");
  });

  it("a DM push carries no sender by default", () => {
    const payload = buildPushPayload({
      ...base,
      serverId: null,
      channelKind: "dm",
      mention: false,
      reply: false,
      dmDetails: false,
      channelName: null,
      serverName: null,
      authorName: "Ana",
    });
    expect(payload.title).toBe("pqp");
    expect(payload.body).toBe("New direct message");
    expect(JSON.stringify(payload)).not.toContain("Ana");
    expect(payload.path).toBe(`/app/dm/${base.channelId}`);
  });

  it("names the sender only when dmDetails is on", () => {
    const payload = buildPushPayload({
      ...base,
      serverId: null,
      channelKind: "dm",
      mention: false,
      reply: false,
      dmDetails: true,
      channelName: null,
      serverName: null,
      authorName: "Ana",
    });
    expect(payload.title).toBe("Ana");
    expect(payload.body).toBe("Sent you a direct message");
  });

  it("truncates long labels rather than shipping them", () => {
    const long = "x".repeat(300);
    expect(truncateLabel(long).length).toBe(64);
    expect(truncateLabel(long).endsWith("…")).toBe(true);
    expect(truncateLabel("short")).toBe("short");

    const payload = buildPushPayload({
      ...base,
      channelKind: "server",
      mention: true,
      reply: false,
      dmDetails: false,
      channelName: long,
      serverName: long,
      authorName: long,
    });
    // Both halves of the title truncated independently, plus the separator.
    expect(payload.title.length).toBeLessThanOrEqual(64 + 64 + 4);
    expect(payload.body.length).toBeLessThanOrEqual(64 + 20);
  });
});

// ----------------------------------------------------------- configuration

describe("VAPID configuration", () => {
  afterEach(() => {
    clearVapidEnv();
  });

  it("is disabled unless all three variables are present", () => {
    clearVapidEnv();
    expect(isPushEnabled()).toBe(false);
    process.env.VAPID_PUBLIC_KEY = "pk";
    process.env.VAPID_PRIVATE_KEY = "sk";
    expect(isPushEnabled()).toBe(false);
    process.env.VAPID_SUBJECT = "mailto:x@y.z";
    expect(isPushEnabled()).toBe(true);
    expect(getVapidPublicKey()).toBe("pk");
  });

  it("never exposes the public key while disabled", () => {
    clearVapidEnv();
    expect(getVapidPublicKey()).toBe(null);
  });
});

// ------------------------------------------------------------- integration

describeDb("web push fan-out", () => {
  let ana: { id: string };
  let bea: { id: string };
  let caio: { id: string };
  let serverId: string;
  let channelId: string;
  let beaUsername: string;

  /** Every payload the stubbed vendor was handed, in order. */
  let sent: {
    userId: string;
    endpoint: string;
    payload: Record<string, unknown>;
    delivery: { ttlSeconds: number; urgency: string };
  }[];
  /** Users the stubbed cluster registry claims are connected somewhere. */
  let online: Set<string>;
  /** Every APNs request the fake HTTP/2 layer was handed. */
  let apnsSent: ApnsRequest[];
  /** Per-device-token answers; anything unlisted is a 200. */
  let apnsAnswers: Map<string, { status: number; reason: string | null }>;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    setVapidEnv();
    sent = [];
    online = new Set();
    setPushSenderForTests(async (subscription, payload, _config, delivery) => {
      sent.push({
        userId: subscription.user_id,
        endpoint: subscription.endpoint,
        payload: JSON.parse(payload) as Record<string, unknown>,
        delivery,
      });
    });
    setLiveSocketProbeForTests((userId) => online.has(userId));

    // APNs is configured for every case here. The two legs are independent, so
    // "web only" and "APNs only" are asserted explicitly in the cases that care
    // by clearing one env — leaving both on by default is what makes the
    // ordinary assertions prove the fan-out reaches both.
    apnsSent = [];
    apnsAnswers = new Map();
    setApnsEnv();
    resetApnsJwtCacheForTests();
    setApnsTransportForTests(async (request) => {
      apnsSent.push(request);
      return (
        apnsAnswers.get(request.deviceToken) ?? { status: 200, reason: null }
      );
    });

    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    const makeUser = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    ana = await makeUser("ana");
    bea = await makeUser("bea");
    caio = await makeUser("caio");

    const created = await createServer("Friends", ana.id);
    serverId = created.server.id;
    channelId = created.channels.find((c) => c.type === "text")!.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [serverId, bea.id, caio.id],
    );

    const row = await getPool().query<{ username: string }>(
      `SELECT username FROM users WHERE id = $1`,
      [bea.id],
    );
    beaUsername = row.rows[0]!.username;
  });

  afterEach(() => {
    clearVapidEnv();
    clearApnsEnv();
    setPushSenderForTests(null);
    setLiveSocketProbeForTests(null);
    setApnsTransportForTests(null);
    resetApnsJwtCacheForTests();
  });

  function audienceOf(
    kind: "server" | "dm" | "group",
    ids: string[],
    server: string | null = kind === "server" ? serverId : null,
  ): ChannelAudienceView {
    const set = new Set(ids);
    return {
      serverId: server,
      kind,
      has: (userId) => set.has(userId),
      get userIds() {
        return [...set];
      },
    };
  }

  async function subscribe(userId: string, endpoint = `https://push.example/${userId}`) {
    await savePushSubscription(userId, {
      endpoint,
      keys: { p256dh: "p256dh-key", auth: "auth-key" },
    });
    return endpoint;
  }

  /** A device token that satisfies the schema's hex/length rule. */
  function deviceToken(seed: string): string {
    return seed.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "a");
  }

  async function registerPhone(userId: string, seed = userId) {
    const token = deviceToken(seed);
    await saveApnsSubscription(userId, token);
    return token;
  }

  function serverEvent(overrides: Partial<Parameters<typeof sendChannelPush>[0]> = {}) {
    return {
      channelId,
      audience: audienceOf("server", [ana.id, bea.id, caio.id]),
      authorId: ana.id,
      mentionedUsernames: [] as string[],
      repliedToUserId: null,
      blockerIds: new Set<string>(),
      ...overrides,
    };
  }

  // -------------------------------------------------- the who-to-push matrix

  it("pushes a mention to an offline member and nobody else", async () => {
    await subscribe(bea.id);
    await subscribe(caio.id);

    await sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] }));

    expect(sent.map((s) => s.userId)).toEqual([bea.id]);
    expect(sent[0]!.payload.title).toBe("#general — Friends");
    expect(sent[0]!.payload.body).toBe("ana mentioned you");
    expect(sent[0]!.payload.path).toBe(`/app/server/${serverId}/channel/${channelId}`);
  });

  it("pushes a reply to its target", async () => {
    await subscribe(caio.id);

    await sendChannelPush(serverEvent({ repliedToUserId: caio.id }));

    expect(sent.map((s) => s.userId)).toEqual([caio.id]);
    expect(sent[0]!.payload.body).toBe("ana replied to you");
  });

  it("a plain server-channel message pushes nobody, subscriptions or not", async () => {
    await subscribe(bea.id);
    await subscribe(caio.id);

    await sendChannelPush(serverEvent());

    expect(sent).toEqual([]);
  });

  it("skips anyone with a live socket anywhere in the cluster", async () => {
    await subscribe(bea.id);
    online.add(bea.id);

    await sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] }));

    expect(sent).toEqual([]);
  });

  it("never pushes the author, even self-mentioned", async () => {
    await subscribe(ana.id);
    const anaUsername = (
      await getPool().query<{ username: string }>(
        `SELECT username FROM users WHERE id = $1`,
        [ana.id],
      )
    ).rows[0]!.username;

    await sendChannelPush(serverEvent({ mentionedUsernames: [anaUsername] }));

    expect(sent).toEqual([]);
  });

  it("a block silences the phone like it silences the badge", async () => {
    await subscribe(bea.id);

    await sendChannelPush(
      serverEvent({
        mentionedUsernames: [beaUsername],
        blockerIds: new Set([bea.id]),
      }),
    );

    expect(sent).toEqual([]);
  });

  it("skips a mention of somebody outside the audience", async () => {
    await subscribe(bea.id);

    await sendChannelPush(
      serverEvent({
        audience: audienceOf("server", [ana.id, caio.id]),
        mentionedUsernames: [beaUsername],
      }),
    );

    expect(sent).toEqual([]);
  });

  it("respects DND read from stored preferences at send time", async () => {
    await subscribe(bea.id);
    await getPool().query(
      `INSERT INTO user_preferences (user_id, settings)
       VALUES ($1, '{"status":"dnd"}'::jsonb)`,
      [bea.id],
    );

    await sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] }));

    expect(sent).toEqual([]);
  });

  it("respects a per-channel 'none' level", async () => {
    await subscribe(bea.id);
    await getPool().query(
      `INSERT INTO user_preferences (user_id, settings)
       VALUES ($1, $2::jsonb)`,
      [bea.id, JSON.stringify({ notifications: { channels: { [channelId]: "none" } } })],
    );

    await sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] }));

    expect(sent).toEqual([]);
  });

  // ------------------------------------------------------------------- DMs

  it("pushes a DM to its offline recipient, content-free by default", async () => {
    const conversation = await openConversation(ana.id, [bea.id]);
    await subscribe(bea.id);

    await sendChannelPush({
      channelId: conversation.channelId,
      audience: audienceOf("dm", [ana.id, bea.id]),
      authorId: ana.id,
      mentionedUsernames: [],
      repliedToUserId: null,
      blockerIds: new Set(),
    });

    expect(sent.map((s) => s.userId)).toEqual([bea.id]);
    expect(sent[0]!.payload.title).toBe("pqp");
    expect(sent[0]!.payload.body).toBe("New direct message");
    expect(JSON.stringify(sent[0]!.payload)).not.toContain("ana");
    expect(sent[0]!.payload.path).toBe(`/app/dm/${conversation.channelId}`);
    // A message can be hours late and still worth reading: day-long TTL,
    // normal urgency. The contrast with the call delivery below is the point.
    expect(sent[0]!.delivery).toEqual({
      ttlSeconds: PUSH_TTL_SECONDS,
      urgency: "normal",
    });
  });

  it("names the sender once dmDetails is opted into", async () => {
    const conversation = await openConversation(ana.id, [bea.id]);
    await subscribe(bea.id);
    await savePushSettings(bea.id, { dmDetails: true });

    await sendChannelPush({
      channelId: conversation.channelId,
      audience: audienceOf("dm", [ana.id, bea.id]),
      authorId: ana.id,
      mentionedUsernames: [],
      repliedToUserId: null,
      blockerIds: new Set(),
    });

    expect(sent[0]!.payload.title).toBe("ana");
    expect(sent[0]!.payload.body).toBe("Sent you a direct message");
  });

  it("a DM turned down to 'mentions' stays quiet for plain messages", async () => {
    const conversation = await openConversation(ana.id, [bea.id]);
    await subscribe(bea.id);
    await getPool().query(
      `INSERT INTO user_preferences (user_id, settings)
       VALUES ($1, $2::jsonb)`,
      [
        bea.id,
        JSON.stringify({
          notifications: { channels: { [conversation.channelId]: "mentions" } },
        }),
      ],
    );

    await sendChannelPush({
      channelId: conversation.channelId,
      audience: audienceOf("dm", [ana.id, bea.id]),
      authorId: ana.id,
      mentionedUsernames: [],
      repliedToUserId: null,
      blockerIds: new Set(),
    });

    expect(sent).toEqual([]);
  });

  // ---------------------------------------------------------- incoming calls

  it("a call push reaches the offline rung participant and skips the online one", async () => {
    const conversation = await openConversation(ana.id, [bea.id, caio.id]);
    await subscribe(bea.id);
    await subscribe(caio.id);
    online.add(caio.id);

    await sendCallPush({
      conversationId: conversation.channelId,
      kind: "group",
      rungUserIds: [bea.id, caio.id],
      callerName: "ana",
    });

    expect(sent.map((s) => s.userId)).toEqual([bea.id]);
    expect(sent[0]!.payload.title).toBe("ana");
    expect(sent[0]!.payload.body).toBe("Incoming group call");
    expect(sent[0]!.payload.path).toBe(`/app/dm/${conversation.channelId}`);
  });

  it("travels short and urgent: ring-length TTL, high urgency", async () => {
    const conversation = await openConversation(ana.id, [bea.id]);
    await subscribe(bea.id);

    await sendCallPush({
      conversationId: conversation.channelId,
      kind: "dm",
      rungUserIds: [bea.id],
      callerName: "ana",
    });

    expect(sent[0]!.payload.body).toBe("Incoming call");
    expect(sent[0]!.delivery).toEqual({
      ttlSeconds: CALL_PUSH_TTL_SECONDS,
      urgency: "high",
    });
    // The TTL only makes sense on one side of the ring timeout (45s): a call
    // push the vendor may hold for longer than the ring lives is a push about
    // a call that no longer exists.
    expect(CALL_PUSH_TTL_SECONDS).toBe(50);
  });

  it("stored DND is caught here: never rung means never pushed, even disconnected", async () => {
    // The ring excludes DND via the live status registry, but a disconnected
    // user reads as plain "offline" there whatever their manual status says —
    // so a stored-DND user CAN arrive in `rungUserIds`, and this filter is
    // the only thing between them and a buzz they asked not to get.
    const conversation = await openConversation(ana.id, [bea.id]);
    await subscribe(bea.id);
    await getPool().query(
      `INSERT INTO user_preferences (user_id, settings)
       VALUES ($1, '{"status":"dnd"}'::jsonb)`,
      [bea.id],
    );

    await sendCallPush({
      conversationId: conversation.channelId,
      kind: "dm",
      rungUserIds: [bea.id],
      callerName: "ana",
    });

    expect(sent).toEqual([]);
  });

  it("the call push and the missed-call push share the conversation id as tag", async () => {
    // Same tag means the vendor REPLACES "Incoming call" with the missed-call
    // notice instead of stacking the two — asserted against both builders'
    // real output, not assumed.
    const conversation = await openConversation(ana.id, [bea.id]);
    await subscribe(bea.id);

    await sendCallPush({
      conversationId: conversation.channelId,
      kind: "dm",
      rungUserIds: [bea.id],
      callerName: "ana",
    });
    // The missed-call record travels the ordinary DM message path.
    await sendChannelPush({
      channelId: conversation.channelId,
      audience: audienceOf("dm", [ana.id, bea.id]),
      authorId: ana.id,
      mentionedUsernames: [],
      repliedToUserId: null,
      blockerIds: new Set(),
    });

    expect(sent.length).toBe(2);
    expect(sent[0]!.payload.tag).toBe(conversation.channelId);
    expect(sent[1]!.payload.tag).toBe(conversation.channelId);
  });

  it("a call names its caller even with dmDetails off, and nothing else", async () => {
    const payload = buildCallPushPayload({
      conversationId: "55555555-5555-5555-5555-555555555555",
      kind: "dm",
      callerName: "x".repeat(300),
    });
    expect(payload.title.length).toBe(64);
    expect(payload.body).toBe("Incoming call");
    expect(
      buildCallPushPayload({
        conversationId: "55555555-5555-5555-5555-555555555555",
        kind: "dm",
        callerName: null,
      }).title,
    ).toBe("Someone");
  });

  it("call pushes are inert without VAPID configuration", async () => {
    clearVapidEnv();
    const conversation = await openConversation(ana.id, [bea.id]);
    await subscribe(bea.id);

    await sendCallPush({
      conversationId: conversation.channelId,
      kind: "dm",
      rungUserIds: [bea.id],
      callerName: "ana",
    });

    expect(sent).toEqual([]);
  });

  // ------------------------------------------------------ inert / lifecycle

  it("is completely inert without VAPID configuration", async () => {
    clearVapidEnv();
    await subscribe(bea.id);

    await sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] }));

    expect(sent).toEqual([]);
  });

  it("prunes a subscription the vendor reports gone (410/404), keeps it on other failures", async () => {
    const gone = await subscribe(bea.id, "https://push.example/gone");
    await subscribe(bea.id, "https://push.example/flaky");
    setPushSenderForTests(async (subscription: StoredPushSubscription) => {
      if (subscription.endpoint === gone) {
        throw Object.assign(new Error("gone"), { statusCode: 410 });
      }
      throw Object.assign(new Error("boom"), { statusCode: 500 });
    });

    await sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] }));

    const remaining = await listPushSubscriptions(bea.id);
    expect(remaining.map((s) => s.endpoint)).toEqual([
      "https://push.example/flaky",
    ]);
  });

  it("upserting the same endpoint moves it to the signed-in account", async () => {
    const endpoint = await subscribe(ana.id, "https://push.example/shared-device");
    await subscribe(bea.id, endpoint);

    expect(await listPushSubscriptions(ana.id)).toEqual([]);
    const beas = await listPushSubscriptions(bea.id);
    expect(beas.map((s) => s.endpoint)).toEqual([endpoint]);
  });

  it("caps subscriptions per user, dropping the oldest", async () => {
    for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_USER + 1; i += 1) {
      const endpoint = `https://push.example/device-${i}`;
      await subscribe(bea.id, endpoint);
      // Deterministic ages — NOW() ties within one transaction timestamp.
      await getPool().query(
        `UPDATE push_subscriptions
         SET created_at = NOW() - make_interval(mins => $2)
         WHERE endpoint = $1`,
        [endpoint, MAX_PUSH_SUBSCRIPTIONS_PER_USER + 1 - i],
      );
    }
    // One more insert triggers the prune against the aged rows.
    await subscribe(bea.id, "https://push.example/newest");

    const remaining = await listPushSubscriptions(bea.id);
    expect(remaining.length).toBe(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
    expect(remaining.map((s) => s.endpoint)).not.toContain(
      "https://push.example/device-0",
    );
    expect(remaining.map((s) => s.endpoint)).toContain(
      "https://push.example/newest",
    );
  });

  it("delete is scoped to the owner", async () => {
    const endpoint = await subscribe(bea.id);
    await deletePushSubscription(ana.id, endpoint);
    expect((await listPushSubscriptions(bea.id)).length).toBe(1);
    await deletePushSubscription(bea.id, endpoint);
    expect((await listPushSubscriptions(bea.id)).length).toBe(0);
  });

  // ------------------------------------------------------------------ APNs
  //
  // The iOS leg. What these pin is that it is a *leg* and not a second system:
  // the same triggers reach it, the same content-free defaults apply, the same
  // no-live-socket narrowing gates it, and the same row cap bounds it. The
  // HTTP/2 layer is faked (see `setApnsTransportForTests`); the JWT and header
  // construction it would exercise are pinned in apns.test.ts.

  it("registers a device token through the shared route schema", async () => {
    const token = deviceToken("beabea");
    const parsed = pushRegistrationSchema.parse({ platform: "apns", token });
    await savePushRegistration(bea.id, parsed);

    const rows = await listPushSubscriptions(bea.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.platform).toBe("apns");
    expect(rows[0]!.token).toBe(token);
    // The `web` columns stay null — that is the CHECK constraint's whole job.
    expect(rows[0]!.endpoint).toBeNull();
    expect(rows[0]!.p256dh).toBeNull();
  });

  /**
   * The compatibility guarantee of putting both shapes on one route: a body the
   * web client has always sent must still parse as a web subscription, not fall
   * into the APNs member.
   */
  it("still parses a Web Push body, which carries no platform key", async () => {
    const parsed = pushRegistrationSchema.parse({
      endpoint: "https://push.example/browser",
      keys: { p256dh: "p", auth: "a" },
    });
    await savePushRegistration(bea.id, parsed);

    const rows = await listPushSubscriptions(bea.id);
    expect(rows[0]!.platform).toBe("web");
    expect(rows[0]!.token).toBeNull();
  });

  it("rejects a device token that is not lowercase hex", () => {
    expect(() =>
      pushRegistrationSchema.parse({
        platform: "apns",
        token: "NOTHEX".padEnd(64, "0"),
      }),
    ).toThrow();
    expect(() =>
      pushRegistrationSchema.parse({ platform: "apns", token: "abcd" }),
    ).toThrow();
  });

  it("a mention reaches a phone and a browser from one fan-out", async () => {
    await subscribe(bea.id);
    const token = await registerPhone(bea.id);

    await sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] }));

    expect(sent.map((s) => s.userId)).toEqual([bea.id]);
    expect(apnsSent).toHaveLength(1);
    expect(apnsSent[0]!.deviceToken).toBe(token);
    const body = JSON.parse(apnsSent[0]!.body) as {
      aps: { alert: { title: string; body: string }; "thread-id": string };
      path: string;
    };
    // The same words the browser leg was handed — one payload, two envelopes.
    expect(body.aps.alert.body).toBe(sent[0]!.payload.body);
    expect(body.path).toBe(sent[0]!.payload.path);
    expect(body.aps["thread-id"]).toBe(channelId);
  });

  it("says nothing about a DM by default, exactly as the browser leg does", async () => {
    const conversation = await openConversation(ana.id, [bea.id]);
    await registerPhone(bea.id);

    await sendChannelPush({
      channelId: conversation.channelId,
      audience: audienceOf("dm", [ana.id, bea.id], null),
      authorId: ana.id,
      mentionedUsernames: [],
      repliedToUserId: null,
      blockerIds: new Set<string>(),
    });

    const body = JSON.parse(apnsSent[0]!.body) as {
      aps: { alert: { title: string; body: string } };
    };
    expect(body.aps.alert).toEqual({
      title: "pqp",
      body: "New direct message",
    });
  });

  it("does not reach a phone whose owner has a live socket anywhere", async () => {
    await registerPhone(bea.id);
    online.add(bea.id);

    await sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] }));

    expect(apnsSent).toEqual([]);
  });

  it("gives a call ring priority 10, the ring's own expiry, and the conversation as collapse id", async () => {
    const conversation = await openConversation(ana.id, [bea.id]);
    await registerPhone(bea.id);
    const before = Math.floor(Date.now() / 1000);

    await sendCallPush({
      conversationId: conversation.channelId,
      kind: "dm",
      rungUserIds: [bea.id],
      callerName: "ana",
    });

    expect(apnsSent).toHaveLength(1);
    const headers = apnsSent[0]!.headers;
    expect(headers["apns-push-type"]).toBe("alert");
    expect(headers["apns-priority"]).toBe("10");
    expect(headers["apns-collapse-id"]).toBe(conversation.channelId);
    // Expiry is the 50s ring, not the 24h message TTL: a call push delivered
    // after the ring times out is not late, it is wrong.
    const expiry = Number(headers["apns-expiration"]);
    expect(expiry).toBeGreaterThanOrEqual(before + CALL_PUSH_TTL_SECONDS);
    expect(expiry).toBeLessThanOrEqual(
      before + CALL_PUSH_TTL_SECONDS + 5,
    );
  });

  it("gives a message the long TTL, and both legs agree on it", async () => {
    await subscribe(bea.id);
    await registerPhone(bea.id);
    const before = Math.floor(Date.now() / 1000);

    await sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] }));

    expect(sent[0]!.delivery.ttlSeconds).toBe(PUSH_TTL_SECONDS);
    const expiry = Number(apnsSent[0]!.headers["apns-expiration"]);
    expect(expiry).toBeGreaterThanOrEqual(before + PUSH_TTL_SECONDS);
  });

  /**
   * The garbage collection. These rows have no other lifecycle: nothing else
   * knows a phone was wiped, so a token that is never pruned is a permanent
   * per-message round trip to a device that no longer exists.
   */
  it("prunes a device token on 410 Unregistered and on 400 BadDeviceToken", async () => {
    const unregistered = await registerPhone(bea.id, "aaaa");
    const badToken = await registerPhone(bea.id, "bbbb");
    const healthy = await registerPhone(bea.id, "cccc");
    apnsAnswers.set(unregistered, { status: 410, reason: "Unregistered" });
    apnsAnswers.set(badToken, { status: 400, reason: "BadDeviceToken" });

    await sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] }));

    const remaining = await listPushSubscriptions(bea.id);
    expect(remaining.map((r) => r.token)).toEqual([healthy]);
  });

  it("keeps a device token through a failure it would survive", async () => {
    const token = await registerPhone(bea.id);
    apnsAnswers.set(token, { status: 429, reason: "TooManyRequests" });

    await sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] }));

    expect((await listPushSubscriptions(bea.id)).map((r) => r.token)).toEqual([
      token,
    ]);
  });

  it("survives a transport failure without taking the fan-out down", async () => {
    await subscribe(bea.id);
    await registerPhone(bea.id);
    setApnsTransportForTests(async () => {
      throw new Error("APNs request timed out");
    });

    await expect(
      sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] })),
    ).resolves.toBeUndefined();
    // The browser leg still went out — one dead vendor must not silence both.
    expect(sent.map((s) => s.userId)).toEqual([bea.id]);
  });

  it("upserting the same device token moves the phone to the signed-in account", async () => {
    const token = await registerPhone(ana.id, "shared");
    await saveApnsSubscription(bea.id, token);

    expect(await listPushSubscriptions(ana.id)).toEqual([]);
    expect((await listPushSubscriptions(bea.id)).map((r) => r.token)).toEqual([
      token,
    ]);
  });

  it("apns delete is scoped to the owner", async () => {
    const token = await registerPhone(bea.id);
    await deleteApnsSubscription(ana.id, token);
    expect(await listPushSubscriptions(bea.id)).toHaveLength(1);
    await deleteApnsSubscription(bea.id, token);
    expect(await listPushSubscriptions(bea.id)).toHaveLength(0);
  });

  it("the per-user cap counts phones and browsers together", async () => {
    for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_USER; i += 1) {
      const endpoint = `https://push.example/device-${i}`;
      await subscribe(bea.id, endpoint);
      await getPool().query(
        `UPDATE push_subscriptions
         SET created_at = NOW() - make_interval(mins => $2)
         WHERE endpoint = $1`,
        [endpoint, MAX_PUSH_SUBSCRIPTIONS_PER_USER - i],
      );
    }
    const token = await registerPhone(bea.id);

    const remaining = await listPushSubscriptions(bea.id);
    expect(remaining).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
    // The phone is the newest registration, so it is the one that survives.
    expect(remaining.map((r) => r.token)).toContain(token);
    expect(remaining.map((r) => r.endpoint)).not.toContain(
      "https://push.example/device-0",
    );
  });

  it("is inert without APNs configuration", async () => {
    clearApnsEnv();
    await registerPhone(bea.id);

    await sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] }));

    expect(apnsSent).toEqual([]);
  });

  /**
   * The reason `isAnyPushEnabled` exists. Guarding the fan-out on VAPID alone
   * would make a deployment that only ever wanted native pushes silently send
   * none — and nothing about that failure points at the VAPID env.
   */
  it("pushes to phones on a deployment that has no VAPID keys at all", async () => {
    clearVapidEnv();
    expect(isPushEnabled()).toBe(false);
    expect(isAnyPushEnabled()).toBe(true);
    await subscribe(bea.id);
    await registerPhone(bea.id);

    await sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] }));

    expect(sent).toEqual([]);
    expect(apnsSent).toHaveLength(1);
  });

  it("is inert when neither leg is configured", async () => {
    clearVapidEnv();
    clearApnsEnv();
    expect(isAnyPushEnabled()).toBe(false);
    await subscribe(bea.id);
    await registerPhone(bea.id);

    await sendChannelPush(serverEvent({ mentionedUsernames: [beaUsername] }));

    expect(sent).toEqual([]);
    expect(apnsSent).toEqual([]);
  });

  it("builds an aps envelope that carries an alert, a thread and the route", () => {
    expect(
      buildApnsBody({
        title: "ana",
        body: "Sent you a direct message",
        path: "/app/dm/abc",
        tag: "abc",
      }),
    ).toEqual({
      aps: {
        alert: { title: "ana", body: "Sent you a direct message" },
        sound: "default",
        "thread-id": "abc",
      },
      path: "/app/dm/abc",
      tag: "abc",
    });
  });

  it("push settings round-trip through user_preferences without clobbering others", async () => {
    await getPool().query(
      `INSERT INTO user_preferences (user_id, settings)
       VALUES ($1, '{"theme":"light"}'::jsonb)`,
      [bea.id],
    );
    const saved = await savePushSettings(bea.id, { dmDetails: true });
    expect(saved.dmDetails).toBe(true);

    const row = await getPool().query<{ settings: Record<string, unknown> }>(
      `SELECT settings FROM user_preferences WHERE user_id = $1`,
      [bea.id],
    );
    expect(row.rows[0]!.settings.theme).toBe("light");
    expect(wantsDmDetails(row.rows[0]!.settings)).toBe(true);
  });
});
