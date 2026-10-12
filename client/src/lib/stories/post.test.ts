import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";

const api = vi.hoisted(() => ({
  createStory: vi.fn(),
  publishStory: vi.fn(),
  fetchStories: vi.fn(),
}));
const upload = vi.hoisted(() => ({
  putStoryMedia: vi.fn(),
}));

vi.mock("./api", () => api);
vi.mock("./upload", () => ({
  putStoryMedia: upload.putStoryMedia,
  mediaInputFor: () => ({ contentType: "image/jpeg", byteSize: 3, width: 1, height: 1 }),
}));

import { classifyPostFailure, failedPostNotice, failedRingLabel, postStory, type StoryDraft } from "./post";
import { getStoriesUi, resetStoriesUi } from "./ui-store";

function draft(): StoryDraft {
  return {
    request: {
      kind: "image",
      repliesEnabled: true,
      audiences: { serverIds: ["00000000-0000-4000-8000-000000000001"], friends: false },
    } as StoryDraft["request"],
    media: {
      kind: "image",
      blob: new Blob(["abc"]),
      contentType: "image/jpeg",
      width: 1,
      height: 1,
      durationMs: null,
    } as StoryDraft["media"],
  };
}

const created = {
  story: { id: "s1", own: { status: "pending" } },
  upload: { url: "https://bucket/put", headers: {} },
};

beforeEach(() => {
  resetStoriesUi();
  api.createStory.mockReset();
  api.publishStory.mockReset();
  upload.putStoryMedia.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  resetStoriesUi();
});

describe("classifyPostFailure", () => {
  it("keeps the network and the server's own trouble retryable", () => {
    expect(classifyPostFailure(new TypeError("Failed to fetch"))).toBe("failed");
    expect(classifyPostFailure(new ApiError(0, "unreachable"))).toBe("failed");
    expect(classifyPostFailure(new ApiError(503, "down"))).toBe("failed");
    expect(classifyPostFailure(new ApiError(408, "timeout"))).toBe("failed");
  });

  it("tells the per-minute limiter (Retry-After) from the daily cap (none)", () => {
    expect(classifyPostFailure(new ApiError(429, "Slow down", 40_000))).toBe("busy");
    expect(classifyPostFailure(new ApiError(429, "Too many stories today"))).toBe("daily");
  });

  it("treats a definitive no (scan, permission, gone) as refused", () => {
    expect(classifyPostFailure(new ApiError(422, "refused"))).toBe("refused");
    expect(classifyPostFailure(new ApiError(404, "That story is gone"))).toBe("refused");
    expect(classifyPostFailure(new ApiError(403, "no_permission"))).toBe("refused");
  });
});

describe("postStory failures", () => {
  it("a refused publish puts the ring away instead of replaying a deleted story", async () => {
    api.createStory.mockResolvedValue(created);
    api.publishStory.mockRejectedValue(new ApiError(422, "refused"));
    const story = draft();

    await expect(postStory(story)).resolves.toBe("failed");

    const posting = getStoriesUi().posting!;
    expect(posting.status).toBe("failed");
    expect(posting.failure).toBe("refused");
    // A tap only dismisses: replaying this requestId can only answer "gone".
    expect(posting.retry).toBeNull();
    expect(story.requestId).toBeUndefined();
  });

  it("a network failure keeps the same requestId so a lost answer never posts twice", async () => {
    api.createStory.mockResolvedValueOnce(created);
    api.publishStory.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const story = draft();

    await postStory(story);
    const firstKey = api.createStory.mock.calls[0]![0].requestId;
    const posting = getStoriesUi().posting!;
    expect(posting.failure).toBe("failed");
    expect(posting.retry).not.toBeNull();

    api.createStory.mockResolvedValueOnce(created);
    api.publishStory.mockResolvedValueOnce({ story: { id: "s1", own: { status: "live" } } });
    posting.retry!();
    await vi.waitFor(() => expect(api.createStory).toHaveBeenCalledTimes(2));
    expect(api.createStory.mock.calls[1]![0].requestId).toBe(firstKey);
  });

  it("the daily cap is said and not retried; three in a minute is retried", async () => {
    api.createStory.mockRejectedValueOnce(new ApiError(429, "Too many stories today"));
    await expect(postStory(draft())).resolves.toBe("busy");
    expect(getStoriesUi().posting!.failure).toBe("daily");
    expect(getStoriesUi().posting!.retry).toBeNull();

    api.createStory.mockRejectedValueOnce(new ApiError(429, "Slow down", 30_000));
    await expect(postStory(draft())).resolves.toBe("busy");
    expect(getStoriesUi().posting!.failure).toBe("busy");
    expect(getStoriesUi().posting!.retry).not.toBeNull();
  });

  it("the ring and the notice name the reason", () => {
    expect(failedRingLabel("daily", false)).toEqual({
      key: "stories.upload.daily",
      vars: { limit: 20 },
    });
    expect(failedRingLabel("refused", false).key).toBe("stories.upload.dismiss");
    expect(failedRingLabel("failed", true).key).toBe("stories.upload.failed");
    expect(failedPostNotice("refused").key).toBe("stories.upload.refused");
    expect(failedPostNotice("failed").key).toBe("stories.upload.failedNotice");
  });
});
