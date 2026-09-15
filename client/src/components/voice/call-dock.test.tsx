// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CallDockOutlet,
  CallDockPortal,
  CallDockProvider,
  useCallDockPublisher,
} from "./call-dock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** The stage's end: publishes `label` for `channelId` while mounted. */
function Stage({ channelId, label }: { channelId: string; label: string }) {
  const publish = useCallDockPublisher();
  if (!publish) {
    return <div data-inline>{label}</div>;
  }
  return (
    <CallDockPortal channelId={channelId} publish={publish}>
      <div data-bar>{label}</div>
    </CallDockPortal>
  );
}

function Screen({
  viewing,
  call,
  onOccupiedChange,
}: {
  /** The channel whose composer is on screen. */
  viewing: string;
  /** The collapsed call, if there is one: which room, and what it says. */
  call: { channelId: string; label: string } | null;
  onOccupiedChange?: (occupied: boolean) => void;
}) {
  return (
    <CallDockProvider onOccupiedChange={onOccupiedChange}>
      <div data-stage-slot>
        {call && <Stage channelId={call.channelId} label={call.label} />}
      </div>
      <div data-composer>
        <CallDockOutlet channelId={viewing} />
      </div>
    </CallDockProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const dock = () => container.querySelector<HTMLElement>("[data-call-dock]");
const composerText = () =>
  container.querySelector("[data-composer]")?.textContent ?? "";
const stageSlotText = () =>
  container.querySelector("[data-stage-slot]")?.textContent ?? "";

const render = (props: Parameters<typeof Screen>[0]) =>
  act(() => root.render(<Screen {...props} />));

const LOBBY = { channelId: "lobby", label: "Dev User" };

describe("CallDockOutlet", () => {
  it("draws the bar in the composer and nothing where the stage stands", () => {
    render({ viewing: "lobby", call: LOBBY });
    expect(composerText()).toBe("Dev User");
    expect(stageSlotText()).toBe("");
  });

  it("opens on the frame after it mounts, so the first appearance is a transition", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    render({ viewing: "lobby", call: LOBBY });
    expect(dock()?.dataset.state).toBe("closed");
    act(() => frames.forEach((cb) => cb(0)));
    expect(dock()?.dataset.state).toBe("open");
  });

  it("follows the bar as it re-renders", () => {
    render({ viewing: "lobby", call: LOBBY });
    render({ viewing: "lobby", call: { ...LOBBY, label: "Dev User, Bob" } });
    expect(composerText()).toBe("Dev User, Bob");
  });

  it("only draws the call of the channel its composer belongs to", () => {
    render({ viewing: "general", call: LOBBY });
    expect(dock()).toBeNull();
    expect(composerText()).toBe("");
  });

  it("keeps the last bar while it folds away, then lets go", () => {
    vi.useFakeTimers();
    render({ viewing: "lobby", call: LOBBY });
    render({ viewing: "lobby", call: null });
    // Still there for the exit animation, closed and out of the tree for
    // assistive tech.
    expect(composerText()).toBe("Dev User");
    expect(dock()?.dataset.state).toBe("closed");
    expect(dock()?.getAttribute("aria-hidden")).toBe("true");

    // The row's transition ends and the bar is gone.
    act(() => {
      const el = dock()!;
      const event = new Event("transitionend", { bubbles: true });
      Object.defineProperty(event, "propertyName", {
        value: "grid-template-rows",
      });
      el.dispatchEvent(event);
    });
    expect(dock()).toBeNull();
  });

  it("lets go on a timer when no transitionend ever comes", () => {
    vi.useFakeTimers();
    render({ viewing: "lobby", call: LOBBY });
    render({ viewing: "lobby", call: null });
    expect(dock()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(dock()).toBeNull();
  });

  it("tells the provider when a bar is docked, for the sidebar's sake", () => {
    const occupied = vi.fn();
    render({ viewing: "lobby", call: null, onOccupiedChange: occupied });
    expect(occupied).toHaveBeenLastCalledWith(false);
    render({ viewing: "lobby", call: LOBBY, onOccupiedChange: occupied });
    expect(occupied).toHaveBeenLastCalledWith(true);
    render({ viewing: "lobby", call: null, onOccupiedChange: occupied });
    expect(occupied).toHaveBeenLastCalledWith(false);
  });
});

describe("CallDockPortal without a provider", () => {
  it("leaves the stage to draw its own bar", () => {
    act(() => root.render(<Stage channelId="lobby" label="Dev User" />));
    expect(container.querySelector("[data-inline]")?.textContent).toBe(
      "Dev User",
    );
  });
});
