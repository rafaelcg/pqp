import type { JamTrackWithSong, JamUploadTicket } from "@pqp/shared";
import { describe, expect, it, vi } from "vitest";
import { song, track } from "./jam-test-fixtures";
import {
  bareContentType,
  postTake,
  startJamPost,
  withoutVideo,
  type JamPostDeps,
  type JamPostProgress,
  type JamPostTake,
} from "./jam-upload";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const songId = "11111111-1111-4111-8111-111111111111";

function ticket(id: string, expiresInMs = 15 * 60_000): JamUploadTicket {
  return {
    uploadId: id,
    uploadUrl: `https://bucket.test/${id}`,
    expiresAt: new Date(NOW + expiresInMs).toISOString(),
  };
}

function take(withVideo = false): JamPostTake {
  return {
    audio: new Blob([new Uint8Array(1000)], { type: "audio/flac" }),
    video: withVideo
      ? new Blob([new Uint8Array(3000)], { type: "video/webm;codecs=vp9,opus" })
      : null,
    offsetMs: 42,
    trimStartMs: 1500.4,
    trimEndMs: 0,
    durationMs: 60000.2,
    gain: 1,
    peaks: [0.1, 0.9],
  };
}

type Mocked = JamPostDeps & {
  createUpload: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  addTrack: ReturnType<typeof vi.fn>;
};

function deps(overrides: Partial<JamPostDeps> = {}): Mocked {
  let n = 0;
  const answer: JamTrackWithSong = { track: track(), song: song() };
  return {
    createUpload: vi.fn(async () => ticket(`00000000-0000-4000-8000-00000000000${++n}`)),
    put: vi.fn(async (_url: string, blob: Blob, _type: string, onProgress: (n: number) => void) => {
      onProgress(blob.size / 2);
      onProgress(blob.size);
    }),
    addTrack: vi.fn(async () => answer),
    now: () => NOW,
    ...overrides,
  } as unknown as Mocked;
}

describe("posting a take", () => {
  it("runs the three steps and names the upload in the claim", async () => {
    const d = deps();
    const t = take();
    const state = startJamPost(t);
    const result = await postTake({ songId, instrument: "bass", take: t, state, deps: d });
    expect(result.track.id).toBe(track().id);
    expect(d.createUpload).toHaveBeenCalledWith(songId, {
      kind: "audio",
      contentType: "audio/flac",
      byteSize: 1000,
    });
    expect(d.put).toHaveBeenCalledOnce();
    const claim = d.addTrack.mock.calls[0]![1];
    expect(claim).toMatchObject({
      instrument: "bass",
      audioUploadId: "00000000-0000-4000-8000-000000000001",
      videoUploadId: null,
      durationMs: 60000,
      offsetMs: 42,
      trimStartMs: 1500,
    });
  });

  it("sends the video with its bare type and claims both", async () => {
    const d = deps();
    const t = take(true);
    await postTake({ songId, instrument: "guitar", take: t, state: startJamPost(t), deps: d });
    expect(d.createUpload).toHaveBeenCalledTimes(2);
    expect(d.createUpload.mock.calls[1]![1]).toEqual({
      kind: "video",
      contentType: "video/webm",
      byteSize: 3000,
    });
    expect(d.addTrack.mock.calls[0]![1].videoUploadId).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("reports progress across every file, ending at done", async () => {
    const seen: JamPostProgress[] = [];
    const d = deps();
    const t = take(true);
    await postTake({
      songId,
      instrument: "guitar",
      take: t,
      state: startJamPost(t),
      deps: d,
      onProgress: (p) => seen.push(p),
    });
    expect(seen[0]).toEqual({ stage: "uploading", fraction: 0 });
    expect(seen.some((p) => p.stage === "claiming")).toBe(true);
    expect(seen.at(-1)).toEqual({ stage: "done", fraction: 1 });
    const fractions = seen.map((p) => p.fraction);
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions);
  });

  it("retries a failed PUT with the same upload id and does not ask for a second ticket", async () => {
    let first = true;
    const d = deps({
      put: vi.fn(async () => {
        if (first) {
          first = false;
          throw new Error("network");
        }
      }),
    });
    const t = take();
    const state = startJamPost(t);
    await expect(postTake({ songId, instrument: "bass", take: t, state, deps: d })).rejects.toThrow(
      "network",
    );
    const ticketId = state.audio.ticket?.uploadId;
    expect(ticketId).toBeDefined();
    await postTake({ songId, instrument: "bass", take: t, state, deps: d });
    expect(d.createUpload).toHaveBeenCalledOnce();
    expect(d.put).toHaveBeenCalledTimes(2);
    expect(d.addTrack.mock.calls[0]![1].audioUploadId).toBe(ticketId);
  });

  it("retries a failed claim without sending the bytes again, with the same upload id", async () => {
    let first = true;
    const d = deps({
      addTrack: vi.fn(async () => {
        if (first) {
          first = false;
          throw new Error("503");
        }
        return { track: track(), song: song() };
      }),
    });
    const t = take();
    const state = startJamPost(t);
    await expect(postTake({ songId, instrument: "bass", take: t, state, deps: d })).rejects.toThrow(
      "503",
    );
    await postTake({ songId, instrument: "bass", take: t, state, deps: d });
    expect(d.put).toHaveBeenCalledOnce();
    expect(d.addTrack).toHaveBeenCalledTimes(2);
    expect(d.addTrack.mock.calls[1]![1].audioUploadId).toBe(
      d.addTrack.mock.calls[0]![1].audioUploadId,
    );
  });

  it("asks for a new ticket when the held one is about to expire", async () => {
    const d = deps();
    const t = take();
    const state = startJamPost(t);
    state.audio.ticket = ticket("old", 10_000);
    await postTake({ songId, instrument: "bass", take: t, state, deps: d });
    expect(d.createUpload).toHaveBeenCalledOnce();
    expect(d.addTrack.mock.calls[0]![1].audioUploadId).not.toBe("old");
  });

  it("does not post twice once it has an answer", async () => {
    const d = deps();
    const t = take();
    const state = startJamPost(t);
    await postTake({ songId, instrument: "bass", take: t, state, deps: d });
    await postTake({ songId, instrument: "bass", take: t, state, deps: d });
    expect(d.addTrack).toHaveBeenCalledOnce();
  });

  it("joins a second call made while the first is running: one ticket, one claim", async () => {
    const d = deps();
    const t = take();
    const state = startJamPost(t);
    const [a, b] = await Promise.all([
      postTake({ songId, instrument: "bass", take: t, state, deps: d }),
      postTake({ songId, instrument: "bass", take: t, state, deps: d }),
    ]);
    expect(a).toBe(b);
    expect(d.createUpload).toHaveBeenCalledOnce();
    expect(d.addTrack).toHaveBeenCalledOnce();
  });

  it("can drop the video and post the sound alone", async () => {
    const d = deps();
    const t = take(true);
    const state = withoutVideo(startJamPost(t));
    await postTake({ songId, instrument: "bass", take: t, state, deps: d });
    expect(d.createUpload).toHaveBeenCalledOnce();
    expect(d.addTrack.mock.calls[0]![1].videoUploadId).toBeNull();
  });
});

describe("content types", () => {
  it("strips codecs and falls back for a type the server does not take", () => {
    expect(bareContentType("video", "video/webm;codecs=vp9,opus", "video/webm")).toBe("video/webm");
    expect(bareContentType("video", "video/mp4; codecs=avc1", "video/webm")).toBe("video/mp4");
    expect(bareContentType("video", "", "video/webm")).toBe("video/webm");
    expect(bareContentType("audio", "audio/flac", "audio/flac")).toBe("audio/flac");
    expect(bareContentType("audio", "audio/wav", "audio/flac")).toBe("audio/flac");
  });
});
