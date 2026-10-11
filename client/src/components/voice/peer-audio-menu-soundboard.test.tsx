// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PeerAudioMenu } from "./peer-audio-menu";
import { isSoundboardUserMuted, setSoundboardUserMuted } from "@/lib/soundboard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const toggle = () =>
  host!.querySelector<HTMLButtonElement>(
    "[data-testid='peer-audio-soundboard'] [role='switch']",
  )!;

describe("PeerAudioMenu soundboard row", () => {
  it("is a switch: on while their clips play, off once muted, and remembers it", () => {
    mount(RAFA);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    act(() => toggle().click());
    expect(isSoundboardUserMuted(RAFA)).toBe(true);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(JSON.parse(localStorage.getItem("pqp:soundboard-muted-users")!)).toEqual([RAFA]);
    act(() => toggle().click());
    expect(isSoundboardUserMuted(RAFA)).toBe(false);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("names the switch with the row's visible word and the person, and never flips the name", () => {
    mount(RAFA);
    const visible = host!
      .querySelector("[data-testid='peer-audio-soundboard']")!
      .firstElementChild!.querySelector("span")!.textContent!;
    const accessible = toggle().textContent!;
    expect(visible).toBe("Soundboard");
    expect(accessible.toLowerCase()).toContain(visible.toLowerCase());
    expect(accessible).toContain("Rafa");
    act(() => toggle().click());
    expect(toggle().textContent).toBe(accessible);
  });

  it("shows a quiet muted mark beside their name in the menu header, only while muted", () => {
    mount(RAFA);
    expect(host!.querySelector("[data-soundboard-muted-mark]")).toBeNull();
    act(() => toggle().click());
    const mark = host!.querySelector("[data-soundboard-muted-mark]")!;
    expect(mark.getAttribute("role")).toBe("img");
    expect(mark.getAttribute("aria-label")).toBe("Rafa's soundboard sounds are muted");
    act(() => toggle().click());
    expect(host!.querySelector("[data-soundboard-muted-mark]")).toBeNull();
  });

  it("is absent where there is nobody else to mute", () => {
    mount(undefined);
    expect(host!.querySelector("[data-testid='peer-audio-soundboard']")).toBeNull();
  });
});
