import { describe, expect, it, vi } from "vitest";
import {
  cameraTileMoreItems,
  shareTileMoreItems,
  stageMoreItems,
  watchPlayerMoreItems,
} from "@/components/voice/call-menu-items";
import type { VideoFitControls } from "@/hooks/use-video-fit";

/**
 * What each "⋯" and "Mais" offers, read straight from the builders: a Radix
 * menu never renders its rows in static markup, so a test that only looks
 * for the button would still pass with an empty menu behind it.
 */
const t = (key: string, vars?: Record<string, unknown>) =>
  vars?.name ? `${key}:${String(vars.name)}` : key;

function fit(value: "cover" | "contain"): VideoFitControls {
  return { fit: value, toggle: vi.fn() };
}

const ids = (items: { id: string; separator?: boolean }[]) =>
  items.filter((item) => !item.separator).map((item) => item.id);

describe("the stage bar's Mais", () => {
  const base = {
    joinLeaveAutoMute: { on: true, onToggle: () => {} },
  };

  it("offers watch party, the cursor, the sounds, fullscreen and collapse", () => {
    const items = stageMoreItems(t, {
      ...base,
      watchParty: { disabledReason: null, onStart: () => {} },
      cursor: { hidden: false, liveChangeable: false, sharing: false, onToggle: () => {} },
      fullscreen: { active: false, onToggle: () => {} },
      collapse: { collapsed: false, onToggle: () => {} },
    });
    expect(ids(items)).toEqual([
      "watch-party",
      "share-cursor",
      "join-leave-sounds",
      "stage-fullscreen",
      "stage-collapse",
    ]);
    expect(items.find((item) => item.id === "stage-collapse")?.label).toBe(
      "call.stage.collapse",
    );
  });

  it("keeps watch party and the cursor listed while sharing, disabled with the reason", () => {
    const items = stageMoreItems(t, {
      ...base,
      watchParty: { disabledReason: "sharing", onStart: () => {} },
      cursor: { hidden: true, liveChangeable: false, sharing: true, onToggle: () => {} },
    });
    const watch = items.find((item) => item.id === "watch-party");
    const cursor = items.find((item) => item.id === "share-cursor");
    expect(watch?.disabled).toBe(true);
    expect(watch?.detail).toBe("voice.control.alreadySharing");
    expect(cursor?.disabled).toBe(true);
    expect(cursor?.detail).toBe("voice.control.cursorNextShare");
  });

  it("names the sounds rule and ticks it while it is on", () => {
    const on = stageMoreItems(t, base).find((item) => item.id === "join-leave-sounds");
    expect(on?.label).toBe("voice.control.disableJoinLeaveSounds");
    expect(on?.checked).toBe(true);
    const off = stageMoreItems(t, {
      joinLeaveAutoMute: { on: false, onToggle: () => {} },
    }).find((item) => item.id === "join-leave-sounds");
    expect(off?.checked).toBe(false);
  });
});

describe("a camera tile's ⋯", () => {
  it("offers fit as two choices, pin and hide", () => {
    const items = cameraTileMoreItems(t, {
      name: "bob",
      fit: fit("cover"),
      pin: { pinned: true, onToggle: () => {} },
      hide: { onHide: () => {} },
    });
    expect(ids(items)).toEqual(["fit-cover", "fit-contain", "pin", "hide-camera"]);
    expect(items.find((item) => item.id === "fit-cover")?.checked).toBe(true);
    expect(items.find((item) => item.id === "fit-contain")?.detail).toBe(
      "call.fit.hintCamera",
    );
    expect(items.find((item) => item.id === "pin")?.label).toBe("call.stage.unpin");
    expect(items.find((item) => item.id === "hide-camera")?.label).toBe(
      "call.camera.hide:bob",
    );
  });

  it("does not toggle fit when the picked choice is already set", () => {
    const controls = fit("contain");
    const items = cameraTileMoreItems(t, { name: "bob", fit: controls });
    items.find((item) => item.id === "fit-contain")?.onSelect?.();
    expect(controls.toggle).not.toHaveBeenCalled();
    items.find((item) => item.id === "fit-cover")?.onSelect?.();
    expect(controls.toggle).toHaveBeenCalledTimes(1);
  });
});

describe("a share tile's ⋯", () => {
  it("lets a viewer stop watching somebody's share", () => {
    const items = shareTileMoreItems(t, {
      name: "alice",
      isSelf: false,
      fit: fit("contain"),
      pin: { pinned: false, onToggle: () => {} },
      dismiss: { onDismiss: () => {} },
    });
    expect(ids(items)).toEqual(["fit-cover", "fit-contain", "pin", "dismiss"]);
    expect(items.find((item) => item.id === "fit-contain")?.detail).toBe(
      "call.fit.hintScreen",
    );
    expect(items.find((item) => item.id === "pin")?.label).toBe("call.stage.pin:alice");
  });

  it("never offers to stop watching your own share, and offers your preview instead", () => {
    const items = shareTileMoreItems(t, {
      name: "me",
      isSelf: true,
      selfPreview: { hidden: false, onToggle: () => {} },
      fit: fit("contain"),
      dismiss: { onDismiss: () => {} },
    });
    expect(ids(items)).toEqual(["self-preview", "fit-cover", "fit-contain"]);
  });
});

describe("the watch party player's ⋯", () => {
  it("offers fit with its scope and picture-in-picture", () => {
    const items = watchPlayerMoreItems(t, {
      fit: fit("cover"),
      pip: { active: true, onToggle: () => {} },
    });
    expect(ids(items)).toEqual(["fit-cover", "fit-contain", "pip"]);
    expect(items.find((item) => item.id === "fit-contain")?.detail).toBe(
      "voice.hls.fitHint",
    );
    expect(items.find((item) => item.id === "pip")?.checked).toBe(true);
  });

  it("is empty before the first frame", () => {
    expect(watchPlayerMoreItems(t, {})).toEqual([]);
  });
});
