// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  RoomCards,
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
