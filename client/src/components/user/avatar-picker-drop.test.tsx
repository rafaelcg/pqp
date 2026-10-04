// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A picture dropped on the avatar picker.
 *
 * The same control backs Settings and onboarding, and the banner, server icon
 * and cover pickers are built the same way (`FileDropZone` around the control,
 * the picker's own `handleFile` as the handler), so what is pinned here is the
 * contract they share: a drop is the picker's pick, down the same function, so
 * the same crop and the same "that file is not an image" answer apply. There is
 * no second validation path for a drop to slip past.
 */

const uploadSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAvatarConfig: () => Promise.resolve({ enabled: true, maxBytes: 1, size: 512 }),
  };
});
vi.mock("@/lib/avatar-upload", () => ({
  uploadAvatar: (file: File) => uploadSpy(file),
}));

import { AvatarPicker } from "./avatar-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

const labels = {
  urlPlaceholder: "https://",
  urlLabel: "Avatar URL",
  presets: "Presets",
  preset: (number: number) => `Preset ${number}`,
  remove: "Remove",
  useLink: "Use a link",
  upload: "Upload",
  uploading: "Uploading",
  uploadFailed: "Upload failed",
};

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <AvatarPicker
        value=""
        onChange={() => {}}
        fallbackName="Dev"
        onUploaded={() => {}}
        labels={labels}
      />,
    );
  });
  // The upload config is fetched in an effect.
  await act(async () => {});
  return host.firstElementChild as HTMLElement;
}

function drop(zone: Element, items: { files?: File[]; directory?: string }) {
  const files = items.files ?? [];
  const entries = [
    ...files.map((f) => ({ f, dir: false })),
    ...(items.directory ? [{ f: new File([], items.directory), dir: true }] : []),
  ];
  const data = {
    types: ["Files"],
    files: [...files],
    items: entries.map(({ f, dir }) => ({
      kind: "file",
      getAsFile: () => f,
      webkitGetAsEntry: () => ({ isDirectory: dir, name: f.name }),
    })),
    dropEffect: "none",
  } as unknown as DataTransfer;
  for (const type of ["dragenter", "dragover", "drop"]) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: data });
    act(() => {
      zone.dispatchEvent(event);
    });
  }
}

beforeEach(() => {
  uploadSpy.mockReset();
  uploadSpy.mockResolvedValue({ avatarUrl: "https://x/y.jpg" });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("AvatarPicker drop", () => {
  it("takes a dropped image through the same upload as the picker", async () => {
    const zone = await mount();
    const png = new File([new Uint8Array([1])], "me.png", { type: "image/png" });
    drop(zone, { files: [png] });
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy).toHaveBeenCalledWith(png);
  });

  it("uses the first file of several", async () => {
    const zone = await mount();
    const a = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    const b = new File([new Uint8Array([1])], "b.png", { type: "image/png" });
    drop(zone, { files: [a, b] });
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy).toHaveBeenCalledWith(a);
  });

  it("answers a dropped folder with a message and uploads nothing", async () => {
    const zone = await mount();
    drop(zone, { directory: "Photos" });
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain(
      "Photos is a folder",
    );
  });

  it("shows the image-drop overlay while the drag is over it", async () => {
    const zone = await mount();
    const data = {
      types: ["Files"],
      files: [],
      items: [],
      dropEffect: "none",
    } as unknown as DataTransfer;
    const event = new Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: data });
    act(() => {
      zone.dispatchEvent(event);
    });
    const overlay = host!.querySelector("[data-file-drop-overlay]");
    expect(overlay?.textContent).toBe("Drop an image to use it");
    expect(overlay?.getAttribute("aria-hidden")).toBe("true");
  });
});
