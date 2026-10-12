import { describe, expect, it } from "vitest";
import { chatServerMessageSchema } from "./chat.js";
import { messageSchema } from "./api.js";
import { createReportSchema, REPORT_REASONS } from "./reports.js";
import { Permission, PERMISSION_DEFAULT_EVERYONE, hasPermission } from "./permissions.js";
import {
  STORY_MAX_BYTES,
  STORY_MAX_SERVER_AUDIENCES,
  STORY_MAX_VIDEO_MS,
  STORY_REACTIONS,
  STORY_VIEWS_BATCH_MAX,
  createStorySchema,
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
