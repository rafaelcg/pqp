// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resetSoundboardMarksForTests, setSoundboardUserMuted, showSoundboardMark } from "@/lib/soundboard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { CameraTile, OccupantFaces, ScreenTileFrame, personAudioTracks } = await import("./call-stage");
type StagePerson = Parameters<typeof personAudioTracks>[0];
type Face = Parameters<typeof OccupantFaces>[0]["faces"][number];

/**
 * The listener's side of the soundboard on the surfaces that show people:
 * the collapsed call bar and its "+N", and a camera tile's overlay. What is
 * pinned is that the person's menu can be reached and read from each of them,
 * and that it offers the soundboard mute whether or not their voice works.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactElement) {
  host = document.createElement("div");
  // The collapsed bar's dock clips whatever sticks out of it.
  host.style.overflow = "hidden";
  host.setAttribute("data-testid", "dock");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(<TooltipProvider>{node}</TooltipProvider>);
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetSoundboardMarksForTests();
  setSoundboardUserMuted("u-ana", false);
});

function face(name: string, overrides: Partial<Face> = {}): Face {
  return {
    key: name,
    userId: `u-${name.toLowerCase()}`,
    soundboardUserId: `u-${name.toLowerCase()}`,
    displayName: name,
    avatarUrl: null,
    volume: 1,
    onSetVolume: () => {},
    ...overrides,
  };
}

const menu = () =>
  document.querySelector<HTMLElement>('[data-testid="peer-audio-menu"]');
const switchRow = () =>
  menu()?.querySelector<HTMLElement>(
    '[data-testid="peer-audio-soundboard"] [role="switch"]',
  ) ?? null;

describe("the collapsed call bar's faces", () => {
  it("opens a face's menu outside the dock, so the dock cannot clip it", () => {
    mount(<OccupantFaces faces={[face("Ana"), face("Bia")]} />);
    const button = host!.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="dialog"]',
    )!;
    act(() => button.click());
    expect(menu()).not.toBeNull();
    expect(host!.contains(menu())).toBe(false);
    expect(menu()!.style.position).toBe("fixed");
    expect(menu()!.style.visibility).toBe("visible");
    expect(switchRow()).not.toBeNull();
  });

  it("gives the face after the third an entry point: a count that lists them", () => {
    const faces = ["Ana", "Bia", "Cai", "Duda", "Eli"].map((n) => face(n));
    mount(<OccupantFaces faces={faces} />);
    expect(host!.querySelectorAll('button[aria-haspopup="dialog"]')).toHaveLength(4);
    const more = host!.querySelector<HTMLButtonElement>('[data-testid="call-bar-more"]')!;
    expect(more.textContent).toBe("+2");
    expect(more.getAttribute("aria-label")).toBe("2 more in the call");

    act(() => more.click());
    const list = document.querySelector<HTMLElement>('[data-testid="call-bar-people"]')!;
    expect(host!.contains(list)).toBe(false);
    const people = [...list.querySelectorAll('[data-testid="call-bar-person"]')];
    expect(people.map((p) => p.lastElementChild?.textContent)).toEqual(["Duda", "Eli"]);

    // Picking the fifth opens her menu, with the soundboard switch, in place of the list.
    act(() => (people[1] as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="call-bar-people"]')).toBeNull();
    expect(menu()!.getAttribute("aria-label")).toContain("Eli");
    expect(switchRow()).not.toBeNull();
  });

  it("gives every face and the count a 40px target on a coarse pointer, none sharing a pixel", () => {
    const faces = ["Ana", "Bia", "Cai", "Duda"].map((n) => face(n));
    mount(<OccupantFaces faces={faces} />);
    const targets = [...host!.querySelectorAll<HTMLElement>("[data-banner-target]")];
    expect(targets).toHaveLength(4);
    for (const target of targets) {
      expect(target.className).toContain("pointer-coarse:h-10");
      expect(target.className).toMatch(/pointer-coarse:(min-)?w-10|pointer-coarse:min-w-10/);
    }
    // Each target is 40px wide and the stack stops overlapping them on touch
    // (the desktop overlap stays), so the boxes sit edge to edge.
    const stack = targets[0]!.closest("span.flex")!;
    expect(stack.className).toContain("-space-x-2");
    expect(stack.className).toContain("pointer-coarse:space-x-0");
  });

  it("does not list ourselves behind the count", () => {
    const faces = [
      face("Ana"),
      face("Bia"),
      face("Cai"),
      face("Eu", { isSelf: true, soundboardUserId: undefined, onSetVolume: undefined }),
      face("Duda"),
    ];
    mount(<OccupantFaces faces={faces} />);
    const more = host!.querySelector<HTMLButtonElement>('[data-testid="call-bar-more"]')!;
    expect(more.textContent).toBe("+1");
    act(() => more.click());
    const list = document.querySelector<HTMLElement>('[data-testid="call-bar-people"]')!;
    const names = [...list.querySelectorAll('[data-testid="call-bar-person"]')].map(
      (p) => p.lastElementChild?.textContent,
    );
    expect(names).toEqual(["Duda"]);
  });

  it("closes the list on Escape and hands the focus back to the count", () => {
    const faces = ["Ana", "Bia", "Cai", "Duda"].map((n) => face(n));
    mount(<OccupantFaces faces={faces} />);
    const more = host!.querySelector<HTMLButtonElement>('[data-testid="call-bar-more"]')!;
    act(() => more.click());
    const list = document.querySelector<HTMLElement>('[data-testid="call-bar-people"]')!;
    expect(document.activeElement).toBe(list);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[data-testid="call-bar-people"]')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("offers the soundboard row when the voice track failed or is absent", () => {
    mount(
      <OccupantFaces
        faces={[
          face("Ana", { volume: undefined, onSetVolume: undefined, failed: true }),
        ]}
      />,
    );
    act(() => host!.querySelector<HTMLButtonElement>("button")!.click());
    expect(switchRow()).not.toBeNull();
    expect(menu()!.querySelector('[data-testid="peer-audio-voice"]')).toBeNull();
  });

  it("offers nothing for ourselves, who carry no soundboard row and no knob", () => {
    mount(
      <OccupantFaces
        faces={[
          face("Eu", { soundboardUserId: undefined, onSetVolume: undefined }),
        ]}
      />,
    );
    expect(host!.querySelector("button")).toBeNull();
  });

  it("draws a small badge on the face while their clip sounds, not a disc over it", () => {
    mount(<OccupantFaces faces={[face("Ana")]} />);
    act(() => {
      showSoundboardMark({
        userId: "u-ana",
        displayName: "Ana",
        emoji: "x",
        soundId: "builtin:buzina",
      });
    });
    const badge = host!.querySelector<HTMLElement>('[data-soundboard-float="sm"]')!;
    expect(badge.className).toContain("h-3.5");
    expect(badge.className).not.toContain("h-8");
  });
});

describe("a person's audio tracks", () => {
  const base: StagePerson = {
    key: "k",
    name: "Ana",
    avatarUrl: null,
    stream: null,
    speaking: false,
    muted: false,
    serverMuted: false,
    connecting: false,
    isSelf: false,
  };

  it("keeps the soundboard row for a failed connection and drops the sliders", () => {
    const tracks = personAudioTracks({
      ...base,
      failed: true,
      onSetVolume: () => {},
      soundboardUserId: "u-ana",
    });
    expect(tracks).toEqual({
      voice: undefined,
      share: undefined,
      soundboardUserId: "u-ana",
    });
  });

  it("never offers the soundboard row for ourselves", () => {
    expect(
      personAudioTracks({ ...base, isSelf: true, soundboardUserId: "u-me" }),
    ).toBeUndefined();
  });
});

describe("a camera tile's overlay", () => {
  it("carries the soundboard mute even when the voice cannot be turned down", () => {
    mount(
      <CameraTile
        person={{
          key: "k",
          userId: "u-ana",
          soundboardUserId: "u-ana",
          name: "Ana",
          avatarUrl: null,
          stream: null,
          speaking: false,
          muted: false,
          serverMuted: false,
          connecting: false,
          isSelf: false,
        }}
        youLabel="(you)"
      />,
    );
    const open = host!.querySelector<HTMLButtonElement>('[data-testid="peer-audio-open"]')!;
    expect(open).not.toBeNull();
    act(() => open.click());
    const row = document.querySelector('[data-testid="peer-audio-soundboard"]');
    expect(row).not.toBeNull();
  });
});

function play(userId: string, displayName: string, soundId = "builtin:buzina") {
  act(() => {
    showSoundboardMark({ userId, displayName, emoji: "x", soundId });
  });
}

describe("a clip from somebody behind the count", () => {
  const five = () => ["Ana", "Bia", "Cai", "Duda", "Eli"].map((n) => face(n));
  const more = () =>
    host!.querySelector<HTMLButtonElement>('[data-testid="call-bar-more"]')!;

  it("shows no cue on the count while nobody it covers plays", () => {
    mount(<OccupantFaces faces={five()} />);
    expect(host!.querySelector("[data-soundboard-group-mark]")).toBeNull();
    expect(more().getAttribute("aria-label")).toBe("2 more in the call");
  });

  it("puts a badge on the count and names who is playing", () => {
    mount(<OccupantFaces faces={five()} />);
    play("u-eli", "Eli");
    const badge = more().querySelector<HTMLElement>("[data-soundboard-group-mark]");
    expect(badge).not.toBeNull();
    expect(badge!.className).toContain("h-3.5");
    expect(more().getAttribute("aria-label")).toContain("Eli played Airhorn");
    expect(host!.querySelector('[role="status"]')?.textContent).toContain(
      "Eli played Airhorn",
    );
  });

  it("ignores a clip from one of the three faces the bar already draws", () => {
    mount(<OccupantFaces faces={five()} />);
    play("u-ana", "Ana");
    expect(more().querySelector("[data-soundboard-group-mark]")).toBeNull();
    expect(host!.querySelector('[data-soundboard-float="sm"]')).not.toBeNull();
  });

  it("marks the playing person's row inside the list, and only theirs", () => {
    mount(<OccupantFaces faces={five()} />);
    act(() => more().click());
    play("u-duda", "Duda", "builtin:palmas");
    const rows = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="call-bar-person"]'),
    ];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('[data-soundboard-mark="builtin:palmas"]')).not.toBeNull();
    expect(rows[0]!.getAttribute("aria-label")).toContain("Duda played");
    expect(rows[1]!.querySelector("[data-soundboard-mark]")).toBeNull();
  });

  it("shows the cue on a count that is only a chip, too", () => {
    const faces = ["Ana", "Bia", "Cai", "Duda"].map((n) =>
      face(n, { soundboardUserId: undefined, onSetVolume: undefined }),
    );
    mount(<OccupantFaces faces={faces} />);
    play("u-duda", "Duda");
    expect(host!.querySelector("[data-soundboard-group-mark]")).not.toBeNull();
  });

  it("takes the cue away when the clip ends", () => {
    vi.useFakeTimers();
    try {
      mount(<OccupantFaces faces={five()} />);
      play("u-eli", "Eli");
      expect(more().querySelector("[data-soundboard-group-mark]")).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(6000);
      });
      expect(more().querySelector("[data-soundboard-group-mark]")).toBeNull();
      expect(more().getAttribute("aria-label")).toBe("2 more in the call");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a shared screen's tile", () => {
  const tile = {
    peerId: "peer-ana",
    stream: null,
    presenterName: "Ana",
    isSelf: false,
    userId: "u-ana" as string | null,
    hasAudio: false,
  };

  it("shows the presenter's clip where a camera tile does, without taking the pointer", () => {
    mount(<ScreenTileFrame tile={tile} isFullscreen={false} onToggleFullscreen={() => {}} />);
    expect(host!.querySelector("[data-soundboard-float]")).toBeNull();
    play("u-ana", "Ana");
    const float = host!.querySelector<HTMLElement>('[data-soundboard-float="md"]')!;
    expect(float).not.toBeNull();
    expect(float.className).toContain("pointer-events-none");
    expect(float.textContent).toContain("Ana played Airhorn");
    // The share's own controls are still there and are not inside the float.
    expect(host!.querySelector('[data-testid="share-fullscreen"]')).not.toBeNull();
    expect(float.contains(host!.querySelector('[data-testid="share-fullscreen"]'))).toBe(false);
  });

  it("shows nothing for another person's clip", () => {
    mount(<ScreenTileFrame tile={tile} isFullscreen={false} />);
    play("u-bia", "Bia");
    expect(host!.querySelector("[data-soundboard-float]")).toBeNull();
  });
});
