// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommunityHomeComposeEmbed } from "./community-home-compose-embed";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const youtube = "https://youtu.be/jNQXAC9IVRw";

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(url: string, debounceMs = 300) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <CommunityHomeComposeEmbed url={url} debounceMs={debounceMs} />,
    );
  });
}

async function rerender(url: string, debounceMs = 300) {
  await act(async () => {
    root!.render(
      <CommunityHomeComposeEmbed url={url} debounceMs={debounceMs} />,
    );
  });
}

describe("CommunityHomeComposeEmbed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    host?.remove();
    root = null;
    host = null;
    vi.useRealTimers();
  });

  it("shows nothing while the field is empty", async () => {
    await mount("");
    expect(host!.querySelector("[data-home-compose-embed]")).toBeNull();
    expect(host!.querySelector("[data-home-compose-embed-skeleton]")).toBeNull();
    expect(host!.querySelector("[data-home-compose-embed-hint]")).toBeNull();
  });

  it("unfurls a YouTube paste into the same player the feed uses, after debounce", async () => {
    await mount("");
    await rerender(youtube);
    expect(host!.querySelector("[data-home-compose-embed-skeleton]")).not.toBeNull();
    expect(host!.querySelector("[data-home-media='youtube']")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(host!.querySelector("[data-home-compose-embed-skeleton]")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    const iframe = host!.querySelector("[data-home-media='youtube'] iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toBe(
      "https://www.youtube-nocookie.com/embed/jNQXAC9IVRw",
    );
    expect(host!.querySelector("[data-home-compose-embed-hint]")).toBeNull();
    expect(host!.querySelector("[data-home-compose-error]")).toBeNull();
    expect(host!.querySelector(".text-danger")).toBeNull();
  });

  it("unfurls TikTok and Instagram into the same players the feed uses", async () => {
    await mount(
      "https://www.tiktok.com/@scout2015/video/6718335390845095173",
      0,
    );
    expect(host!.querySelector("[data-home-media='tiktok'] iframe")?.getAttribute("src")).toBe(
      "https://www.tiktok.com/player/v1/6718335390845095173",
    );

    await rerender("https://www.instagram.com/reel/CqK2e0_JXkA/", 0);
    expect(host!.querySelector("[data-home-media='instagram'] iframe")?.getAttribute("src")).toBe(
      "https://www.instagram.com/reel/CqK2e0_JXkA/embed/",
    );
  });

  it("does not scold while typing; muted hint only after idle", async () => {
    await mount("");
    await rerender("https://example.com/watch");
    expect(host!.querySelector("[data-home-compose-embed-hint]")).toBeNull();
    expect(host!.querySelector("[data-home-compose-embed-skeleton]")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    const hint = host!.querySelector("[data-home-compose-embed-hint]");
    expect(hint).not.toBeNull();
    expect(hint?.className).toContain("text-paper-muted");
    expect(hint?.className).not.toContain("text-danger");
    expect(host!.querySelector("[data-home-media='youtube']")).toBeNull();
  });

  it("swaps an unsupported idle hint for the player when the URL becomes valid", async () => {
    await mount("https://example.com/x", 0);
    expect(host!.querySelector("[data-home-compose-embed-hint]")).not.toBeNull();

    await rerender(youtube, 0);
    expect(host!.querySelector("[data-home-media='youtube']")).not.toBeNull();
    expect(host!.querySelector("[data-home-compose-embed-hint]")).toBeNull();
  });
});
