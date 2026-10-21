// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceParticipant } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HandBadgeActionsContext,
  HandPositionBadge,
  useHandLowerFor,
  type HandBadgeActions,
} from "./hand-position-badge";
import { RaisedHandQueue } from "./raised-hand-queue";

/**
 * STICKY HANDS (`raised_hand_sticky`): a hand stays up until the person, a
 * moderator or leaving takes it down, so the places it is drawn are the places
 * it is lowered from. Real clicks on a real DOM, because "the number is a
 * button" is a claim about what a click does, not about a string of markup.
 * What lowers a hand on the server is in `server/src/ws/voice-raised-hands.test.ts`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<TooltipProvider>{node}</TooltipProvider>));
  return host;
}

function person(userId: string, handRaisedAt: number | null): VoiceParticipant {
  return {
    peerId: `peer-${userId}`,
    userId,
    displayName: userId,
    avatarUrl: null,
    sharingScreen: false,
    muted: false,
    deafened: false,
    serverMuted: false,
    handRaisedAt,
  };
}

function Tile({ userId, position }: { userId: string; position: number }) {
  const lower = useHandLowerFor(userId);
  return <HandPositionBadge position={position} onLower={lower} />;
}

describe("the number on a tile", () => {
  it("is only a picture without sticky hands", () => {
    const el = mount(<Tile userId="me" position={2} />);
    expect(el.querySelector("button")).toBeNull();
    expect(el.querySelector('[data-hand-position="2"]')).not.toBeNull();
  });

  it("lowers your own hand when you click it", () => {
    const lowerSelf = vi.fn();
    const actions: HandBadgeActions = { selfUserId: "me", lowerSelf };
    const el = mount(
      <HandBadgeActionsContext.Provider value={actions}>
        <Tile userId="me" position={2} />
      </HandBadgeActionsContext.Provider>,
    );
    const button = el.querySelector<HTMLButtonElement>("button")!;
    expect(button.textContent).toBe("2");
    act(() => button.click());
    expect(lowerSelf).toHaveBeenCalledTimes(1);
  });

  it("lowers somebody else's only for a moderator, by their id", () => {
    const lowerOther = vi.fn();
    const asModerator = mount(
      <HandBadgeActionsContext.Provider
        value={{ selfUserId: "me", lowerOther }}
      >
        <Tile userId="alice" position={1} />
      </HandBadgeActionsContext.Provider>,
    );
    act(() => asModerator.querySelector<HTMLButtonElement>("button")!.click());
    expect(lowerOther).toHaveBeenCalledWith("alice");

    act(() => root?.unmount());
    asModerator.remove();
    const asMember = mount(
      <HandBadgeActionsContext.Provider value={{ selfUserId: "me" }}>
        <Tile userId="alice" position={1} />
      </HandBadgeActionsContext.Provider>,
    );
    expect(asMember.querySelector("button")).toBeNull();
  });
});

describe("the queue, with sticky hands", () => {
  const room = [person("alice", 100), person("me", 200), person("bob", 300)];

  it("puts a lower control on your own row, and clicking it lowers", () => {
    const lowerSelf = vi.fn();
    const el = mount(
      <HandBadgeActionsContext.Provider value={{ selfUserId: "me", lowerSelf }}>
        <RaisedHandQueue participants={room} selfUserId="me" />
      </HandBadgeActionsContext.Provider>,
    );
    // Only yours: alice and bob are not yours to lower.
    const lowers = el.querySelectorAll("[data-hand-lower]");
    expect([...lowers].map((n) => n.getAttribute("data-hand-lower"))).toEqual([
      "me",
    ]);
    act(() => (lowers[0] as HTMLButtonElement).click());
    expect(lowerSelf).toHaveBeenCalledTimes(1);
  });

  it("gives a moderator Baixar todas, in the panel and on the compact line", () => {
    const lowerAll = vi.fn();
    const panel = mount(
      <HandBadgeActionsContext.Provider value={{ selfUserId: "me", lowerAll }}>
        <RaisedHandQueue participants={room} selfUserId="me" />
      </HandBadgeActionsContext.Provider>,
    );
    act(() =>
      panel.querySelector<HTMLButtonElement>("[data-hand-lower-all]")!.click(),
    );
    expect(lowerAll).toHaveBeenCalledTimes(1);

    act(() => root?.unmount());
    panel.remove();
    const compact = mount(
      <HandBadgeActionsContext.Provider value={{ selfUserId: "me", lowerAll }}>
        <RaisedHandQueue participants={room} selfUserId="me" compact />
      </HandBadgeActionsContext.Provider>,
    );
    act(() =>
      compact
        .querySelector<HTMLButtonElement>("[data-hand-lower-all]")!
        .click(),
    );
    expect(lowerAll).toHaveBeenCalledTimes(2);
  });

  it("makes your place on the compact line the button that lowers it", () => {
    const lowerSelf = vi.fn();
    const el = mount(
      <HandBadgeActionsContext.Provider value={{ selfUserId: "me", lowerSelf }}>
        <RaisedHandQueue participants={room} selfUserId="me" compact />
      </HandBadgeActionsContext.Provider>,
    );
    const button = el.querySelector<HTMLButtonElement>(
      "button[data-hand-lower-self]",
    )!;
    expect(button.getAttribute("data-hand-position")).toBe("2");
    act(() => button.click());
    expect(lowerSelf).toHaveBeenCalledTimes(1);
  });

  it("offers none of it without sticky hands", () => {
    const el = mount(<RaisedHandQueue participants={room} selfUserId="me" />);
    expect(el.querySelector("button")).toBeNull();
  });

  it("renumbers when somebody lowers: the rest keep their order", () => {
    const el = mount(<RaisedHandQueue participants={room} selfUserId="me" />);
    const numbers = (node: HTMLElement) =>
      [...node.querySelectorAll("[data-hand-queue-entry]")].map(
        (n) => `${n.textContent}`,
      );
    expect(numbers(el)).toEqual(["1alice", "2me", "3bob"]);
    act(() =>
      root!.render(
        <TooltipProvider>
          <RaisedHandQueue
            participants={[person("alice", 100), person("me", 200), person("bob", null)]}
            selfUserId="me"
          />
        </TooltipProvider>,
      ),
    );
    expect(numbers(el)).toEqual(["1alice", "2me"]);
    act(() =>
      root!.render(
        <TooltipProvider>
          <RaisedHandQueue
            participants={[person("alice", null), person("me", 200), person("bob", 300)]}
            selfUserId="me"
          />
        </TooltipProvider>,
      ),
    );
    // alice lowered: the number everybody else carries moves up by one.
    expect(numbers(el)).toEqual(["1me", "2bob"]);
  });
});
