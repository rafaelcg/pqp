import { afterEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
  clear: () => {
    store.clear();
  },
});

const {
  CALL_SPLIT_DEFAULT,
  CALL_SPLIT_DIVIDER_PX,
  MIN_CHAT_HEIGHT_PX,
  MIN_CHAT_WIDTH_PX,
  MIN_STAGE_HEIGHT_PX,
  MIN_STAGE_WIDTH_PX,
  clampSplit,
  loadCallSplit,
  nudgeSplit,
  resolveCollapsed,
  resolveOrientation,
  saveCallSplit,
  splitAvailable,
  splitBounds,
  splitFraction,
  strongestStageShape,
} = await import("./call-split");

const STACKED = splitBounds("stacked");

describe("clampSplit", () => {
  it("gives the stage the stored fraction of the usable pane", () => {
    // 908 of pane, 8 of divider: 900 usable, 60% of it to the stage.
    expect(clampSplit({ fraction: 0.6, container: 908, ...STACKED })).toBe(540);
  });

  it("refuses to drag the stage below its minimum", () => {
    expect(clampSplit({ fraction: 0, container: 908, ...STACKED })).toBe(
      MIN_STAGE_HEIGHT_PX,
    );
    expect(clampSplit({ fraction: 0.01, container: 908, ...STACKED })).toBe(
      MIN_STAGE_HEIGHT_PX,
    );
  });

  it("refuses to drag the transcript below its minimum", () => {
    expect(clampSplit({ fraction: 1, container: 908, ...STACKED })).toBe(
      900 - MIN_CHAT_HEIGHT_PX,
    );
    // And that really does leave the transcript its minimum, divider included.
    expect(908 - (900 - MIN_CHAT_HEIGHT_PX) - CALL_SPLIT_DIVIDER_PX).toBe(
      MIN_CHAT_HEIGHT_PX,
    );
  });

  it("shares a pane too short for both minimums instead of starving one", () => {
    // A phone in landscape: 284px of pane, 380 asked for. Neither pane
    // vanishes, and neither gets its full minimum.
    const stage = clampSplit({ fraction: 0.9, container: 284, ...STACKED });
    expect(stage).toBeGreaterThan(0);
    expect(stage).toBeLessThan(MIN_STAGE_HEIGHT_PX);
    expect(284 - stage).toBeGreaterThan(0);
  });

  it("survives a container of zero, which is what an unmeasured pane reports", () => {
    expect(clampSplit({ fraction: 0.6, container: 0, ...STACKED })).toBe(0);
    expect(
      clampSplit({ fraction: 0.6, container: Number.NaN, ...STACKED }),
    ).toBe(0);
  });

  it("treats a corrupt fraction as the middle rather than throwing", () => {
    expect(
      clampSplit({ fraction: Number.NaN, container: 908, ...STACKED }),
    ).toBe(450);
  });

  it("uses the width minimums when the panes sit side by side", () => {
    const side = splitBounds("side-by-side");
    expect(side).toEqual({
      minStage: MIN_STAGE_WIDTH_PX,
      minChat: MIN_CHAT_WIDTH_PX,
    });
    expect(clampSplit({ fraction: 1, container: 1008, ...side })).toBe(
      1000 - MIN_CHAT_WIDTH_PX,
    );
  });
});

describe("splitAvailable", () => {
  it("is false where the pane cannot hold both minimums plus the divider", () => {
    const floor =
      MIN_STAGE_HEIGHT_PX + MIN_CHAT_HEIGHT_PX + CALL_SPLIT_DIVIDER_PX;
    expect(splitAvailable(floor - 1, "stacked")).toBe(false);
    expect(splitAvailable(floor, "stacked")).toBe(true);
    // A landscape phone, which is the case that must keep today's layout.
    expect(splitAvailable(284, "stacked")).toBe(false);
  });

  it("asks for more width than height, because two columns are the wider ask", () => {
    expect(splitAvailable(700, "stacked")).toBe(true);
    expect(splitAvailable(700, "side-by-side")).toBe(false);
    expect(
      splitAvailable(
        MIN_STAGE_WIDTH_PX + MIN_CHAT_WIDTH_PX + CALL_SPLIT_DIVIDER_PX,
        "side-by-side",
      ),
    ).toBe(true);
  });
});

describe("splitFraction", () => {
  it("round-trips a clamped pixel size", () => {
    const px = clampSplit({ fraction: 0.42, container: 908, ...STACKED });
    expect(splitFraction(px, 908)).toBeCloseTo(0.42, 2);
  });

  it("never leaves 0..1, whatever it is handed", () => {
    expect(splitFraction(5000, 908)).toBe(1);
    expect(splitFraction(-40, 908)).toBe(0);
    expect(splitFraction(100, 0)).toBe(0.5);
  });
});

describe("nudgeSplit", () => {
  it("moves by the pixels asked for", () => {
    const next = nudgeSplit({
      fraction: 0.5,
      container: 908,
      orientation: "stacked",
      deltaPx: 16,
    });
    expect(Math.round(next * 900)).toBe(466);
  });

  it("stops at the same ends the pointer stops at", () => {
    const top = nudgeSplit({
      fraction: 1,
      container: 908,
      orientation: "stacked",
      deltaPx: 400,
    });
    expect(Math.round(top * 900)).toBe(900 - MIN_CHAT_HEIGHT_PX);

    const bottom = nudgeSplit({
      fraction: 0,
      container: 908,
      orientation: "stacked",
      deltaPx: -400,
    });
    expect(Math.round(bottom * 900)).toBe(MIN_STAGE_HEIGHT_PX);
  });
});

describe("resolveOrientation", () => {
  it("keeps a stored side-by-side only while the pane is wide enough", () => {
    expect(resolveOrientation("side-by-side", 1200, "expanded")).toBe(
      "side-by-side",
    );
    expect(resolveOrientation("side-by-side", 500, "expanded")).toBe("stacked");
    expect(resolveOrientation("stacked", 1600, "expanded")).toBe("stacked");
  });

  /**
   * Reported from live use on 7 Sep 2026: side by side was chosen during a
   * share, the share ended, and the left column stayed: a quarter of the
   * window holding the call's control strip and nothing else, with the chat
   * squeezed into the rest. A column for a stage is only a column while there
   * is a stage.
   */
  it("refuses a column for a stage with nothing on it", () => {
    for (const shape of ["none", "compact", "fullscreen"] as const) {
      expect(resolveOrientation("side-by-side", 1600, shape)).toBe("stacked");
    }
  });

  /**
   * And the way back needs no click. Nothing here writes, so the stored
   * choice is untouched by the fallback and applies again the moment somebody
   * turns a camera on. Same treatment the narrow window already gets.
   */
  it("gives the column back as soon as somebody publishes again", () => {
    expect(resolveOrientation("side-by-side", 1600, "compact")).toBe("stacked");
    expect(resolveOrientation("side-by-side", 1600, "expanded")).toBe(
      "side-by-side",
    );
  });
});

describe("stored preference", () => {
  afterEach(() => store.clear());

  it("defaults to today's layout when nothing is stored", () => {
    expect(loadCallSplit()).toEqual(CALL_SPLIT_DEFAULT);
  });

  it("survives a reload", () => {
    saveCallSplit({
      orientation: "side-by-side",
      stacked: 0.4,
      side: 0.55,
      collapsed: "none",
    });
    expect(loadCallSplit()).toEqual({
      orientation: "side-by-side",
      stacked: 0.4,
      side: 0.55,
      collapsed: "none",
    });
  });

  it("keeps the two orientations' fractions apart", () => {
    saveCallSplit({
      orientation: "stacked",
      stacked: 0.3,
      side: 0.8,
      collapsed: "none",
    });
    const loaded = loadCallSplit();
    expect(loaded.stacked).toBe(0.3);
    expect(loaded.side).toBe(0.8);
  });

  it("ignores junk rather than rendering a broken split", () => {
    store.set("pqp:call-split", "not json");
    expect(loadCallSplit()).toEqual(CALL_SPLIT_DEFAULT);

    store.set(
      "pqp:call-split",
      JSON.stringify({ orientation: "diagonal", stacked: "big", side: 12 }),
    );
    expect(loadCallSplit()).toEqual({
      orientation: "stacked",
      stacked: CALL_SPLIT_DEFAULT.stacked,
      side: 1,
      collapsed: "none",
    });
  });
});

describe("collapsing a pane", () => {
  it("starts with neither pane put away", () => {
    expect(CALL_SPLIT_DEFAULT.collapsed).toBe("none");
  });

  it("survives a reload, and is shared by both orientations", () => {
    // "Put the chat away" is a wish about what somebody wants to look at, not
    // about whether the panes are stacked. Rotating the layout must not read
    // as the app forgetting.
    saveCallSplit({
      orientation: "stacked",
      stacked: 0.5,
      side: 0.6,
      collapsed: "chat",
    });
    const loaded = loadCallSplit();
    expect(loaded.collapsed).toBe("chat");
    // And the orientation the pane happens to draw does not change the answer.
    expect(resolveCollapsed(loaded.collapsed, "expanded")).toBe("chat");
  });

  it("reads a preference written before this existed as neither", () => {
    // The shape every account already has in localStorage today. Failing
    // towards "both panes visible" is the only safe direction: the opposite
    // is somebody staring at a layout with no way back that they never asked
    // for.
    store.set(
      "pqp:call-split",
      JSON.stringify({ orientation: "side-by-side", stacked: 0.4, side: 0.7 }),
    );
    const loaded = loadCallSplit();
    expect(loaded.collapsed).toBe("none");
    // The rest of the older preference is still honoured.
    expect(loaded.orientation).toBe("side-by-side");
    expect(loaded.side).toBe(0.7);
  });

  it("reads an unknown value as neither, rather than hiding a pane", () => {
    store.set(
      "pqp:call-split",
      JSON.stringify({ orientation: "stacked", collapsed: "everything" }),
    );
    expect(loadCallSplit().collapsed).toBe("none");
  });

  it("is only honoured where there are two panes to arrange", () => {
    // Same rule as the orientation: stored is what they asked for, this is
    // what the pane can honour now. Putting the chat away to make room for a
    // slim call bar is not a thing anybody means.
    expect(resolveCollapsed("chat", "expanded")).toBe("chat");
    expect(resolveCollapsed("stage", "expanded")).toBe("stage");
    for (const shape of ["none", "compact", "fullscreen"] as const) {
      expect([shape, resolveCollapsed("chat", shape)]).toEqual([shape, "none"]);
    }
  });

  it("does not write, so the collapse comes back when a picture does", () => {
    // `resolveCollapsed` is pure. The stored value is untouched by a stage
    // that happens to be empty right now.
    saveCallSplit({ ...CALL_SPLIT_DEFAULT, collapsed: "chat" });
    expect(resolveCollapsed("chat", "none")).toBe("none");
    expect(loadCallSplit().collapsed).toBe("chat");
  });

  it("keeps honouring a collapsed stage while the stage still reports itself", () => {
    // THE LOOP THIS PINS. Hiding the pane rather than unmounting it is what
    // keeps `shape` at "expanded" while the stage is put away. Unmount it and
    // the shape falls to "none", this returns "none", and the stage comes
    // straight back: a click that undoes itself. The component test asserts
    // the hiding; this asserts why it matters.
    expect(resolveCollapsed("stage", "expanded")).toBe("stage");
    expect(resolveCollapsed("stage", "none")).toBe("none");

describe("strongestStageShape", () => {
  it("is none when nobody is claiming anything", () => {
    expect(strongestStageShape([])).toBe("none");
    expect(strongestStageShape([undefined, "none"])).toBe("none");
  });

  it("takes the strongest claim, not the latest", () => {
    // The bug: a watch party channel mounts the party panel, the watch stage
    // and the call stage together. The one that unmounts reports "none" about
    // ITSELF, and under last-write-wins that flattened the pane while another
    // was still showing a picture.
    expect(strongestStageShape(["expanded", "none"])).toBe("expanded");
    expect(strongestStageShape(["none", "expanded"])).toBe("expanded");
    expect(strongestStageShape(["none", "compact", "expanded"])).toBe(
      "expanded",
    );
  });

  it("lets fullscreen beat everything, because it has taken the window", () => {
    expect(strongestStageShape(["expanded", "fullscreen", "none"])).toBe(
      "fullscreen",
    );
  });

  it("keeps compact above none, so a slim bar still reports itself", () => {
    expect(strongestStageShape(["none", "compact"])).toBe("compact");
  });
});
