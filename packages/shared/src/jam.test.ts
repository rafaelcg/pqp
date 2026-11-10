import { describe, expect, it } from "vitest";
import { channelTypeSchema } from "./api.js";
import {
  CHAT_SERVER_MESSAGE_TYPES,
  chatServerMessageSchema,
  isChatServerMessage,
} from "./chat.js";
import {
  addJamTrackSchema,
  createJamSongSchema,
  createJamUploadSchema,
  JAM_AUDIO_MAX_BYTES,
  JAM_FRAME_TYPES,
  JAM_INSTRUMENTS,
  JAM_PEAKS_MAX,
  JAM_VIDEO_MAX_BYTES,
  jamFrameSchema,
  jamSongSummarySchema,
  jamTrackEndMs,
  jamTrackPlayedMs,
  jamTrackSchema,
  listJamSongsQuerySchema,
  updateJamSongSchema,
  updateJamTrackSchema,
  type JamSongSummary,
  type JamTrack,
} from "./jam.js";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

const SONG: JamSongSummary = {
  id: ID,
  channelId: ID2,
  serverId: ID2,
  title: "Wonderwall",
  artist: null,
  joinMode: "wanted",
  wantedInstruments: ["bass", "drums"],
  authorId: ID2,
  authorName: "Alice",
  authorAvatarUrl: null,
  createdAt: "2026-11-09T12:00:00.000Z",
  updatedAt: "2026-11-09T12:00:00.000Z",
  trackCount: 1,
  instruments: ["guitar"],
  contributorCount: 1,
  mixDurationMs: 61_000,
};

const TRACK: JamTrack = {
  id: ID,
  songId: ID,
  authorId: ID2,
  authorName: "Alice",
  authorAvatarUrl: null,
  instrument: "guitar",
  label: null,
  audioUrl: "https://bucket.example/a.webm",
  audioContentType: "audio/webm",
  audioBytes: 1000,
  videoUrl: null,
  videoContentType: null,
  videoBytes: null,
  mediaExpiresAt: "2026-11-10T00:00:00.000Z",
  offsetMs: -250,
  trimStartMs: 100,
  trimEndMs: 50,
  durationMs: 61_000,
  gain: 1,
  peaks: [0.1, 0.5],
  inMix: true,
  voteCount: 0,
  createdAt: "2026-11-09T12:00:00.000Z",
};

describe("jam contract", () => {
  it("adds jam to the channel types", () => {
    expect(channelTypeSchema.options).toContain("jam");
  });

  it("every frame is relayable to a channel, and none is in the chat union yet", () => {
    // Relayable is the half that is easy to forget: without it the cluster
    // relay drops a song added on the sibling instance on the floor.
    for (const type of JAM_FRAME_TYPES) {
      expect(CHAT_SERVER_MESSAGE_TYPES, type).toContain(type);
      expect(isChatServerMessage({ type }), type).toBe(true);
    }
    // The union every client is typed against does not carry them (same
    // arrangement as the voice note frames), so no client test starts asking
    // for a branch before a client handles them.
    const frame = { type: "jam-song-deleted", channelId: ID2, songId: ID };
    expect(jamFrameSchema.safeParse(frame).success).toBe(true);
    expect(chatServerMessageSchema.safeParse(frame).success).toBe(false);
  });

  it("parses every frame", () => {
    const frames = [
      { type: "jam-song-created", channelId: ID2, song: SONG },
      { type: "jam-song-updated", channelId: ID2, song: SONG },
      { type: "jam-song-deleted", channelId: ID2, songId: ID },
      { type: "jam-track-added", channelId: ID2, song: SONG, track: TRACK },
      { type: "jam-track-updated", channelId: ID2, song: SONG, track: TRACK },
      { type: "jam-track-deleted", channelId: ID2, song: SONG, trackId: ID },
      { type: "jam-track-votes", channelId: ID2, songId: ID, trackId: ID, voteCount: 3 },
    ];
    expect(frames.map((f) => f.type).sort()).toEqual([...JAM_FRAME_TYPES].sort());
    for (const frame of frames) {
      expect(jamFrameSchema.safeParse(frame).success, frame.type).toBe(true);
    }
  });

  it("reads an instrument a newer server invented as `other`", () => {
    const track = jamTrackSchema.parse({ ...TRACK, instrument: "theremin" });
    expect(track.instrument).toBe("other");
    const song = jamSongSummarySchema.parse({ ...SONG, instruments: ["guitar", "theremin"] });
    expect(song.instruments).toEqual(["guitar", "other"]);
  });

  it("does the timeline arithmetic the header states", () => {
    expect(jamTrackPlayedMs(TRACK)).toBe(60_850);
    expect(jamTrackEndMs(TRACK)).toBe(60_600);
  });
});

describe("jam requests", () => {
  it("a song normalises its text, and an empty artist is an original", () => {
    const song = createJamSongSchema.parse({ title: "  Wonder   wall " });
    expect(song).toEqual({ title: "Wonder wall" });
    expect(createJamSongSchema.parse({ title: "x", artist: "" }).artist).toBeNull();
    expect(createJamSongSchema.parse({ title: "x", artist: null }).artist).toBeNull();
    expect(createJamSongSchema.safeParse({ title: "" }).success).toBe(false);
    expect(createJamSongSchema.safeParse({ title: "a\u0000b" }).success).toBe(false);
  });

  it("`wanted` needs an instrument, and instruments are distinct", () => {
    expect(createJamSongSchema.safeParse({ title: "x", joinMode: "wanted" }).success).toBe(false);
    expect(
      createJamSongSchema.safeParse({
        title: "x",
        joinMode: "wanted",
        wantedInstruments: ["bass"],
      }).success,
    ).toBe(true);
    expect(
      createJamSongSchema.safeParse({
        title: "x",
        joinMode: "wanted",
        wantedInstruments: ["bass", "bass"],
      }).success,
    ).toBe(false);
    // There is no private state: a song is as private as its channel.
    expect(createJamSongSchema.safeParse({ title: "x", joinMode: "private" }).success).toBe(false);
  });

  it("a song patch needs something in it; null clears the artist", () => {
    expect(updateJamSongSchema.safeParse({}).success).toBe(false);
    expect(updateJamSongSchema.parse({ artist: null }).artist).toBeNull();
  });

  it("limits what may be uploaded per kind", () => {
    const ok = { kind: "audio", contentType: "audio/webm", byteSize: JAM_AUDIO_MAX_BYTES };
    expect(createJamUploadSchema.safeParse(ok).success).toBe(true);
    // What the web engine uploads. Refusing it means no browser can post a take.
    expect(createJamUploadSchema.safeParse({ ...ok, contentType: "audio/flac" }).success).toBe(true);
    expect(createJamUploadSchema.safeParse({ ...ok, contentType: "audio/wav" }).success).toBe(false);
    expect(createJamUploadSchema.safeParse({ ...ok, contentType: "video/mp4" }).success).toBe(false);
    expect(
      createJamUploadSchema.safeParse({ kind: "video", contentType: "video/mp4", byteSize: 5 })
        .success,
    ).toBe(true);
    expect(
      createJamUploadSchema.safeParse({ kind: "video", contentType: "audio/webm", byteSize: 5 })
        .success,
    ).toBe(false);
    // The size ceilings are enforced where the object store is asked, so a
    // deployment can set a lower one; the constants are the contract.
    expect(JAM_VIDEO_MAX_BYTES).toBeGreaterThan(JAM_AUDIO_MAX_BYTES);
  });

  it("a track needs sane numbers, and the trims must leave something to play", () => {
    const base = {
      instrument: "guitar",
      audioUploadId: ID,
      durationMs: 10_000,
    };
    const parsed = addJamTrackSchema.parse(base);
    expect(parsed).toMatchObject({ offsetMs: 0, trimStartMs: 0, trimEndMs: 0, gain: 1, peaks: [] });
    expect(addJamTrackSchema.safeParse({ ...base, offsetMs: -1234.5 }).success).toBe(true);
    expect(addJamTrackSchema.safeParse({ ...base, gain: 2.5 }).success).toBe(false);
    expect(addJamTrackSchema.safeParse({ ...base, gain: -1 }).success).toBe(false);
    expect(addJamTrackSchema.safeParse({ ...base, instrument: "kazoo" }).success).toBe(false);
    expect(
      addJamTrackSchema.safeParse({ ...base, trimStartMs: 6_000, trimEndMs: 4_000 }).success,
    ).toBe(false);
    expect(
      addJamTrackSchema.safeParse({ ...base, trimStartMs: 6_000, trimEndMs: 3_999 }).success,
    ).toBe(true);
    expect(addJamTrackSchema.safeParse({ ...base, durationMs: 10 }).success).toBe(false);
    expect(addJamTrackSchema.safeParse({ ...base, durationMs: 11 * 60_000 }).success).toBe(false);
    expect(addJamTrackSchema.safeParse({ ...base, offsetMs: Number.NaN }).success).toBe(false);
    // Whole milliseconds: the stored length is an integer the trims are checked against.
    expect(addJamTrackSchema.safeParse({ ...base, durationMs: 10_000.4 }).success).toBe(false);
  });

  it("peaks are bounded and clamped to what a waveform can be", () => {
    const base = { instrument: "bass", audioUploadId: ID, durationMs: 5_000 };
    expect(
      addJamTrackSchema.safeParse({
        ...base,
        peaks: Array.from({ length: JAM_PEAKS_MAX }, () => 0.5),
      }).success,
    ).toBe(true);
    expect(
      addJamTrackSchema.safeParse({
        ...base,
        peaks: Array.from({ length: JAM_PEAKS_MAX + 1 }, () => 0.5),
      }).success,
    ).toBe(false);
    expect(addJamTrackSchema.safeParse({ ...base, peaks: [1.5] }).success).toBe(false);
    expect(addJamTrackSchema.safeParse({ ...base, peaks: [-0.1] }).success).toBe(false);
  });

  it("a track patch has no instrument, and needs something in it", () => {
    expect(updateJamTrackSchema.safeParse({}).success).toBe(false);
    expect(updateJamTrackSchema.parse({ inMix: false })).toEqual({ inMix: false });
    expect(updateJamTrackSchema.parse({ instrument: "bass", gain: 1 })).toEqual({ gain: 1 });
  });

  it("the list query reads strings off a URL", () => {
    const query = listJamSongsQuerySchema.parse({
      sort: "created",
      mine: "true",
      wanting: "bass",
      limit: "10",
    });
    expect(query).toMatchObject({ sort: "created", mine: true, wanting: "bass", limit: 10 });
    expect(listJamSongsQuerySchema.safeParse({ wanting: "kazoo" }).success).toBe(false);
    expect(listJamSongsQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
  });

  it("names six instruments", () => {
    expect([...JAM_INSTRUMENTS]).toEqual(["guitar", "bass", "drums", "vocals", "keys", "other"]);
  });
});
