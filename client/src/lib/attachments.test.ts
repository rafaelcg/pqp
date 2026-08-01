import { DEFAULT_MAX_ATTACHMENT_BYTES } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentAbortError,
  formatByteSize,
  selectAttachments,
  uploadAttachment,
} from "./attachments";

/**
 * The point of validating in the browser at all is that the answer arrives
 * before a ten-megabyte file has been read off disk and pushed at storage, so
 * these tests assert on the absence of a request as much as on the verdict.
 */

const OPTIONS = { existingCount: 0, maxBytes: DEFAULT_MAX_ATTACHMENT_BYTES };

function file(name: string, type: string, size: number): File {
  const blob = new File([new Uint8Array(Math.min(size, 1024))], name, { type });
  // Real files of the sizes under test would put megabytes through the test
  // runner for a number nothing ever reads back.
  Object.defineProperty(blob, "size", { value: size });
  return blob;
}

let fetchSpy: ReturnType<typeof vi.fn>;
let xhrSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  xhrs.length = 0;
  fetchSpy = vi.fn(() => Promise.reject(new Error("no request expected")));
  xhrSpy = vi.fn(() => {
    throw new Error("no upload expected");
  });
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("XMLHttpRequest", xhrSpy);
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("selectAttachments", () => {
  it("rejects a file over the cap without asking the server", () => {
    const result = selectAttachments(
      [file("huge.png", "image/png", DEFAULT_MAX_ATTACHMENT_BYTES + 1)],
      OPTIONS,
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { filename: "huge.png", reason: "larger than the 10 MB limit" },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
  });

  it("honours a cap the deployment lowered", () => {
    const result = selectAttachments([file("mid.png", "image/png", 900_000)], {
      existingCount: 0,
      maxBytes: 512_000,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("500 KB");
  });

  it("ignores a cap above the shared ceiling, which the mint would reject", () => {
    const result = selectAttachments(
      [file("huge.png", "image/png", DEFAULT_MAX_ATTACHMENT_BYTES + 1)],
      { existingCount: 0, maxBytes: DEFAULT_MAX_ATTACHMENT_BYTES * 4 },
    );

    expect(result.accepted).toEqual([]);
  });

  it("rejects a type outside the allowlist without asking the server", () => {
    const result = selectAttachments(
      [file("payload.svg", "image/svg+xml", 200)],
      OPTIONS,
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { filename: "payload.svg", reason: "image/svg+xml files are not allowed" },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
  });

  it("rejects a file the browser could not type at all", () => {
    const result = selectAttachments([file("mystery", "", 200)], OPTIONS);

    expect(result.rejected[0]?.reason).toBe("unrecognised file type");
  });

  it("rejects an empty file, which the mint schema will not sign", () => {
    const result = selectAttachments([file("empty.txt", "text/plain", 0)], OPTIONS);

    expect(result.rejected[0]?.reason).toBe("the file is empty");
  });

  it("accepts an allowlisted file and normalises its type", () => {
    const result = selectAttachments(
      [file("shot.png", "IMAGE/PNG", 1_000)],
      OPTIONS,
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]).toMatchObject({
      filename: "shot.png",
      contentType: "image/png",
    });
  });

  it("generates a name when the browser supplies one the server would refuse", () => {
    // A screenshot paste is the case that matters here: refusing the commonest
    // use of the feature over a naming technicality would be absurd.
    const result = selectAttachments([file("", "image/png", 1_000)], OPTIONS);

    expect(result.accepted[0]?.filename).toMatch(/^upload-[a-z0-9]+\.png$/);
  });

  it("stops at ten attachments per message", () => {
    const batch = Array.from({ length: 12 }, (_, index) =>
      file(`shot-${index}.png`, "image/png", 1_000),
    );

    const result = selectAttachments(batch, OPTIONS);

    expect(result.accepted).toHaveLength(10);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]?.reason).toBe(
      "only 10 attachments per message",
    );
  });

  it("counts what the composer already holds against the same ceiling", () => {
    // Three drops of four files have to hit the cap exactly as one drop of
    // twelve does — the limit belongs to the message, not to the batch.
    const result = selectAttachments(
      [file("a.png", "image/png", 10), file("b.png", "image/png", 10)],
      { existingCount: 9, maxBytes: DEFAULT_MAX_ATTACHMENT_BYTES },
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
  });
});

describe("formatByteSize", () => {
  it("reads as a size a person can act on", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(2_048)).toBe("2.0 KB");
    expect(formatByteSize(1_500_000)).toBe("1.4 MB");
    expect(formatByteSize(DEFAULT_MAX_ATTACHMENT_BYTES)).toBe("10 MB");
  });
});

describe("uploadAttachment", () => {
  const selected = {
    file: file("notes.txt", "text/plain", 4_000),
    filename: "notes.txt",
    contentType: "text/plain" as const,
  };

  it("does nothing at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadAttachment("channel-1", selected, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AttachmentAbortError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
  });

  it("aborts the transfer and unsubscribes when cancelled mid-upload", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              attachmentId: "a1",
              uploadUrl: "https://storage.test/put",
              expiresAt: new Date().toISOString(),
            }),
            { headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );

    const controller = new AbortController();
    const unsubscribe = vi.spyOn(controller.signal, "removeEventListener");
    const pending = uploadAttachment("channel-1", selected, {
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(xhrs).toHaveLength(1));
    const xhr = xhrs[0]!;
    expect(xhr.sent).toBe(true);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(AttachmentAbortError);
    expect(xhr.aborted).toBe(true);
    // A listener left on the signal keeps the request graph reachable for as
    // long as the controller is.
    expect(unsubscribe).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

const xhrs: FakeXhr[] = [];

/** Enough of XMLHttpRequest for the abort path, and nothing more. */
class FakeXhr {
  constructor() {
    xhrs.push(this);
  }

  sent = false;
  aborted = false;
  status = 0;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open() {}
  setRequestHeader() {}

  send() {
    this.sent = true;
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}
