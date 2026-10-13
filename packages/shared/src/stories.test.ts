import { describe, expect, it } from "vitest";
import { chatServerMessageSchema } from "./chat.js";
import { messageSchema } from "./api.js";
import { createReportSchema, REPORT_REASONS } from "./reports.js";
import { Permission, PERMISSION_DEFAULT_EVERYONE, hasPermission } from "./permissions.js";
import {
  STORY_LAYERS_MAX,
  STORY_LAYER_IMAGES_MAX,
  STORY_LAYER_MAX_BYTES,
  STORY_MAX_BYTES,
  STORY_MAX_SERVER_AUDIENCES,
  STORY_MAX_VIDEO_MS,
  STORY_REACTIONS,
  STORY_TEXT_MAX,
  STORY_VIEWS_BATCH_MAX,
  createStoryResponseSchema,
  createStorySchema,
  storiesConfigSchema,
  storyLayerInputSchema,
  sniffStoryMediaType,
  storiesUpdateSchema,
  storyReactionSchema,
  storyReplySchema,
  storySchema,
  storyStickerSchema,
  storyStripSchema,
  storyTextDisplayMs,
  storyViewsBatchSchema,
} from "./stories.js";

const SERVER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "33333333-3333-4333-8333-333333333333";
const STORY = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

const photo = {
  kind: "image",
  audiences: { serverIds: [SERVER] },
  media: { contentType: "image/jpeg", byteSize: 400_000, width: 1080, height: 1440 },
};

describe("createStorySchema", () => {
  it("takes a photo to one server, replies on by default, no friends", () => {
    const parsed = createStorySchema.parse(photo);
    expect(parsed.repliesEnabled).toBe(true);
    expect(parsed.audiences).toEqual({ serverIds: [SERVER], friends: false });
  });

  it("takes a text card to friends only", () => {
    const parsed = createStorySchema.parse({
      kind: "text",
      text: "  bora jogar hoje?  ",
      background: "lime",
      audiences: { friends: true },
    });
    expect(parsed.text).toBe("bora jogar hoje?");
    expect(parsed.audiences.serverIds).toEqual([]);
  });

  it("refuses a story with no audience at all", () => {
    expect(
      createStorySchema.safeParse({ ...photo, audiences: { serverIds: [], friends: false } })
        .success,
    ).toBe(false);
  });

  it("refuses the same server twice and more than the cap", () => {
    expect(
      createStorySchema.safeParse({ ...photo, audiences: { serverIds: [SERVER, SERVER] } })
        .success,
    ).toBe(false);
    const many = Array.from(
      { length: STORY_MAX_SERVER_AUDIENCES + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(createStorySchema.safeParse({ ...photo, audiences: { serverIds: many } }).success).toBe(
      false,
    );
  });

  it("caps video at 30 s and needs its duration", () => {
    const video = {
      kind: "video",
      audiences: { serverIds: [SERVER] },
      media: {
        contentType: "video/mp4",
        byteSize: 4_000_000,
        width: 720,
        height: 1280,
        durationMs: STORY_MAX_VIDEO_MS,
      },
    };
    expect(createStorySchema.safeParse(video).success).toBe(true);
    expect(
      createStorySchema.safeParse({
        ...video,
        media: { ...video.media, durationMs: STORY_MAX_VIDEO_MS + 1 },
      }).success,
    ).toBe(false);
    const { durationMs: _drop, ...noDuration } = video.media;
    expect(createStorySchema.safeParse({ ...video, media: noDuration }).success).toBe(false);
  });

  it("caps the bytes and refuses a type outside the list", () => {
    expect(
      createStorySchema.safeParse({
        ...photo,
        media: { ...photo.media, byteSize: STORY_MAX_BYTES + 1 },
      }).success,
    ).toBe(false);
    expect(
      createStorySchema.safeParse({
        ...photo,
        media: { ...photo.media, contentType: "image/gif" },
      }).success,
    ).toBe(false);
    expect(
      createStorySchema.safeParse({
        ...photo,
        media: { ...photo.media, contentType: "video/mp4" },
      }).success,
    ).toBe(false);
  });

  it("keeps each kind to its own fields", () => {
    expect(createStorySchema.safeParse({ ...photo, text: "oi" }).success).toBe(false);
    expect(
      createStorySchema.safeParse({
        kind: "text",
        text: "oi",
        background: "night",
        caption: "legenda",
        audiences: { friends: true },
      }).success,
    ).toBe(false);
    expect(
      createStorySchema.safeParse({ kind: "text", text: "oi", audiences: { friends: true } })
        .success,
    ).toBe(false);
    expect(createStorySchema.safeParse({ ...photo, media: undefined }).success).toBe(false);
  });

  it("caps the caption and refuses control characters", () => {
    expect(createStorySchema.safeParse({ ...photo, caption: "a".repeat(201) }).success).toBe(
      false,
    );
    expect(createStorySchema.safeParse({ ...photo, caption: "oi\u0007" }).success).toBe(false);
  });

  it("only accepts a call sticker for a server the story goes to", () => {
    const sticker = { type: "call", serverId: SERVER, channelId: CHANNEL };
    expect(createStorySchema.safeParse({ ...photo, sticker }).success).toBe(true);
    expect(
      createStorySchema.safeParse({ ...photo, sticker: { ...sticker, serverId: OTHER } }).success,
    ).toBe(false);
  });
});

describe("stickers", () => {
  it("discriminates on type and refuses one it does not know", () => {
    expect(
      storyStickerSchema.parse({ type: "call", serverId: SERVER, channelId: CHANNEL }).type,
    ).toBe("call");
    expect(storyStickerSchema.safeParse({ type: "poll", question: "?" }).success).toBe(false);
  });
});

describe("reactions, views and replies", () => {
  it("has exactly the six house reactions, and null clears", () => {
    expect(STORY_REACTIONS).toEqual(["gg", "fire", "joy", "wow", "skull", "clap"]);
    expect(storyReactionSchema.parse({ reaction: null }).reaction).toBeNull();
    expect(storyReactionSchema.safeParse({ reaction: "heart" }).success).toBe(false);
  });

  it("batches views up to the cap", () => {
    const ids = Array.from({ length: STORY_VIEWS_BATCH_MAX + 1 }, () => STORY);
    expect(storyViewsBatchSchema.safeParse({ storyIds: ids }).success).toBe(false);
    expect(storyViewsBatchSchema.safeParse({ storyIds: [] }).success).toBe(false);
  });

  it("takes an idempotency key on create and on reply", () => {
    expect(
      createStorySchema.parse({ ...photo, requestId: STORY }).requestId,
    ).toBe(STORY);
    expect(createStorySchema.safeParse({ ...photo, requestId: "nope" }).success).toBe(false);
    expect(storyReplySchema.parse({ text: "oi", nonce: "abc" }).nonce).toBe("abc");
    expect(storyReplySchema.safeParse({ text: "oi", nonce: "x".repeat(65) }).success).toBe(false);
  });

  it("refuses an empty reply", () => {
    expect(storyReplySchema.safeParse({ text: "   " }).success).toBe(false);
    expect(storyReplySchema.parse({ text: " que isso " }).text).toBe("que isso");
  });
});

describe("the strip and the story", () => {
  it("parses a strip that is off from `{ enabled: false }` alone", () => {
    expect(storyStripSchema.parse({ enabled: false })).toEqual({
      enabled: false,
      canPost: false,
      own: null,
      items: [],
      firstRunHint: false,
    });
  });

  it("parses a live story as a viewer gets it", () => {
    const story = storySchema.parse({
      id: STORY,
      author: { id: USER, displayName: "Bia", avatarUrl: null },
      kind: "text",
      caption: null,
      text: "on hoje 22h",
      background: "grape",
      media: null,
      sticker: null,
      call: null,
      publishedAt: "2026-10-11T12:00:00.000Z",
      expiresAt: "2026-10-12T12:00:00.000Z",
      audiences: [{ kind: "server", serverId: SERVER, serverName: "QG" }],
      viewer: {
        seen: false,
        reaction: null,
        canReply: false,
        replyBlockedReason: "dm_closed",
        canModerate: [],
      },
      own: null,
    });
    expect(story.author.handle).toBeNull();
    expect(story.viewer.canSaveToBau).toEqual([]);
  });
});

describe("the frame", () => {
  it("is a chat frame clients parse", () => {
    const frame = chatServerMessageSchema.parse({
      type: "stories-update",
      scope: "server",
      serverId: SERVER,
    });
    expect(frame.type).toBe("stories-update");
    expect(storiesUpdateSchema.safeParse({ type: "stories-update", scope: "views" }).success).toBe(
      false,
    );
  });

  it("carries a serverId exactly when the scope is a server", () => {
    expect(
      storiesUpdateSchema.safeParse({ type: "stories-update", scope: "server", serverId: SERVER })
        .success,
    ).toBe(true);
    expect(storiesUpdateSchema.safeParse({ type: "stories-update", scope: "server" }).success).toBe(
      false,
    );
    expect(
      storiesUpdateSchema.safeParse({ type: "stories-update", scope: "friends", serverId: SERVER })
        .success,
    ).toBe(false);
    expect(storiesUpdateSchema.safeParse({ type: "stories-update", scope: "own" }).success).toBe(
      true,
    );
  });
});

describe("what the rest of the contract gained", () => {
  it("a message may quote a story, and older payloads still parse", () => {
    const base = {
      id: STORY,
      channelId: CHANNEL,
      authorId: USER,
      authorName: "Bia",
      authorTag: null,
      authorAvatarUrl: null,
      body: "que isso",
      createdAt: "2026-10-11T12:00:00.000Z",
    };
    expect(messageSchema.parse(base).storyId).toBeUndefined();
    expect(messageSchema.parse({ ...base, storyId: STORY }).storyId).toBe(STORY);
  });

  it("a story can be reported, with or without the server it was seen in", () => {
    expect(
      createReportSchema.parse({ subjectType: "story", storyId: STORY, reason: "minor_sexual" })
        .subjectType,
    ).toBe("story");
    expect(
      createReportSchema.safeParse({
        subjectType: "story",
        storyId: STORY,
        serverId: SERVER,
        reason: "harassment",
      }).success,
    ).toBe(true);
    expect(REPORT_REASONS.at(-1)).toBe("other");
  });

  it("POST_STORIES is bit 25 and on for @everyone", () => {
    expect(Permission.POST_STORIES).toBe(1n << 25n);
    expect(hasPermission(PERMISSION_DEFAULT_EVERYONE, Permission.POST_STORIES)).toBe(true);
  });
});

describe("sniffing and pacing", () => {
  it("knows the four allowed types by their bytes", () => {
    expect(sniffStoryMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(
      sniffStoryMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("image/png");
    expect(
      sniffStoryMediaType(
        Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe("image/webp");
    const ftyp = (brand: string) =>
      Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...new TextEncoder().encode(brand)]);
    expect(sniffStoryMediaType(ftyp("isom"))).toBe("video/mp4");
    expect(sniffStoryMediaType(ftyp("mp42"))).toBe("video/mp4");
    // An iPhone photo, an AVIF and a QuickTime movie are ISO BMFF too.
    expect(sniffStoryMediaType(ftyp("heic"))).toBeNull();
    expect(sniffStoryMediaType(ftyp("mif1"))).toBeNull();
    expect(sniffStoryMediaType(ftyp("avif"))).toBeNull();
    expect(sniffStoryMediaType(ftyp("qt  "))).toBeNull();
    expect(sniffStoryMediaType(new TextEncoder().encode("GIF89a......"))).toBeNull();
  });

  it("paces a text card by its length, capped at 10 s", () => {
    expect(storyTextDisplayMs("")).toBe(5_000);
    expect(storyTextDisplayMs("a".repeat(20))).toBe(6_000);
    expect(storyTextDisplayMs("a".repeat(280))).toBe(10_000);
  });
});

// ------------------------------------------------------------------ composer v2: layers

const LAYER_ID = "66666666-6666-4666-8666-666666666666";
const geometry = (id = LAYER_ID) => ({ id, x: 0.5, y: 0.5, scale: 1, rotation: 0 });
const nextId = (n: number) => `66666666-6666-4666-8666-6666666666${String(n).padStart(2, "0")}`;

describe("story layers on create (strict)", () => {
  const text = { ...geometry(), type: "text", text: "bora" };
  const upload = { contentType: "image/png", byteSize: 1000, width: 100, height: 100 };

  it("fills the text defaults and keeps the legacy fields working", () => {
    const parsed = createStorySchema.parse({
      kind: "text",
      background: "lime",
      audiences: { serverIds: [SERVER] },
      layers: [text],
    });
    expect(parsed.layers[0]).toMatchObject({
      font: "classic",
      color: "white",
      background: "none",
      align: "center",
      size: 1,
    });
    // `text` is optional for a text card that has a layer, not for one without.
    expect(parsed.text).toBeUndefined();
    expect(
      createStorySchema.safeParse({
        kind: "text",
        background: "lime",
        audiences: { serverIds: [SERVER] },
      }).success,
    ).toBe(false);
    // A photo with no layers is as it always was.
    expect(createStorySchema.parse(photo).layers).toEqual([]);
  });

  it("refuses an unknown type, a bad bound and a free hex color, whole", () => {
    const parse = (layer: unknown) =>
      createStorySchema.safeParse({ ...photo, layers: [layer] }).success;
    expect(parse(text)).toBe(true);
    expect(parse({ ...geometry(), type: "sparkle" })).toBe(false);
    expect(parse({ ...text, scale: 0.19 })).toBe(false);
    expect(parse({ ...text, scale: 5.1 })).toBe(false);
    expect(parse({ ...text, x: -0.01 })).toBe(false);
    expect(parse({ ...text, rotation: 3.2 })).toBe(false);
    expect(parse({ ...text, color: "#ffffff" })).toBe(false);
    expect(parse({ ...text, size: 3.1 })).toBe(false);
    expect(parse({ ...text, text: "x".repeat(STORY_TEXT_MAX + 1) })).toBe(false);
    expect(parse({ ...text, id: "not-a-uuid" })).toBe(false);
    // A 32-bit float pi, which is what a phone sends for "upside down".
    expect(parse({ ...text, rotation: Math.fround(Math.PI) })).toBe(true);
  });

  it("holds the per-type counts and unique ids", () => {
    const many = (n: number, make: (id: string) => object) =>
      createStorySchema.safeParse({
        ...photo,
        layers: Array.from({ length: n }, (_, i) => make(nextId(i))),
      }).success;
    const aText = (id: string) => ({ ...geometry(id), type: "text", text: "a" });
    const anImage = (id: string) => ({ ...geometry(id), type: "image", upload });
    expect(many(STORY_LAYERS_MAX, aText)).toBe(true);
    expect(many(STORY_LAYERS_MAX + 1, aText)).toBe(false);
    expect(many(STORY_LAYER_IMAGES_MAX, anImage)).toBe(true);
    expect(many(STORY_LAYER_IMAGES_MAX + 1, anImage)).toBe(false);
    expect(many(2, (id) => ({ ...geometry(id), type: "drawing", upload }))).toBe(false);
    expect(createStorySchema.safeParse({ ...photo, layers: [text, text] }).success).toBe(false);
  });

  it("takes the call as a layer or a sticker, and makes them agree", () => {
    const callLayer = { ...geometry(), type: "call", serverId: SERVER, channelId: CHANNEL };
    expect(createStorySchema.safeParse({ ...photo, layers: [callLayer] }).success).toBe(true);
    // A call into a server the story does not go to.
    expect(
      createStorySchema.safeParse({ ...photo, layers: [{ ...callLayer, serverId: OTHER }] })
        .success,
    ).toBe(false);
    // Both given: one room.
    expect(
      createStorySchema.safeParse({
        ...photo,
        layers: [callLayer],
        sticker: { type: "call", serverId: SERVER, channelId: OTHER },
      }).success,
    ).toBe(false);
    expect(
      createStorySchema.safeParse({
        ...photo,
        layers: [callLayer],
        sticker: { type: "call", serverId: SERVER, channelId: CHANNEL },
      }).success,
    ).toBe(true);
  });

  it("limits what an image or a drawing may be, and mentions each person once", () => {
    const jpeg = { ...upload, contentType: "image/jpeg" };
    expect(storyLayerInputSchema.safeParse({ ...geometry(), type: "image", upload: jpeg }).success).toBe(true);
    expect(storyLayerInputSchema.safeParse({ ...geometry(), type: "drawing", upload: jpeg }).success).toBe(false);
    expect(storyLayerInputSchema.safeParse({ ...geometry(), type: "drawing", upload }).success).toBe(true);
    expect(
      storyLayerInputSchema.safeParse({
        ...geometry(),
        type: "image",
        upload: { ...upload, byteSize: STORY_LAYER_MAX_BYTES + 1 },
      }).success,
    ).toBe(false);
    expect(
      storyLayerInputSchema.safeParse({
        ...geometry(),
        type: "image",
        upload: { ...upload, contentType: "video/mp4" },
      }).success,
    ).toBe(false);
    expect(
      createStorySchema.safeParse({
        ...photo,
        layers: [
          { ...geometry(nextId(1)), type: "mention", userId: USER },
          { ...geometry(nextId(2)), type: "mention", userId: USER },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("story layers on read (lenient)", () => {
  const known = { ...geometry(), type: "text", text: "oi" };
  const story = {
    id: STORY,
    author: { id: USER, displayName: "Alice", avatarUrl: null },
    kind: "text",
    caption: null,
    text: "oi",
    background: "lime",
    media: null,
    sticker: null,
    call: null,
    publishedAt: null,
    expiresAt: null,
    audiences: [],
    viewer: {
      seen: false,
      reaction: null,
      canReply: false,
      replyBlockedReason: null,
      canModerate: [],
    },
    own: null,
  };

  it("keeps what it understands, in order, and drops the rest", () => {
    const parsed = storySchema.parse({
      ...story,
      layers: [
        known,
        { ...geometry(nextId(1)), type: "hologram", depth: 3 },
        { ...geometry(nextId(2)), type: "text", text: "dois", scale: 99 },
        { ...geometry(nextId(3)), type: "text", text: "tres" },
        "not even an object",
        null,
      ],
    });
    expect(parsed.layers.map((layer) => (layer.type === "text" ? layer.text : layer.type))).toEqual([
      "oi",
      "tres",
    ]);
  });

  it("reads a server that predates layers as no layers and no alt text", () => {
    const parsed = storySchema.parse(story);
    expect(parsed.layers).toEqual([]);
    expect(parsed.altText).toBeNull();
  });

  it("reads an image layer with its url and a mention with its person", () => {
    const parsed = storySchema.parse({
      ...story,
      layers: [
        { ...geometry(nextId(1)), type: "image", url: "https://x/y.jpg", width: 10, height: 20 },
        {
          ...geometry(nextId(2)),
          type: "mention",
          userId: USER,
          user: { id: USER, displayName: "Bob", avatarUrl: null },
        },
        { ...geometry(nextId(3)), type: "image", width: 10, height: 20 },
      ],
    });
    // The third has no url, so it does not parse and is skipped.
    expect(parsed.layers.map((layer) => layer.type)).toEqual(["image", "mention"]);
    expect(parsed.layers[0]).toMatchObject({ shape: "rect" });
  });

  it("answers a create with its layer uploads, empty by default, and a config from an old server with no layersMax", () => {
    expect(
      createStoryResponseSchema.parse({ story: { ...story, layers: [] }, upload: null }).layerUploads,
    ).toEqual([]);
    expect(
      storiesConfigSchema.parse({
        enabled: true,
        friendsEnabled: false,
        mediaEnabled: true,
        videoEnabled: true,
        maxVideoMs: 30000,
        maxBytes: 1,
        ttlHours: 24,
      }).layersMax,
    ).toBeUndefined();
  });
});
