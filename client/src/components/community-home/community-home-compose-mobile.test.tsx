// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uploadHomeMedia = vi.fn();

vi.mock("@/lib/community-home", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/community-home")>()),
  uploadHomeMedia: (...args: unknown[]) => uploadHomeMedia(...args),
}));

const { ComposeMobileRendition } = await import("./community-home-compose-mobile");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(props: Partial<Parameters<typeof ComposeMobileRendition>[0]> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ComposeMobileRendition
        serverId="00000000-0000-4000-8000-000000000001"
        current={null}
        onUploaded={() => {}}
        onRemove={() => {}}
        {...props}
      />,
    );
  });
  return host;
}

async function choose(file: File) {
  const input = host!.querySelector<HTMLInputElement>("[data-home-compose-mobile-file]")!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("ComposeMobileRendition", () => {
  beforeEach(() => {
    uploadHomeMedia.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:vertical");
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it("offers a video picker and uploads a vertical cut through the Baú upload", async () => {
    const onUploaded = vi.fn();
    uploadHomeMedia.mockResolvedValue({
      uploadId: "u-1",
      kind: "video",
      name: "launch-9x16.mp4",
      contentType: "video/mp4",
      byteSize: 12,
    });
    await mount({ onUploaded });
    expect(host!.querySelector("[data-home-compose-mobile-file]")?.getAttribute("accept")).toContain(
      "video/mp4",
    );
    await choose(new File(["x"], "launch-9x16.mp4", { type: "video/mp4" }));
    expect(uploadHomeMedia).toHaveBeenCalledTimes(1);
    expect(onUploaded).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: "u-1", kind: "video" }),
      "blob:vertical",
    );
  });

  it("a cut still uploading when the picker goes away never lands", async () => {
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
    await choose(new File(["x"], "old-cut.mp4", { type: "video/mp4" }));
    // The main video changed: the composer remounts the picker (it is keyed
    // by the main file), which unmounts this one.
    await act(async () => root!.unmount());
    root = null;
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish({ uploadId: "late", kind: "video", name: "old-cut.mp4", contentType: "video/mp4", byteSize: 1 });
    });
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("refuses anything that is not a video before uploading", async () => {
    const onUploaded = vi.fn();
    await mount({ onUploaded });
    await choose(new File(["x"], "foto.png", { type: "image/png" }));
    expect(uploadHomeMedia).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(host!.querySelector("[data-home-compose-mobile-error]")).not.toBeNull();
  });

  it("shows the cut it has, with a way to remove it", async () => {
    const onRemove = vi.fn();
    await mount({ current: { name: "launch-9x16.mp4", byteSize: 2048 }, onRemove });
    expect(host!.querySelector("[data-home-compose-mobile-file]")).toBeNull();
    expect(host!.querySelector("[data-home-compose-mobile-label]")?.textContent).toContain(
      "launch-9x16.mp4",
    );
    await act(async () => {
      host!.querySelector<HTMLButtonElement>("[data-home-compose-mobile-remove]")!.click();
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
