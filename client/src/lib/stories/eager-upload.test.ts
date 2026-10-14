import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";

const api = vi.hoisted(() => ({
  mintStoryUpload: vi.fn(),
  deleteStoryUpload: vi.fn(),
}));
const upload = vi.hoisted(() => ({
  putStoryMedia: vi.fn(),
}));

vi.mock("./api", () => api);
vi.mock("./upload", () => ({ putStoryMedia: upload.putStoryMedia }));

import { EagerUpload, resetEagerAvailabilityForTests, startEagerUpload } from "./eager-upload";

const minted = (id: string) => ({
  uploadId: id,
  url: `https://bucket/${id}`,
  method: "PUT" as const,
  headers: { "Content-Type": "image/jpeg" },
  expiresAt: "",
});

const input = { kind: "base" as const, blob: new Blob(["0123456789"]), contentType: "image/jpeg" };

/** Lets promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetEagerAvailabilityForTests();
  api.mintStoryUpload.mockReset();
  api.deleteStoryUpload.mockReset().mockResolvedValue(undefined);
  upload.putStoryMedia.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EagerUpload", () => {
  it("mints, PUTs, reports progress, and ends done with the upload id", async () => {
    api.mintStoryUpload.mockResolvedValue(minted("u1"));
    upload.putStoryMedia.mockImplementation(async (_u, _b, onProgress: (f: number) => void) => {
      onProgress(0.25);
      onProgress(0.5);
    });
    const handle = new EagerUpload(input);
    const seen: number[] = [];
    handle.subscribe(() => seen.push(handle.fraction));
    expect(handle.state).toBe("uploading");
    expect(handle.uploadId).toBeNull();

    await expect(handle.ensure()).resolves.toBe("u1");
    expect(handle.state).toBe("done");
    expect(handle.uploadId).toBe("u1");
    expect(handle.fraction).toBe(1);
    expect(seen).toContain(0.25);
    expect(seen).toContain(0.5);
    // Asks for exactly what it will send.
    expect(api.mintStoryUpload).toHaveBeenCalledWith({ kind: "base", contentType: "image/jpeg", byteLength: 10 });
    // Throwing a finished upload away deletes it, once.
    handle.cancel();
    handle.cancel();
    expect(api.deleteStoryUpload).toHaveBeenCalledTimes(1);
    expect(api.deleteStoryUpload).toHaveBeenCalledWith("u1");
    expect(handle.state).toBe("cancelled");
  });

  it("cancelling mid-PUT aborts it and deletes the upload", async () => {
    api.mintStoryUpload.mockResolvedValue(minted("u2"));
    let signal: AbortSignal | undefined;
    upload.putStoryMedia.mockImplementation(
      (_u, _b, _p, abort: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal = abort;
          abort.addEventListener("abort", () => reject(new Error("Upload cancelled")));
        }),
    );
    const handle = new EagerUpload(input);
    await flush();
    expect(signal?.aborted).toBe(false);
    handle.cancel();
    expect(signal?.aborted).toBe(true);
    expect(api.deleteStoryUpload).toHaveBeenCalledWith("u2");
    await expect(handle.ensure()).resolves.toBeNull();
    expect(handle.state).toBe("cancelled");
  });

  it("cancelling while the id is still on its way deletes it the moment it arrives and never PUTs", async () => {
    let resolveMint: (value: ReturnType<typeof minted>) => void = () => undefined;
    api.mintStoryUpload.mockReturnValue(new Promise((resolve) => (resolveMint = resolve)));
    const handle = new EagerUpload(input);
    handle.cancel();
    expect(api.deleteStoryUpload).not.toHaveBeenCalled();
    resolveMint(minted("u3"));
    await expect(handle.ensure()).resolves.toBeNull();
    expect(api.deleteStoryUpload).toHaveBeenCalledWith("u3");
    expect(upload.putStoryMedia).not.toHaveBeenCalled();
  });

  it("a failed PUT ends failed, cleans up after itself, and ensure() starts over", async () => {
    api.mintStoryUpload.mockResolvedValueOnce(minted("bad")).mockResolvedValueOnce(minted("good"));
    upload.putStoryMedia.mockRejectedValueOnce(new Error("Could not reach storage")).mockResolvedValueOnce(undefined);
    const handle = new EagerUpload(input);
    await flush();
    await flush();
    expect(handle.state).toBe("failed");
    expect(handle.uploadId).toBeNull();
    expect(api.deleteStoryUpload).toHaveBeenCalledWith("bad");

    await expect(handle.ensure()).resolves.toBe("good");
    expect(handle.state).toBe("done");
    expect(api.mintStoryUpload).toHaveBeenCalledTimes(2);
  });

  it("a server with no such route turns eager uploads off for the session", async () => {
    api.mintStoryUpload.mockRejectedValue(new ApiError(404, "Not found"));
    const handle = new EagerUpload(input);
    await expect(handle.ensure()).resolves.toBeNull();
    expect(handle.state).toBe("failed");
    expect(startEagerUpload(input)).toBeNull();
    expect(api.mintStoryUpload).toHaveBeenCalledTimes(1);
  });

  it("other errors (a 5xx, the network) leave it available for the next file", async () => {
    api.mintStoryUpload.mockRejectedValue(new ApiError(503, "storage"));
    const handle = new EagerUpload(input);
    await expect(handle.ensure()).resolves.toBeNull();
    expect(startEagerUpload(input)).not.toBeNull();
  });

  it("once a story took the file, cancelling never deletes it", async () => {
    api.mintStoryUpload.mockResolvedValue(minted("u4"));
    const handle = new EagerUpload(input);
    await handle.ensure();
    handle.markClaimed();
    handle.cancel();
    expect(api.deleteStoryUpload).not.toHaveBeenCalled();
    expect(handle.state).toBe("done");
  });

  it("a draft kept for hours uploads again before it is used (the server sweeps an unclaimed upload at 6 h)", async () => {
    vi.useFakeTimers();
    api.mintStoryUpload.mockResolvedValueOnce(minted("old")).mockResolvedValueOnce(minted("fresh"));
    const handle = new EagerUpload(input);
    await expect(handle.ensure()).resolves.toBe("old");
    vi.setSystemTime(Date.now() + 4 * 60 * 60 * 1000);
    await expect(handle.ensure()).resolves.toBe("old");
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    await expect(handle.ensure()).resolves.toBe("fresh");
    expect(api.deleteStoryUpload).toHaveBeenCalledWith("old");
  });

  it("a delete that fails is not an error: the server's sweep is the backstop", async () => {
    api.mintStoryUpload.mockResolvedValue(minted("u5"));
    api.deleteStoryUpload.mockRejectedValue(new ApiError(500, "boom"));
    const handle = new EagerUpload(input);
    await handle.ensure();
    expect(() => handle.cancel()).not.toThrow();
    await flush();
  });
});
