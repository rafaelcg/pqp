// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoryContent, type StoryDisplay } from "./story-content";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const video: StoryDisplay = {
  id: "v1",
  kind: "video",
  text: null,
  background: null,
  caption: null,
  mediaUrl: "blob:http://localhost/clip",
  posterUrl: null,
  call: null,
};

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(muted: boolean) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<StoryContent story={video} muted={muted} loop withLayers={false} />));
  return host.querySelector("video") as HTMLVideoElement;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("a story video's sound", () => {
  // jsdom has no media pipeline.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);

  // The composer previews the clip it is editing muted; the viewer decides for itself.
  it("is muted when asked, which is how the composer previews a clip", () => {
    expect(mount(true).muted).toBe(true);
  });

  it("has sound when the caller says so", () => {
    expect(mount(false).muted).toBe(false);
  });
});
