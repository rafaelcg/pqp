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

import { postStory, type StoryDraft } from "./post";
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

const LAYER_ID = "00000000-0000-4000-8000-0000000000aa";

function draftWithLayer(): StoryDraft {
  const base = draft();
  return {
    ...base,
    request: {
      ...base.request,
      layers: [
        {
          id: LAYER_ID,
          type: "image",
          x: 0.5,
          y: 0.5,
          scale: 1,
          rotation: 0,
          shape: "rect",
          upload: { contentType: "image/jpeg", byteSize: 2, width: 1, height: 1 },
        },
      ],
    } as StoryDraft["request"],
    layerFiles: new Map([[LAYER_ID, new Blob(["xy"])]]),
  };
}

/** A stand-in for `EagerUpload`: what `postStory` reads and calls. */
function fakeHandle(options: { id: string | null; fraction?: number } = { id: "up-1" }) {
  const listeners = new Set<() => void>();
  return {
    state: options.id ? "done" : "failed",
    fraction: options.fraction ?? (options.id ? 1 : 0),
    uploadId: options.id,
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    ensure: vi.fn(async () => options.id),
    markClaimed: vi.fn(),
    cancel: vi.fn(),
    emit: () => listeners.forEach((listener) => listener()),
  };
}

const live = { story: { id: "s9", own: { status: "live" } }, upload: null, layerUploads: [] };

beforeEach(() => {
  // `finish` clears the ring on a `window` timer; the suite runs in node.
  vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval });
  resetStoriesUi();
  api.createStory.mockReset();
  api.publishStory.mockReset();
  upload.putStoryMedia.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  resetStoriesUi();
  vi.unstubAllGlobals();
});

describe("postStory with eager uploads", () => {
  it("every file already stored: one create-and-publish call, no PUT, no second request", async () => {
    api.createStory.mockResolvedValue(live);
    const story = draftWithLayer();
    const base = fakeHandle({ id: "base-up" });
    const layer = fakeHandle({ id: "layer-up" });
    story.eager = { base: base as never, layers: new Map([[LAYER_ID, layer as never]]) };

    await expect(postStory(story)).resolves.toBe("live");

    expect(api.createStory).toHaveBeenCalledTimes(1);
    const body = api.createStory.mock.calls[0]![0];
    expect(body.publish).toBe(true);
    expect(body.media.uploadId).toBe("base-up");
    expect(body.layers[0].upload.uploadId).toBe("layer-up");
    expect(api.publishStory).not.toHaveBeenCalled();
    expect(upload.putStoryMedia).not.toHaveBeenCalled();
    // The story holds the files now: a later cancel must not delete them.
    expect(base.markClaimed).toHaveBeenCalled();
    expect(layer.markClaimed).toHaveBeenCalled();
    expect(getStoriesUi().posting?.status).toBe("done");
  });

  it("waits for a file still going up, and the ring shows bytes over bytes meanwhile", async () => {
    api.createStory.mockResolvedValue(live);
    const story = draft();
    const base = fakeHandle({ id: "base-up", fraction: 0.5 });
    let release: (id: string) => void = () => undefined;
    base.state = "uploading";
    base.uploadId = null;
    base.ensure.mockReturnValue(new Promise<string>((resolve) => (release = resolve)));
    story.eager = { base: base as never };

    const posting = postStory(story);
    expect(getStoriesUi().posting?.progress).toBeCloseTo(0.5);
    base.fraction = 0.8;
    base.emit();
    expect(getStoriesUi().posting?.progress).toBeCloseTo(0.8);
    expect(api.createStory).not.toHaveBeenCalled();

    base.state = "done";
    base.uploadId = "base-up";
    release("base-up");
    await expect(posting).resolves.toBe("live");
    expect(api.createStory.mock.calls[0]![0].publish).toBe(true);
  });

  it("a file with no stored copy goes the plain way, and the create does not ask to publish", async () => {
    api.createStory.mockResolvedValue({
      story: { id: "s9", own: { status: "pending" } },
      // The server answers URLs only for what had no upload.
      upload: null,
      layerUploads: [{ layerId: LAYER_ID, url: "https://bucket/layer", method: "PUT", headers: {}, expiresAt: "" }],
    });
    api.publishStory.mockResolvedValue({ story: { id: "s9", own: { status: "live" } } });
    const story = draftWithLayer();
    // The base made it; the layer's eager upload failed (ensure answers null).
    story.eager = {
      base: fakeHandle({ id: "base-up" }) as never,
      layers: new Map([[LAYER_ID, fakeHandle({ id: null }) as never]]),
    };

    await expect(postStory(story)).resolves.toBe("live");

    const body = api.createStory.mock.calls[0]![0];
    expect(body.publish).toBeUndefined();
    expect(body.media.uploadId).toBe("base-up");
    expect(body.layers[0].upload.uploadId).toBeUndefined();
    expect(upload.putStoryMedia).toHaveBeenCalledTimes(1);
    expect(upload.putStoryMedia.mock.calls[0]![1].size).toBe(2);
    expect(api.publishStory).toHaveBeenCalledWith("s9");
  });

  it("no eager handles at all is the old flow", async () => {
    api.createStory.mockResolvedValue({
      story: { id: "s1", own: { status: "pending" } },
      upload: { url: "https://bucket/put", headers: {} },
    });
    api.publishStory.mockResolvedValue({ story: { id: "s1", own: { status: "live" } } });
    await expect(postStory(draft())).resolves.toBe("live");
    const body = api.createStory.mock.calls[0]![0];
    expect(body.publish).toBeUndefined();
    expect(body.media.uploadId).toBeUndefined();
    expect(upload.putStoryMedia).toHaveBeenCalledTimes(1);
    expect(api.publishStory).toHaveBeenCalledWith("s1");
  });

  it("a text card has nothing to wait for and does not ask to publish", async () => {
    api.createStory.mockResolvedValue({ story: { id: "t1", own: { status: "live" } }, upload: null, layerUploads: [] });
    const text = draft();
    text.media = null;
    await expect(postStory(text)).resolves.toBe("live");
    expect(api.createStory.mock.calls[0]![0].publish).toBeUndefined();
  });

  it("a failure keeps the draft and its uploads; retry posts again with the same key and the same files", async () => {
    api.createStory.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const story = draft();
    const base = fakeHandle({ id: "base-up" });
    story.eager = { base: base as never };

    await expect(postStory(story)).resolves.toBe("failed");
    const failed = getStoriesUi().posting!;
    expect(failed.status).toBe("failed");
    expect(failed.retry).not.toBeNull();
    expect(failed.discard).not.toBeNull();
    // Nothing was thrown away, and the story never took the file.
    expect(base.cancel).not.toHaveBeenCalled();
    expect(base.markClaimed).not.toHaveBeenCalled();
    const key = api.createStory.mock.calls[0]![0].requestId;

    api.createStory.mockResolvedValueOnce(live);
    failed.retry!();
    await vi.waitFor(() => expect(getStoriesUi().posting?.status).toBe("done"));
    const retried = api.createStory.mock.calls[1]![0];
    expect(retried.requestId).toBe(key);
    expect(retried.media.uploadId).toBe("base-up");
    expect(retried.publish).toBe(true);
  });

  it("discarding a failed post cancels every upload (the server deletes the objects) and clears the ring", async () => {
    api.createStory.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const story = draftWithLayer();
    const base = fakeHandle({ id: "base-up" });
    const layer = fakeHandle({ id: "layer-up" });
    story.eager = { base: base as never, layers: new Map([[LAYER_ID, layer as never]]) };
    await postStory(story);

    getStoriesUi().posting!.discard!();

    expect(base.cancel).toHaveBeenCalledTimes(1);
    expect(layer.cancel).toHaveBeenCalledTimes(1);
    expect(getStoriesUi().posting).toBeNull();
  });

  it("a refused post can only be discarded", async () => {
    api.createStory.mockRejectedValueOnce(new ApiError(422, "refused"));
    const story = draft();
    const base = fakeHandle({ id: "base-up" });
    story.eager = { base: base as never };
    await postStory(story);
    const posting = getStoriesUi().posting!;
    expect(posting.retry).toBeNull();
    posting.discard!();
    expect(base.cancel).toHaveBeenCalled();
    expect(getStoriesUi().posting).toBeNull();
  });
});
