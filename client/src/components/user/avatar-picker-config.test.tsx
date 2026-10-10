// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A failed upload-config read is forgotten so the next open of Settings asks
 * again, but a re-render of the same picker must not: callers pass a fresh
 * `onUploaded` arrow on every keystroke.
 */

const fetchAvatarConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchAvatarConfig,
}));

const { AvatarPicker } = await import("./avatar-picker");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const labels = {
  urlPlaceholder: "https://example.com/a.png",
  urlLabel: "Image link",
  presets: "Ready-made avatars",
  preset: (name: string) => `Ready-made avatar, ${name}`,
  presetName: (number: number) => `name ${number}`,
  presetSelected: (name: string) => `Selected: ${name}`,
  remove: "Remove",
  useLink: "Use a link",
  upload: "Upload",
  uploading: "Uploading",
  uploadFailed: "Upload failed",
};

async function render(value: string) {
  await act(async () => {
    root!.render(
      <AvatarPicker
        value={value}
        onChange={() => {}}
        fallbackName="Dev"
        onUploaded={() => {}}
        labels={labels}
      />,
    );
  });
}

describe("AvatarPicker upload config", () => {
  it("asks once per mount while the read keeps failing, then again on the next mount", async () => {
    fetchAvatarConfig.mockRejectedValue(new Error("offline"));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render("");
    await render("a");
    await render("ab");
    expect(fetchAvatarConfig).toHaveBeenCalledTimes(1);

    act(() => root?.unmount());
    root = createRoot(host);
    await render("");
    expect(fetchAvatarConfig).toHaveBeenCalledTimes(2);
  });
});
