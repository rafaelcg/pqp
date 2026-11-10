import type { JamSongSummary, JamTrack } from "@pqp/shared";

/** Plain song and track values for the jam tests. Not shipped: only a test imports this. */
export function song(overrides: Partial<JamSongSummary> = {}): JamSongSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    channelId: "22222222-2222-4222-8222-222222222222",
    serverId: "33333333-3333-4333-8333-333333333333",
    title: "In Bloom",
    artist: "Nirvana",
    joinMode: "open",
    wantedInstruments: [],
    authorId: "44444444-4444-4444-8444-444444444444",
    authorName: "rafa",
    authorAvatarUrl: null,
    createdAt: "2026-11-09T10:00:00.000Z",
    updatedAt: "2026-11-09T10:00:00.000Z",
    trackCount: 1,
    instruments: ["guitar"],
    contributorCount: 1,
    mixDurationMs: 60000,
    ...overrides,
  };
}

export function track(overrides: Partial<JamTrack> = {}): JamTrack {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    songId: "11111111-1111-4111-8111-111111111111",
    authorId: "44444444-4444-4444-8444-444444444444",
    authorName: "rafa",
    authorAvatarUrl: null,
    instrument: "guitar",
    label: null,
    audioUrl: "https://example.test/a.flac",
    audioContentType: "audio/flac",
    audioBytes: 1000,
    videoUrl: null,
    videoContentType: null,
    videoBytes: null,
    mediaExpiresAt: "2026-11-10T10:00:00.000Z",
    offsetMs: 0,
    trimStartMs: 0,
    trimEndMs: 0,
    durationMs: 60000,
    gain: 1,
    peaks: [0.1, 0.5, 0.9],
    inMix: true,
    voteCount: 0,
    createdAt: "2026-11-09T10:00:00.000Z",
    ...overrides,
  };
}
