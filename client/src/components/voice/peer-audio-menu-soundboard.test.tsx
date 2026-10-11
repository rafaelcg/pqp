// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PeerAudioMenu } from "./peer-audio-menu";
import { isSoundboardUserMuted, setSoundboardUserMuted } from "@/lib/soundboard";

/*
 * Muting one person's soundboard clips, from the same panel that turns their
 * voice down. Discord has only a global slider; this is the control its users
 * keep asking for. Local to this listener.
 */

const RAFA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let host: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(soundboardUserId?: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <PeerAudioMenu
        name="Rafa"
        open
        voice={{ volume: 1, onSetVolume: () => {} }}
        soundboardUserId={soundboardUserId}
      />,
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  setSoundboardUserMuted(RAFA, false);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe("PeerAudioMenu soundboard row", () => {
  it("mutes and unmutes one person's clips, and remembers it", () => {
    mount(RAFA);
    const toggle = host!.querySelector<HTMLButtonElement>(
      "[data-testid='peer-audio-soundboard'] button",
    )!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    const name = toggle.getAttribute("aria-label");
    act(() => toggle.click());
    expect(isSoundboardUserMuted(RAFA)).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe(name);
    expect(JSON.parse(localStorage.getItem("pqp:soundboard-muted-users")!)).toEqual([RAFA]);
    act(() => toggle.click());
    expect(isSoundboardUserMuted(RAFA)).toBe(false);
  });

  it("is absent where there is nobody else to mute", () => {
    mount(undefined);
    expect(host!.querySelector("[data-testid='peer-audio-soundboard']")).toBeNull();
  });
});
