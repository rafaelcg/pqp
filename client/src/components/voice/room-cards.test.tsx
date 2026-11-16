// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  RoomCards,
  dockOverlap,
  type RoomCardEntry,
  type RoomCardMenuFor,
} from "./room-cards";
import { roomCardMenuItems } from "./room-card-menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function entry(
  name: string,
  overrides: Partial<RoomCardEntry> = {},
): RoomCardEntry {
  return {
    key: name,
    userId: `u-${name.toLowerCase()}`,
    name,
    avatarUrl: null,
    speaking: false,
    muted: false,
    deafened: false,
    serverMuted: false,
    handPosition: null,
    connecting: false,
    isSelf: false,
    audio: { voice: { volume: 1, onSetVolume: vi.fn() } },
    ...overrides,
  };
}

function mount(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(<TooltipProvider>{node}</TooltipProvider>);
  });
}

beforeEach(() => localStorage.clear());

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
});

const card = (name: string) =>
  host!.querySelector<HTMLElement>(`[data-call-listener="${name}"]`)!;
const cardFace = (name: string) =>
  card(name).querySelector<HTMLElement>("button, div")!;

function rightClick(target: Element) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }),
    );
  });
}

const menuLabels = () =>
  [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].map(
    (item) => item.textContent?.trim(),
  );

function menuForModerator(): RoomCardMenuFor {
  return (person, anchor) =>
    roomCardMenuItems({
      t: (key) => key,
      userId: person.userId,
      name: person.name,
      isSelf: person.isSelf,
      serverMuted: person.serverMuted,
      handRaised: person.handPosition !== null,
      volume: person.audio?.voice?.volume,
      onSetVolume: person.audio?.voice?.onSetVolume,
      moderation: {
        canServerMute: true,
        canDisconnect: true,
        canKick: () => true,
        onServerMute: vi.fn(),
        onDisconnect: vi.fn(),
        onKick: vi.fn(),
      },
      openProfile: () => anchor(),
    });
}

describe("a room card's right-click menu", () => {
  it("opens the person's menu on right-click, with the sound item first", () => {
    mount(
      <RoomCards
        youLabel="(you)"
        people={[entry("Bia")]}
        menuFor={menuForModerator()}
      />,
    );
    expect(document.querySelector("[role='menu']")).toBeNull();
    rightClick(cardFace("Bia"));
    expect(menuLabels()).toEqual([
      "Bia's audio",
      "voice.occupant.profile",
      "voice.occupant.muteForMe",
      "voice.occupant.serverMute",
      "voice.occupant.disconnect",
      "voice.occupant.kick",
      "voice.occupant.copyName",
    ]);
  });

  it("gives your own card profile and copy name", () => {
    mount(
      <RoomCards
        youLabel="(you)"
        people={[entry("Ana", { isSelf: true, audio: undefined })]}
        menuFor={menuForModerator()}
      />,
    );
    rightClick(cardFace("Ana"));
    expect(menuLabels()).toEqual([
      "voice.occupant.profile",
      "voice.occupant.copyName",
    ]);
  });

  it("keeps the left-click audio panel", () => {
    mount(
      <RoomCards
        youLabel="(you)"
        people={[entry("Bia")]}
        menuFor={menuForModerator()}
      />,
    );
    act(() => cardFace("Bia").click());
    expect(
      document.querySelector('[data-testid="peer-audio-menu"]'),
    ).not.toBeNull();
    expect(document.querySelector("[role='menu']")).toBeNull();
  });

  it("opens the same audio panel from the menu's sound item", () => {
    mount(
      <RoomCards
        youLabel="(you)"
        people={[entry("Bia")]}
        menuFor={menuForModerator()}
      />,
    );
    rightClick(cardFace("Bia"));
    act(() =>
      document
        .querySelectorAll<HTMLElement>("[role='menuitem']")[0]!
        .click(),
    );
    expect(
      document.querySelector('[data-testid="peer-audio-menu"]'),
    ).not.toBeNull();
  });

  it("stops the initials being selected", () => {
    mount(<RoomCards youLabel="(you)" people={[entry("Bia")]} />);
    expect(cardFace("Bia").className).toContain("select-none");
  });

  it("draws no menu when the stage gives none", () => {
    mount(<RoomCards youLabel="(you)" people={[entry("Bia")]} />);
    rightClick(cardFace("Bia"));
    expect(document.querySelector("[role='menu']")).toBeNull();
  });
});

describe("dockOverlap", () => {
  it("is how far the dock reaches up into the cards' box", () => {
    expect(dockOverlap(900, 828)).toBe(72);
    expect(dockOverlap(900, 827.4)).toBe(73);
  });

  it("is zero when the dock sits below, or only touches, the cards' box", () => {
    expect(dockOverlap(828, 900)).toBe(0);
    expect(dockOverlap(900, 900)).toBe(0);
    expect(dockOverlap(900, 899)).toBe(0);
  });
});

describe("the room cards and the floating dock", () => {
  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    constructor(private readonly callback: () => void) {
      FakeResizeObserver.instances.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    fire() {
      this.callback();
    }
  }

  const rect = (top: number, bottom: number, width = 800): DOMRect =>
    ({
      top,
      bottom,
      left: 0,
      right: width,
      width,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON() {},
    }) as DOMRect;

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reserves the space the dock covers, so the last row stays whole", () => {
    // A stage: the banner column and the dock are children of the stage,
    // beside the element that holds the cards.
    const stage = document.createElement("div");
    const banner = document.createElement("div");
    banner.setAttribute("data-stage-banners", "");
    const dock = document.createElement("div");
    dock.setAttribute("data-call-chrome", "bar");
    const body = document.createElement("div");
    stage.append(banner, body, dock);
    document.body.append(stage);
    banner.getBoundingClientRect = () => rect(0, 0);
    dock.getBoundingClientRect = () => rect(800, 892);

    root = createRoot(body);
    host = stage;
    act(() => {
      root!.render(
        <TooltipProvider>
          <RoomCards
            youLabel="(you)"
            people={[entry("Ana"), entry("Bia"), entry("Cai")]}
          />
        </TooltipProvider>,
      );
    });
    const cards = stage.querySelector<HTMLElement>(
      '[data-testid="stage-room-cards"]',
    )!;
    // The cards' box runs to the stage's bottom edge (892), under the dock.
    cards.getBoundingClientRect = () => rect(0, 892);
    act(() => FakeResizeObserver.instances.forEach((o) => o.fire()));

    // 892 - 800 = 92px of dock over the box, on top of the 12px padding.
    expect(cards.style.paddingBottom).toBe("104px");
    expect(cards.style.paddingTop).toBe("12px");
  });

  it("reserves nothing when there is no dock over the cards", () => {
    const stage = document.createElement("div");
    const banner = document.createElement("div");
    banner.setAttribute("data-stage-banners", "");
    const body = document.createElement("div");
    stage.append(banner, body);
    document.body.append(stage);
    banner.getBoundingClientRect = () => rect(0, 0);
    root = createRoot(body);
    host = stage;
    act(() => {
      root!.render(
        <TooltipProvider>
          <RoomCards youLabel="(you)" people={[entry("Ana")]} />
        </TooltipProvider>,
      );
    });
    const cards = stage.querySelector<HTMLElement>(
      '[data-testid="stage-room-cards"]',
    )!;
    cards.getBoundingClientRect = () => rect(0, 892);
    act(() => FakeResizeObserver.instances.forEach((o) => o.fire()));
    expect(cards.style.paddingBottom).toBe("12px");
  });
});
