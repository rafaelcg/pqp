// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  resetSoundboardMarksForTests,
  setSoundboardUserMuted,
  showSoundboardMark,
} from "@/lib/soundboard";
import { ListenerStrip, type StripListener } from "./listener-strip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * The listener row under the stage and the soundboard: a chip lights when
 * its person plays a clip, and its menu mutes their clips, even when their
 * voice failed and so has no volume knob.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

function person(overrides: Partial<StripListener> = {}): StripListener {
  return {
    key: "ana",
    userId: "u-ana",
    soundboardUserId: "u-ana",
    name: "Ana",
    avatarUrl: null,
    speaking: false,
    muted: false,
    serverMuted: false,
    isSelf: false,
    ...overrides,
  };
}

function mount(people: StripListener[]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <ListenerStrip
          people={people}
          limit={12}
          open
          onToggle={() => {}}
          youLabel="(you)"
        />
      </TooltipProvider>,
    );
  });
}

beforeEach(() => localStorage.clear());

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetSoundboardMarksForTests();
  setSoundboardUserMuted("u-ana", false);
});

const chip = (name = "Ana") =>
  document.querySelector<HTMLElement>(`[data-call-listener="${name}"]`)!;
const row = () =>
  document.querySelector<HTMLElement>(
    '[data-testid="peer-audio-menu"] [data-testid="peer-audio-soundboard"]',
  );

describe("ListenerStrip soundboard", () => {
  it("offers the soundboard mute from a chip whose voice failed", () => {
    mount([person({ failed: true, onRetry: () => {} })]);
    act(() => chip().click());
    expect(row()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="peer-audio-menu"] [data-testid="peer-audio-voice"]'),
    ).toBeNull();
  });

  it("makes a chip with only the soundboard row pressable", () => {
    mount([person()]);
    expect(chip().getAttribute("role")).toBe("button");
    act(() => chip().click());
    expect(row()).not.toBeNull();
  });

  it("offers no row for ourselves", () => {
    mount([person({ key: "me", name: "Eu", soundboardUserId: undefined, isSelf: true })]);
    expect(chip("Eu").getAttribute("role")).toBeNull();
  });

  it("lights the chip's face with a small badge while a clip sounds", () => {
    mount([person()]);
    expect(chip().querySelector("[data-soundboard-float]")).toBeNull();
    act(() => {
      showSoundboardMark({
        userId: "u-ana",
        displayName: "Ana",
        emoji: "x",
        soundId: "builtin:risada",
      });
    });
    const badge = chip().querySelector<HTMLElement>("[data-soundboard-float='sm']")!;
    expect(badge.textContent).toBe("Ana played Laugh");
  });

  it("marks a muted person on the chip, in the chip's name", () => {
    mount([person()]);
    act(() => setSoundboardUserMuted("u-ana", true));
    expect(chip().querySelector("[data-soundboard-muted-mark]")).not.toBeNull();
    expect(chip().getAttribute("aria-label")).toContain("soundboard sounds are muted");
  });
});
