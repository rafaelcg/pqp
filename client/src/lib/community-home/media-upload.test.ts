import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mint = vi.fn();
const claim = vi.fn();
vi.mock("@/lib/api", () => ({
  createCommunityHomeMediaUpload: (...args: unknown[]) => mint(...args),
  claimCommunityHomeMediaUpload: (...args: unknown[]) => claim(...args),
}));

const { uploadHomeMedia } = await import("./media");

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const putTypes: string[] = [];

class FakeXhr {
  upload: Record<string, unknown> = {};
  status = 200;
  onload: (() => void) | null = null;
  open() {}
  setRequestHeader(name: string, value: string) {
    if (name === "Content-Type") {
      putTypes.push(value);
    }
  }
  send() {
    queueMicrotask(() => this.onload?.());
  }
  abort() {}
}

describe("uploadHomeMedia", () => {
  beforeEach(() => {
    putTypes.length = 0;
    mint.mockReset().mockResolvedValue({ uploadId: "u1", uploadUrl: "http://s/u1" });
    claim.mockReset().mockResolvedValue({ uploadId: "u1", kind: "image" });
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs a real JPEG named .png as a JPEG", async () => {
    const file = new File([JPEG], "meme.png", { type: "image/png" });
    await uploadHomeMedia("s1", file);
    expect(mint.mock.calls[0]?.[1]).toMatchObject({ contentType: "image/jpeg" });
    expect(putTypes).toEqual(["image/jpeg"]);
  });

  it("refuses a text file named .png before minting anything", async () => {
    const file = new File(["not an image"], "x.png", { type: "image/png" });
    await expect(uploadHomeMedia("s1", file)).rejects.toThrow(/not a real image/i);
    expect(mint).not.toHaveBeenCalled();
  });
});
