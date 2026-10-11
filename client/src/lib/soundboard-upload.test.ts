// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const claim = vi.fn();
const mint = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  createSoundboardUpload: (...args: unknown[]) => mint(...args),
  claimSoundboardSound: (...args: unknown[]) => claim(...args),
}));

const { ApiError } = await import("@/lib/api");
const { soundboardErrorKey, soundboardNameErrorKey, uploadSoundboardFile } = await import(
  "./soundboard-upload"
);

const input = {
  serverId: "s1",
  file: new File([new Uint8Array(8)], "a.mp3", { type: "audio/mpeg" }),
  contentType: "audio/mpeg" as const,
  name: "Buzina",
  emoji: "✨",
};

beforeEach(() => {
  claim.mockReset();
  mint.mockReset();
  mint.mockResolvedValue({ key: "k1", uploadUrl: "https://bucket/put", expiresAt: "x" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true })),
  );
});

describe("uploadSoundboardFile claim", () => {
  it("does not ask again after a 4xx", async () => {
    claim.mockRejectedValue(new ApiError(400, "Invalid request"));
    await expect(uploadSoundboardFile(input)).rejects.toMatchObject({ status: 400 });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("asks again with the same key after a lost response", async () => {
    claim
      .mockRejectedValueOnce(new ApiError(0, "Network error reaching API."))
      .mockResolvedValueOnce({ sound: { id: "x" } });
    await expect(uploadSoundboardFile(input)).resolves.toEqual({ id: "x" });
    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim.mock.calls[0]![1].key).toBe("k1");
    expect(claim.mock.calls[1]![1].key).toBe("k1");
  });

  it("asks again after a 5xx", async () => {
    claim
      .mockRejectedValueOnce(new ApiError(503, "storage"))
      .mockResolvedValueOnce({ sound: { id: "x" } });
    await uploadSoundboardFile(input);
    expect(claim).toHaveBeenCalledTimes(2);
  });
});

describe("uploadSoundboardFile abort", () => {
  it("does not send the claim once aborted after the file went up", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        return { ok: true };
      }),
    );
    await expect(
      uploadSoundboardFile({ ...input, signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(claim).not.toHaveBeenCalled();
  });

  it("hands the signal to the file transfer", async () => {
    claim.mockResolvedValue({ sound: { id: "x" } });
    const controller = new AbortController();
    await uploadSoundboardFile({ ...input, signal: controller.signal });
    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(init.signal).toBe(controller.signal);
  });

  it("does not retry a lost claim response once aborted", async () => {
    const controller = new AbortController();
    claim.mockImplementation(async () => {
      controller.abort();
      throw new ApiError(502, "bad gateway");
    });
    await expect(
      uploadSoundboardFile({ ...input, signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(claim).toHaveBeenCalledTimes(1);
  });
});

describe("soundboard error mapping", () => {
  it("maps the server's codes and a bad-name 400", () => {
    expect(soundboardErrorKey(new ApiError(409, "slots"))).toBe("soundboard.error.slots");
    expect(soundboardErrorKey(new ApiError(400, "too_long"))).toBe("soundboard.error.tooLong");
    expect(soundboardErrorKey(new ApiError(400, "Invalid request"))).toBe(
      "soundboard.error.nameRejected",
    );
    expect(soundboardErrorKey(new ApiError(403, "soundboard_disabled"))).toBe(
      "soundboard.error.disabled",
    );
    expect(soundboardErrorKey(new Error("storage"))).toBe("soundboard.error.storage");
  });

  it("tells a short name from a hidden one", () => {
    expect(soundboardNameErrorKey("a")).toBe("soundboard.error.name");
    expect(soundboardNameErrorKey("​​")).toBe("soundboard.error.nameHidden");
    expect(soundboardNameErrorKey("  Buzina ")).toBeNull();
  });
});

describe("inspectSoundboardFile reads the bytes, not the name", () => {
  function mp3Bytes(): Uint8Array<ArrayBuffer> {
    const frame = new Uint8Array(Math.floor((144 * 128000) / 44100));
    frame.set([0xff, 0xfb, 0x90, 0x00], 0);
    const out = new Uint8Array(frame.length * 40);
    for (let i = 0; i < 40; i += 1) {
      out.set(frame, i * frame.length);
    }
    return out;
  }

  it("takes an mp3 renamed .ogg as the mp3 it is", async () => {
    const { inspectSoundboardFile } = await import("./soundboard-upload");
    const file = new File([mp3Bytes()], "clip.ogg", { type: "audio/ogg" });
    expect(await inspectSoundboardFile(file)).toEqual({ contentType: "audio/mpeg" });
  });

  it("calls a WAV renamed .mp3 the wrong format, not a broken file", async () => {
    const { inspectSoundboardFile } = await import("./soundboard-upload");
    const wav = new Uint8Array(2048);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    const file = new File([wav], "clip.mp3", { type: "audio/mpeg" });
    expect(await inspectSoundboardFile(file)).toBe("type");
  });

  it("calls an empty file unreadable, not too big", async () => {
    const { inspectSoundboardFile } = await import("./soundboard-upload");
    const file = new File([], "clip.mp3", { type: "audio/mpeg" });
    expect(await inspectSoundboardFile(file)).toBe("unreadable");
  });
});
