// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchNowStream } from "@/lib/watch-now";
import { WatchNowBanner, type WatchNowBannerProps } from "./watch-now-banner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const NOW = 1_800_000_000_000;

function stream(overrides: Partial<WatchNowStream> = {}): WatchNowStream {
  return {
    key: "c1:alberto",
    channelId: "c1",
    kind: "voice",
    place: "filminho",
    sharerUserId: "alberto",
    sharerName: "Alberto",
    startedAt: NOW - 12 * 60_000,
    watching: 38,
    inRoom: false,
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;

function mount(props: Partial<WatchNowBannerProps> & { streams: WatchNowStream[] }) {
  const all: WatchNowBannerProps = {
    onWatch: () => {},
    onDismiss: () => {},
    now: NOW,
    ...props,
  };
  act(() => root.render(<WatchNowBanner {...all} />));
  return all;
}

function setReducedMotion(reduced: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as typeof window.matchMedia;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  setReducedMotion(false);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("WatchNowBanner", () => {
  it("says who, where, how many and how long, with one primary button", () => {
    mount({ streams: [stream()] });
    const region = host.querySelector("section[data-watch-now-banner]");
    expect(region?.getAttribute("aria-label")).toBe("Live stream");
    expect(region?.textContent).toContain(
      "Alberto is sharing their screen in #filminho",
    );
    expect(region?.textContent).toContain("38 watching");
    expect(region?.textContent).toContain("12 min ago");
    const watch = host.querySelectorAll("[data-watch-now-watch]");
    expect(watch).toHaveLength(1);
    expect(watch[0]?.textContent).toBe("Watch");
    expect(host.querySelector("[data-watch-now-dismiss]")?.textContent).toBe(
      "Not now",
    );
  });

  it("says nothing about the age when the start is not known, and nothing about a count of zero", () => {
    mount({ streams: [stream({ startedAt: null, watching: 0 })] });
    const text = host.textContent ?? "";
    expect(text).not.toContain("watching");
    expect(text).not.toContain("ago");
    expect(text).not.toContain("just started");
  });

  it("names a party by its own name and a call without a channel", () => {
    mount({
      streams: [stream({ kind: "party", place: "Cinemoon", key: "c2:a", channelId: "c2" })],
    });
    expect(host.textContent).toContain("Alberto is live in the watch party Cinemoon");
    mount({ streams: [stream({ kind: "call", place: null, key: "c3:a", channelId: "c3" })] });
    expect(host.textContent).toContain("Alberto is sharing their screen in the call");
  });

  it("passes the stream to onWatch and onDismiss", () => {
    const onWatch = vi.fn();
    const onDismiss = vi.fn();
    const s = stream();
    mount({ streams: [s], onWatch, onDismiss });
    act(() => {
      (host.querySelector("[data-watch-now-watch]") as HTMLButtonElement).click();
    });
    expect(onWatch).toHaveBeenCalledWith(s);
    act(() => {
      (host.querySelector("[data-watch-now-dismiss]") as HTMLButtonElement).click();
    });
    expect(onDismiss).toHaveBeenCalledWith(s);
  });

  it("turns into a way back when the person is already in the call", () => {
    mount({ streams: [stream({ inRoom: true })] });
    expect(host.querySelector("[data-watch-now-watch]")?.textContent).toBe(
      "Back to the stream",
    );
  });

  it("disables the button while the join is in flight", () => {
    mount({ streams: [stream()], joiningChannelId: "c1" });
    const button = host.querySelector("[data-watch-now-watch]") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Joining the stream");
  });

  it("shows why a join failed, under the strip", () => {
    mount({ streams: [stream()], failure: "This voice channel is full (max 8)." });
    expect(host.querySelector("[data-watch-now-failure]")?.textContent).toContain(
      "This voice channel is full (max 8).",
    );
  });

  it("is a labelled region with a polite status, never an alert, and the ticking numbers are hidden from assistive tech", () => {
    mount({ streams: [stream()] });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const status = host.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    // Announced after mount, once, for the headline stream only.
    expect(status?.textContent).toBe("Alberto started streaming in #filminho");
    const meta = Array.from(host.querySelectorAll("p[aria-hidden='true']")).map(
      (node) => node.textContent,
    );
    expect(meta.join(" ")).toContain("38 watching");
  });

  it("does not announce again for the same stream when the count moves", () => {
    mount({ streams: [stream()] });
    const first = host.querySelector('[role="status"]')?.textContent;
    mount({ streams: [stream({ watching: 39 })] });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(first);
  });

  it("keeps the rest behind a disclosure with the count in its label", () => {
    const second = stream({
      key: "c2:bia",
      channelId: "c2",
      sharerName: "Bia",
      place: "papo",
      watching: 2,
    });
    mount({ streams: [stream(), second] });
    const more = host.querySelector("[data-watch-now-more]") as HTMLButtonElement;
    expect(more.textContent).toContain("+1 stream");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelectorAll("[data-watch-now-row]")).toHaveLength(0);
    act(() => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll("[data-watch-now-row]")).toHaveLength(1);
    expect(host.querySelector("[data-watch-now-row]")?.textContent).toContain(
      "Bia is sharing their screen in #papo",
    );
  });

  it("collapses out when the stream ends, then unmounts", () => {
    vi.useFakeTimers();
    mount({ streams: [stream()] });
    mount({ streams: [] });
    expect(
      host.querySelector("[data-watch-now-banner]")?.hasAttribute("data-watch-now-leaving"),
    ).toBe(true);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(host.querySelector("[data-watch-now-banner]")).toBeNull();
  });

  it("just goes under reduced motion", () => {
    setReducedMotion(true);
    mount({ streams: [stream()] });
    mount({ streams: [] });
    expect(host.querySelector("[data-watch-now-banner]")).toBeNull();
  });
});
