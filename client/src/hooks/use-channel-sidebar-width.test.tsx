// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHANNEL_SIDEBAR_DEFAULT_WIDTH,
  CHANNEL_SIDEBAR_MIN_WIDTH,
} from "@/lib/channel-sidebar-width";
import { useChannelSidebarWidth } from "./use-channel-sidebar-width";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const seen: { width: number; commit: (width: number) => void }[] = [];

function Probe() {
  const { width, commitWidth } = useChannelSidebarWidth();
  seen.push({ width, commit: commitWidth });
  return null;
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

const last = () => seen[seen.length - 1]!;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  seen.length = 0;
  window.localStorage.clear();
});

describe("the channel column's width across window resizes", () => {
  it("narrows with a narrow window and comes back when the window grows again", () => {
    setViewport(1400);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Probe />));
    expect(last().width).toBe(CHANNEL_SIDEBAR_DEFAULT_WIDTH);
    setViewport(480);
    expect(last().width).toBe(CHANNEL_SIDEBAR_MIN_WIDTH);
    setViewport(1400);
    expect(last().width).toBe(CHANNEL_SIDEBAR_DEFAULT_WIDTH);
  });

  it("a width the person chose comes back too, not the narrow window's", () => {
    setViewport(1400);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Probe />));
    act(() => last().commit(380));
    expect(last().width).toBe(380);
    setViewport(700);
    expect(last().width).toBe(280);
    setViewport(1600);
    expect(last().width).toBe(380);
  });
});
