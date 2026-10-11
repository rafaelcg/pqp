// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const uploadHomeMedia = vi.fn();
const captureCoverFrame = vi.fn();

vi.mock("@/lib/community-home", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/community-home")>()),
  uploadHomeMedia: (...args: unknown[]) => uploadHomeMedia(...args),
}));

vi.mock("@/lib/community-home/cover", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/community-home/cover")>()),
  captureCoverFrame: (...args: unknown[]) => captureCoverFrame(...args),
}));

const { ComposeCover } = await import("./community-home-compose-cover");
const { CoverFrameError } = await import("@/lib/community-home/cover");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// The scrubber is the Radix slider, which measures its thumb.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00");

const uploadedImage = {
  uploadId: "cover-1",
  kind: "image" as const,
  name: "capa.jpg",
  contentType: "image/jpeg" as const,
  byteSize: 12,
};

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(props: Partial<Parameters<typeof ComposeCover>[0]> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ComposeCover
        serverId="00000000-0000-4000-8000-000000000001"
        videoUrl="blob:main-video"
        videoIsLocal
        current={null}
        onUploaded={() => {}}
        onRemove={() => {}}
        {...props}
      />,
    );
  });
  return host;
}

/** jsdom has no media pipeline: give the element what a browser would. */
async function loadVideo(duration = 42) {
  const video = host!.querySelector<HTMLVideoElement>("[data-home-compose-cover-video]")!;
  Object.defineProperty(video, "duration", { value: duration, configurable: true });
  await act(async () => {
    video.dispatchEvent(new Event("loadedmetadata"));
    video.dispatchEvent(new Event("loadeddata"));
  });
  return video;
}

async function pickMode(label: string) {
  const option = [...host!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (el) => el.textContent === label,
  )!;
  await act(async () => option.click());
}

async function choose(file: File) {
  const input = host!.querySelector<HTMLInputElement>("[data-home-compose-cover-file]")!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("ComposeCover", () => {
  beforeEach(() => {
    uploadHomeMedia.mockReset();
    captureCoverFrame.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:cover");
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it("starts on the automatic cover, with the video under a scrubber at its first frame", async () => {
    await mount();
    expect(host!.querySelector("[data-home-compose-cover-auto]")?.textContent).toContain(
      "first frame",
    );
    const video = host!.querySelector<HTMLVideoElement>("[data-home-compose-cover-video]")!;
    expect(video.getAttribute("src")).toBe("blob:main-video");
    // A blob from this session is ours to read; no CORS needed.
    expect(video.hasAttribute("crossorigin")).toBe(false);
    const use = host!.querySelector<HTMLButtonElement>("[data-home-compose-cover-use-frame]")!;
    expect(use.disabled).toBe(true);
    await loadVideo();
    expect(use.disabled).toBe(false);
    expect(video.currentTime).toBeCloseTo(0.001);
    expect(host!.textContent).toContain("0:00 / 0:42");
  });

  it("asks for CORS on a video that comes from the bucket", async () => {
    await mount({ videoUrl: "https://bucket/v.mp4?sig=1", videoIsLocal: false });
    const video = host!.querySelector<HTMLVideoElement>("[data-home-compose-cover-video]")!;
    expect(video.getAttribute("crossorigin")).toBe("anonymous");
  });

  it("uploads the frame on screen as an image and hands it back with a preview", async () => {
    const onUploaded = vi.fn();
    const frame = new File(["jpeg"], "capa.jpg", { type: "image/jpeg" });
    captureCoverFrame.mockResolvedValue(frame);
    uploadHomeMedia.mockResolvedValue(uploadedImage);
    await mount({ onUploaded });
    const video = await loadVideo();
    await act(async () => {
      host!.querySelector<HTMLButtonElement>("[data-home-compose-cover-use-frame]")!.click();
    });
    expect(captureCoverFrame).toHaveBeenCalledWith(video);
    expect(uploadHomeMedia).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      frame,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onUploaded).toHaveBeenCalledWith(uploadedImage, "blob:cover");
  });

  it("offers the image upload instead when the frame cannot be read", async () => {
    const onUploaded = vi.fn();
    captureCoverFrame.mockRejectedValue(new CoverFrameError("tainted", "no"));
    await mount({ onUploaded, videoUrl: "https://bucket/v.mp4", videoIsLocal: false });
    await loadVideo();
    await act(async () => {
      host!.querySelector<HTMLButtonElement>("[data-home-compose-cover-use-frame]")!.click();
    });
    expect(uploadHomeMedia).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(host!.querySelector("[data-home-compose-cover-error]")?.textContent).toContain(
      "Upload an image",
    );
  });

  it("takes an uploaded JPEG, PNG or WebP as the cover", async () => {
    const onUploaded = vi.fn();
    uploadHomeMedia.mockResolvedValue({ ...uploadedImage, name: "capa.png", contentType: "image/png" });
    await mount({ onUploaded });
    await pickMode("Image");
    expect(host!.querySelector("[data-home-compose-cover-video]")).toBeNull();
    const accept = host!.querySelector("[data-home-compose-cover-file]")?.getAttribute("accept");
    expect(accept).toContain("image/webp");
    expect(accept).not.toContain("gif");
    await choose(new File([PNG], "capa.png", { type: "image/png" }));
    expect(uploadHomeMedia).toHaveBeenCalledTimes(1);
    expect(onUploaded).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: "cover-1", kind: "image" }),
      "blob:cover",
    );
  });

  it("refuses a GIF before uploading", async () => {
    const onUploaded = vi.fn();
    await mount({ onUploaded });
    await pickMode("Image");
    await choose(new File([GIF], "a.gif", { type: "image/gif" }));
    expect(uploadHomeMedia).not.toHaveBeenCalled();
    expect(host!.querySelector("[data-home-compose-cover-error]")?.textContent).toContain(
      "JPEG, PNG or WebP",
    );
  });

  it("shows the chosen cover with a way back to the first frame", async () => {
    const onRemove = vi.fn();
    await mount({ current: "blob:chosen", onRemove });
    expect(host!.querySelector("[data-home-compose-cover-auto]")).toBeNull();
    const img = host!.querySelector<HTMLImageElement>("[data-home-compose-cover-current] img")!;
    expect(img.getAttribute("src")).toBe("blob:chosen");
    await act(async () => {
      host!.querySelector<HTMLButtonElement>("[data-home-compose-cover-reset]")!.click();
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("a cover still uploading when the picker goes away never lands", async () => {
    const onUploaded = vi.fn();
    let finish: (value: unknown) => void = () => {};
    let signal: AbortSignal | undefined;
    uploadHomeMedia.mockImplementation(
      (_server: string, _file: File, options: { signal?: AbortSignal }) => {
        signal = options.signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    await mount({ onUploaded });
    await pickMode("Image");
    await choose(new File([PNG], "capa.png", { type: "image/png" }));
    // The main video changed: the composer remounts the picker (it is keyed
    // by the main file), which unmounts this one.
    await act(async () => root!.unmount());
    root = null;
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(uploadedImage));
    expect(onUploaded).not.toHaveBeenCalled();
  });
});
