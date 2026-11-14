import { describe, expect, it } from "vitest";
import {
  listenersOf,
  listenerStripSlots,
  planRoomCards,
  fitRoomCards,
  planRoomStage,
  roomStripFit,
  ROOM_STRIP_MAX_PX,
  ROOM_STRIP_MIN_PX,
  planStage,
  ROOM_CARD_LIMIT,
  roomCardColumns,
  screensDrawnOnStage,
  stageGridColumns,
  tileClickFullscreens,
  stageTileSlots,
  STAGE_TILE_LIMIT_NARROW,
  STAGE_TILE_LIMIT_WIDE,
  STRIP_LIMIT_NARROW,
  STRIP_LIMIT_WIDE,
  type StageTile,
} from "./stage-layout";

/**
 * The layout rules the 5 Sep 2026 watch party broke, pinned.
 *
 * Every case below is somebody's actual room: a streamer with a camera and a
 * share, a 1:1 video call, a lobby where nobody has a camera, and 200 people
 * listening while one of them talks.
 */

function person(
  key: string,
  overrides: { stream?: unknown; isSelf?: boolean } = {},
) {
  return {
    key,
    stream: overrides.stream ?? null,
    isSelf: overrides.isSelf ?? false,
  };
}

describe("planStage", () => {
  it("puts a share and a webcam on the stage together, share first", () => {
    const plan = planStage({
      screens: [{ peerId: "streamer", isSelf: false }],
      people: [person("me", { isSelf: true }), person("streamer", { stream: {} })],
    });
    expect(plan.tiles.map((tile) => tile.id)).toEqual([
      "streamer",
      "camera:streamer",
    ]);
    expect(plan.tiles.map((tile) => tile.kind)).toEqual(["screen", "camera"]);
  });

  it("leaves the listeners off the stage entirely", () => {
    const plan = planStage({
      screens: [{ peerId: "streamer", isSelf: false }],
      people: [
        person("me", { isSelf: true }),
        person("streamer"),
        person("ana"),
        person("bia"),
      ],
    });
    expect(plan.tiles).toHaveLength(1);
    expect(plan.tiles[0]!.id).toBe("streamer");
  });

  it("our own camera is a corner preview when there is exactly one other picture", () => {
    const plan = planStage({
      screens: [],
      people: [
        person("me", { stream: {}, isSelf: true }),
        person("ana", { stream: {} }),
      ],
    });
    expect(plan.selfPreview).toBe(true);
    expect(plan.tiles.map((tile) => tile.id)).toEqual(["camera:ana"]);
  });

  it("our own camera joins the grid once there are two other pictures", () => {
    const plan = planStage({
      screens: [{ peerId: "ana", isSelf: false }],
      people: [
        person("me", { stream: {}, isSelf: true }),
        person("ana", { stream: {} }),
      ],
    });
    expect(plan.selfPreview).toBe(false);
    expect(plan.tiles.map((tile) => tile.id)).toEqual([
      "ana",
      "camera:ana",
      "camera:me",
    ]);
  });

  it("our own camera owns the stage when nobody else is publishing", () => {
    const plan = planStage({
      screens: [],
      people: [person("me", { stream: {}, isSelf: true }), person("ana")],
    });
    expect(plan.selfPreview).toBe(false);
    expect(plan.tiles.map((tile) => tile.id)).toEqual(["camera:me"]);
  });

  it("our own share is a tile like anyone else's", () => {
    const plan = planStage({
      screens: [{ peerId: "my-peer", isSelf: true }],
      people: [person("me", { isSelf: true })],
    });
    expect(plan.tiles.map((tile) => tile.id)).toEqual(["my-peer"]);
    expect(plan.tiles[0]!.isSelf).toBe(true);
  });

  it("a pin moves that tile first and features it", () => {
    const plan = planStage({
      screens: [{ peerId: "ana", isSelf: false }],
      people: [person("me", { isSelf: true }), person("bia", { stream: {} })],
      pinnedTileId: "camera:bia",
    });
    expect(plan.tiles.map((tile) => tile.id)).toEqual(["camera:bia", "ana"]);
    expect(plan.featured).toBe(true);
  });

  it("gives the one screen in a crowded room the whole first row", () => {
    const plan = planStage({
      screens: [{ peerId: "streamer", isSelf: false }],
      people: [
        person("me", { isSelf: true }),
        person("streamer", { stream: {} }),
        person("ana", { stream: {} }),
        person("bia", { stream: {} }),
      ],
    });
    expect(plan.tiles).toHaveLength(4);
    expect(plan.tiles[0]!.kind).toBe("screen");
    expect(plan.featured).toBe(true);
  });

  it("does not feature a screen while there is still room for it", () => {
    const plan = planStage({
      screens: [{ peerId: "streamer", isSelf: false }],
      people: [
        person("me", { isSelf: true }),
        person("streamer", { stream: {} }),
      ],
    });
    expect(plan.featured).toBe(false);
  });

  it("two presenters are a comparison, so neither is featured", () => {
    const plan = planStage({
      screens: [
        { peerId: "ana", isSelf: false },
        { peerId: "bia", isSelf: false },
      ],
      people: [
        person("me", { isSelf: true }),
        person("ana", { stream: {} }),
        person("bia", { stream: {} }),
      ],
    });
    expect(plan.tiles).toHaveLength(4);
    expect(plan.featured).toBe(false);
  });

  it("a pin on the only tile features nothing — it is already the stage", () => {
    const plan = planStage({
      screens: [{ peerId: "ana", isSelf: false }],
      people: [person("me", { isSelf: true })],
      pinnedTileId: "ana",
    });
    expect(plan.featured).toBe(false);
  });

  it("a pin on somebody who stopped publishing is ignored, not honoured", () => {
    const plan = planStage({
      screens: [{ peerId: "ana", isSelf: false }],
      people: [person("me", { isSelf: true })],
      pinnedTileId: "camera:gone",
    });
    expect(plan.tiles.map((tile) => tile.id)).toEqual(["ana"]);
    expect(plan.featured).toBe(false);
  });

  it("has no tiles at all when the room is voice only", () => {
    const plan = planStage({
      screens: [],
      people: [person("me", { isSelf: true }), person("ana")],
    });
    expect(plan.tiles).toEqual([]);
    expect(plan.selfPreview).toBe(false);
  });
});

describe("listenersOf", () => {
  it("keeps the people with nothing to show", () => {
    const people = [
      person("me", { isSelf: true }),
      person("ana", { stream: {} }),
      person("bia"),
    ];
    expect(
      listenersOf(people, [{ peerId: "ana", isSelf: false }], "my-peer").map(
        (p) => p.key,
      ),
    ).toEqual(["me", "bia"]);
  });

  it("does not repeat a presenter whose camera is off", () => {
    const people = [person("me", { isSelf: true }), person("bia")];
    expect(
      listenersOf(people, [{ peerId: "bia", isSelf: false }], "my-peer").map(
        (p) => p.key,
      ),
    ).toEqual(["me"]);
  });

  it("does not repeat us while we are the one presenting", () => {
    const people = [person("me", { isSelf: true }), person("bia")];
    expect(
      listenersOf(people, [{ peerId: "my-peer", isSelf: true }], "my-peer").map(
        (p) => p.key,
      ),
    ).toEqual(["bia"]);
  });
});

describe("stageGridColumns", () => {
  it("gives one publisher the whole stage", () => {
    expect(stageGridColumns(1, true)).toBe(1);
    expect(stageGridColumns(1, false)).toBe(1);
  });

  it("pairs two on a wide window and stacks them on a phone", () => {
    expect(stageGridColumns(2, true)).toBe(2);
    expect(stageGridColumns(2, false)).toBe(1);
  });

  it("grows one step behind the square, so tiles stay wide", () => {
    expect(stageGridColumns(3, true)).toBe(2);
    expect(stageGridColumns(4, true)).toBe(2);
    expect(stageGridColumns(6, true)).toBe(3);
    expect(stageGridColumns(9, true)).toBe(3);
    expect(stageGridColumns(12, true)).toBe(4);
  });

  it("never asks a phone for more than three columns", () => {
    expect(stageGridColumns(4, false)).toBe(2);
    expect(stageGridColumns(6, false)).toBe(2);
    expect(stageGridColumns(12, false)).toBe(3);
  });
});

describe("tileClickFullscreens", () => {
  it("leaves the single-tile stage's tap to the control chrome", () => {
    expect(tileClickFullscreens(1)).toBe(false);
  });

  it("answers a click on one of several tiles", () => {
    expect(tileClickFullscreens(2)).toBe(true);
    expect(tileClickFullscreens(9)).toBe(true);
  });
});

describe("listenerStripSlots", () => {
  const listener = (key: string, speaking = false, isSelf = false) => ({
    key,
    speaking,
    isSelf,
  });

  it("shows everybody in a small room", () => {
    const people = [listener("me", false, true), listener("ana")];
    const slots = listenerStripSlots(people, STRIP_LIMIT_WIDE);
    expect(slots.shown).toHaveLength(2);
    expect(slots.overflow).toBe(0);
  });

  it("spends the last slot on the person rather than on a +1 chip", () => {
    const people = Array.from({ length: STRIP_LIMIT_NARROW + 1 }, (_, i) =>
      listener(`p${i}`),
    );
    const slots = listenerStripSlots(people, STRIP_LIMIT_NARROW);
    expect(slots.shown).toHaveLength(STRIP_LIMIT_NARROW + 1);
    expect(slots.overflow).toBe(0);
  });

  it("a phone shows fewer faces than a laptop, and says so in the count", () => {
    const people = Array.from({ length: 20 }, (_, i) => listener(`p${i}`));
    expect(listenerStripSlots(people, STRIP_LIMIT_NARROW).shown).toHaveLength(
      STRIP_LIMIT_NARROW,
    );
    expect(listenerStripSlots(people, STRIP_LIMIT_WIDE).shown).toHaveLength(
      STRIP_LIMIT_WIDE,
    );
    expect(STRIP_LIMIT_NARROW).toBeLessThan(STRIP_LIMIT_WIDE);
  });

  it("counts the rest behind one chip", () => {
    const people = Array.from({ length: 200 }, (_, i) => listener(`p${i}`));
    const slots = listenerStripSlots(people, STRIP_LIMIT_WIDE);
    expect(slots.shown).toHaveLength(STRIP_LIMIT_WIDE);
    expect(slots.overflow).toBe(188);
  });

  it("always keeps us, wherever the roster put us", () => {
    const people = [
      ...Array.from({ length: 50 }, (_, i) => listener(`p${i}`)),
      listener("me", false, true),
    ];
    const slots = listenerStripSlots(people, STRIP_LIMIT_NARROW);
    expect(slots.shown.some((p) => p.isSelf)).toBe(true);
    expect(slots.overflow).toBe(51 - STRIP_LIMIT_NARROW);
    expect(slots.shown).toHaveLength(STRIP_LIMIT_NARROW);
  });

  it("promotes whoever is speaking out of the overflow", () => {
    const people = [
      ...Array.from({ length: 50 }, (_, i) => listener(`p${i}`)),
      listener("late-talker", true),
    ];
    const slots = listenerStripSlots(people, STRIP_LIMIT_NARROW);
    expect(slots.shown.map((p) => p.key)).toContain("late-talker");
  });

  it("draws the chosen people in roster order, so nobody jumps sideways", () => {
    const people = [
      listener("a"),
      listener("b"),
      listener("c", true),
      listener("d"),
      listener("me", false, true),
    ];
    const slots = listenerStripSlots(people, 3);
    expect(slots.shown.map((p) => p.key)).toEqual(["a", "c", "me"]);
    expect(slots.overflow).toBe(2);
  });

  it("hides everybody behind the chip when there is no room at all", () => {
    const people = [listener("a"), listener("b")];
    expect(listenerStripSlots(people, 0)).toEqual({ shown: [], overflow: 2 });
  });
});

/**
 * THE BOUNDED GRID (2026-09-08).
 *
 * The stage drew every publisher, which was fine while the camera cap was
 * eight and is not fine now that a voice-server room has no cap at all. A
 * tile the grid does not draw is a `<video>` that never mounts, and
 * `remote-video-delivery.ts` stops the server forwarding that publication a
 * second later, so these cases are about bandwidth and decode as much as
 * about layout.
 */
function tile(
  id: string,
  overrides: {
    kind?: "screen" | "camera";
    key?: string;
    isSelf?: boolean;
  } = {},
) {
  return {
    id,
    kind: overrides.kind ?? ("camera" as const),
    key: overrides.key ?? id,
    isSelf: overrides.isSelf ?? false,
  };
}

const NOBODY: ReadonlySet<string> = new Set();

describe("stageTileSlots", () => {
  it("draws everything when the room fits, which is almost every call", () => {
    const tiles = [tile("a"), tile("b"), tile("c")];
    const slots = stageTileSlots(tiles, STAGE_TILE_LIMIT_WIDE, NOBODY);
    expect(slots.shown).toHaveLength(3);
    expect(slots.overflow).toHaveLength(0);
  });

  it("bounds a twenty-camera room at the device's limit", () => {
    const tiles = Array.from({ length: 20 }, (_, at) => tile(`p${at}`));
    const wide = stageTileSlots(tiles, STAGE_TILE_LIMIT_WIDE, NOBODY);
    const narrow = stageTileSlots(tiles, STAGE_TILE_LIMIT_NARROW, NOBODY);
    expect(wide.shown).toHaveLength(STAGE_TILE_LIMIT_WIDE);
    expect(wide.overflow).toHaveLength(20 - STAGE_TILE_LIMIT_WIDE);
    expect(narrow.shown).toHaveLength(STAGE_TILE_LIMIT_NARROW);
    expect(narrow.overflow).toHaveLength(20 - STAGE_TILE_LIMIT_NARROW);
  });

  it("never cuts a share to make room for a face", () => {
    const tiles = [
      tile("s1", { kind: "screen" }),
      tile("s2", { kind: "screen" }),
      ...Array.from({ length: 20 }, (_, at) => tile(`p${at}`)),
    ];
    const slots = stageTileSlots(tiles, STAGE_TILE_LIMIT_NARROW, NOBODY);
    expect(slots.shown.map((t) => t.id)).toContain("s1");
    expect(slots.shown.map((t) => t.id)).toContain("s2");
  });

  it("promotes whoever is speaking out of the overflow", () => {
    const tiles = [
      ...Array.from({ length: 20 }, (_, at) => tile(`p${at}`)),
      tile("late-talker"),
    ];
    const slots = stageTileSlots(
      tiles,
      STAGE_TILE_LIMIT_WIDE,
      new Set(["late-talker"]),
    );
    expect(slots.shown.map((t) => t.id)).toContain("late-talker");
    expect(slots.overflow.map((t) => t.id)).not.toContain("late-talker");
  });

  it("keeps our own picture whatever the room size", () => {
    const tiles = [
      ...Array.from({ length: 20 }, (_, at) => tile(`p${at}`)),
      tile("me", { key: "self", isSelf: true }),
    ];
    const slots = stageTileSlots(tiles, STAGE_TILE_LIMIT_NARROW, NOBODY);
    expect(slots.shown.map((t) => t.id)).toContain("me");
  });

  it("keeps the first tile, which is the pin when there is one", () => {
    const tiles = [
      tile("pinned"),
      ...Array.from({ length: 20 }, (_, at) => tile(`p${at}`)),
    ];
    const slots = stageTileSlots(tiles, STAGE_TILE_LIMIT_NARROW, NOBODY);
    expect(slots.shown[0]?.id).toBe("pinned");
  });

  it("draws the chosen tiles in stage order, so nothing jumps sideways", () => {
    const tiles = [tile("a"), tile("b"), tile("c"), tile("d"), tile("e")];
    const slots = stageTileSlots(tiles, 3, new Set(["e"]));
    // "e" earns a slot by speaking, and is still drawn last.
    expect(slots.shown.map((t) => t.id)).toEqual(["a", "b", "e"]);
  });

  it("gives the last slot to the one extra person rather than to a +1", () => {
    const tiles = Array.from({ length: 13 }, (_, at) => tile(`p${at}`));
    const slots = stageTileSlots(tiles, STAGE_TILE_LIMIT_WIDE, NOBODY);
    expect(slots.shown).toHaveLength(13);
    expect(slots.overflow).toHaveLength(0);
  });
});

describe("planStage under a bound", () => {
  const twentyCameras = Array.from({ length: 20 }, (_, at) =>
    person(`p${at}`, { stream: {} }),
  );

  it("hands the cameras it cannot draw to the strip as chips", () => {
    const plan = planStage({
      screens: [],
      people: twentyCameras,
      tileLimit: STAGE_TILE_LIMIT_WIDE,
    });
    expect(plan.tiles).toHaveLength(STAGE_TILE_LIMIT_WIDE);
    expect(plan.overflowKeys).toHaveLength(20 - STAGE_TILE_LIMIT_WIDE);

    // A publisher the grid could not fit is still a face with a name, rather
    // than a person who is in the call and appears nowhere on the screen.
    const listeners = listenersOf(
      twentyCameras,
      [],
      null,
      new Set(plan.overflowKeys),
    );
    expect(listeners.map((p) => p.key)).toEqual(plan.overflowKeys);
  });

  it("is unbounded when no limit is given, which is what a small call wants", () => {
    const plan = planStage({ screens: [], people: twentyCameras });
    expect(plan.tiles).toHaveLength(20);
    expect(plan.overflowKeys).toEqual([]);
  });

  it("keeps a camera on the stage when it is not in the overflow", () => {
    const plan = planStage({
      screens: [],
      people: twentyCameras,
      tileLimit: STAGE_TILE_LIMIT_WIDE,
    });
    const shownKeys = new Set(plan.tiles.map((t) => t.key));
    const listeners = listenersOf(
      twentyCameras,
      [],
      null,
      new Set(plan.overflowKeys),
    );
    for (const listener of listeners) {
      expect(shownKeys.has(listener.key)).toBe(false);
    }
  });
});

/**
 * A ROOM MADE ENTIRELY OF SHARES (2026-09-08).
 *
 * "Every share is kept" was written when `SCREEN_SHARE_LIMIT.livekit` was 4,
 * so the rule could never take more than a third of a wide grid. With the
 * count gone the same rule would hand twelve shares every slot, and a grid
 * with no faces in it, not even your own, is not a call.
 */
describe("stageTileSlots with more shares than the grid can draw", () => {
  const speaking = new Set<string>();

  function screen(at: number): StageTile {
    return {
      id: `screen-${at}`,
      key: `p${at}`,
      kind: "screen",
    } as unknown as StageTile;
  }

  function face(at: number, isSelf = false): StageTile {
    return {
      id: `face-${at}`,
      key: `f${at}`,
      kind: "person",
      isSelf,
    } as unknown as StageTile;
  }

  it("holds two slots back for our own picture and whoever is talking", () => {
    const tiles = [
      ...Array.from({ length: 12 }, (_, at) => screen(at)),
      face(0, true),
      face(1),
      face(2),
    ];
    const talking = new Set(["f1"]);

    const { shown } = stageTileSlots(tiles, 12, talking);

    expect(shown).toHaveLength(12);
    expect(shown.filter((tile) => tile.kind === "screen")).toHaveLength(10);
    expect(shown.some((tile) => tile.isSelf)).toBe(true);
    expect(shown.some((tile) => tile.key === "f1")).toBe(true);
  });

  it("gives a call that is nothing but screens all of its screens", () => {
    const tiles = Array.from({ length: 20 }, (_, at) => screen(at));

    const { shown } = stageTileSlots(tiles, 12, speaking);

    expect(shown).toHaveLength(12);
    expect(shown.every((tile) => tile.kind === "screen")).toBe(true);
  });

  it("leaves a room with a handful of shares exactly as it was", () => {
    // The bound only bites past `limit - STAGE_FACE_SLOTS_HELD`, so the four
    // that used to be the cap are all still kept.
    const tiles = [
      screen(0),
      screen(1),
      screen(2),
      screen(3),
      ...Array.from({ length: 12 }, (_, at) => face(at)),
    ];

    const { shown } = stageTileSlots(tiles, 12, speaking);

    expect(shown.filter((tile) => tile.kind === "screen")).toHaveLength(4);
  });
});

describe("screensDrawnOnStage", () => {
  const screens = [
    { peerId: "friend", isSelf: false },
    { peerId: "me", isSelf: true },
  ];

  it("keeps every share while the own preview is shown", () => {
    expect(screensDrawnOnStage(screens, false)).toEqual(screens);
  });

  it("drops only our own share once its preview is hidden, and the grid reflows", () => {
    const drawn = screensDrawnOnStage(screens, true);
    expect(drawn.map((s) => s.peerId)).toEqual(["friend"]);
    const plan = planStage({ screens: drawn, people: [] });
    expect(plan.tiles.map((tile) => tile.id)).toEqual(["friend"]);
    expect(stageGridColumns(plan.tiles.length, true)).toBe(1);
  });

  it("leaves nothing when ours is the only share", () => {
    expect(screensDrawnOnStage([screens[1]!], true)).toEqual([]);
  });
});

describe("the room's cards", () => {
  const person = (key: string, extra: Partial<{ isSelf: boolean; speaking: boolean; handPosition: number | null; camera: boolean }> = {}) => ({
    key,
    isSelf: false,
    speaking: false,
    handPosition: null,
    ...extra,
  });
  const room = (count: number) => [
    person("me", { isSelf: true }),
    ...Array.from({ length: count - 1 }, (_, at) => person(`p${at}`)),
  ];

  it("lays two side by side, four in a square, nine in three rows, sixteen in four", () => {
    expect(roomCardColumns(1)).toBe(1);
    expect(roomCardColumns(2)).toBe(2);
    expect(roomCardColumns(4)).toBe(2);
    expect(roomCardColumns(5)).toBe(3);
    expect(roomCardColumns(9)).toBe(3);
    expect(roomCardColumns(10)).toBe(4);
    expect(roomCardColumns(16)).toBe(4);
  });

  it("beside the chat, stacks landscape cards instead of drawing tall portraits", () => {
    // The stage column next to the chat: narrow and the window's full height.
    const fit = fitRoomCards(2, { width: 480, height: 1100 }, 12);
    expect(fit.columns).toBe(1);
    expect(fit.width / fit.height).toBeCloseTo(16 / 9, 1);
  });

  it("on a wide stage, puts the same two in a row", () => {
    expect(fitRoomCards(2, { width: 1400, height: 500 }, 12).columns).toBe(2);
  });

  it("never lets a card outgrow its cell", () => {
    for (const cells of [1, 3, 7, 16]) {
      const box = { width: 900, height: 600 };
      const fit = fitRoomCards(cells, box, 12);
      const rows = Math.ceil(cells / fit.columns);
      expect(fit.width * fit.columns + 12 * (fit.columns - 1)).toBeLessThanOrEqual(box.width);
      expect(fit.height * rows + 12 * (rows - 1)).toBeLessThanOrEqual(box.height);
    }
  });

  it("before the pane is measured, falls back to the fixed columns", () => {
    expect(fitRoomCards(5, { width: 0, height: 0 }, 12).columns).toBe(roomCardColumns(5));
  });

  it("keeps a card for every camera before the rest of the roster", () => {
    const people = [
      person("me", { isSelf: true }),
      ...Array.from({ length: 20 }, (_, at) => person(`p${at}`)),
      person("cam", { camera: true }),
    ];
    const keys = planRoomCards(people, { aloneCard: true, limit: 4 }).shown.map(
      (shown) => shown.key,
    );
    expect(keys).toContain("cam");
  });

  it("puts cameras in their cards and leaves only shares on the stage", () => {
    const plan = planRoomStage([
      { kind: "screen", key: "peer-a" },
      { kind: "camera", key: "bob" },
      { kind: "camera", key: "me" },
    ]);
    expect(plan.screens.map((tile) => tile.key)).toEqual(["peer-a"]);
    expect([...plan.cameraKeys]).toEqual(["bob", "me"]);
  });

  it("sizes the row under a share from the stage, inside its bounds", () => {
    expect(roomStripFit({ width: 1000, height: 200 }, 8, 2).height).toBe(ROOM_STRIP_MIN_PX);
    expect(roomStripFit({ width: 4000, height: 2000 }, 8, 2).height).toBe(ROOM_STRIP_MAX_PX);
  });

  it("shrinks the row's cards before it hides anybody behind +N", () => {
    const box = { width: 900, height: 525 };
    const tall = roomStripFit(box, 12, 3);
    const six = roomStripFit(box, 12, 6);
    expect(six.perRow).toBeGreaterThanOrEqual(6);
    expect(six.height).toBeLessThan(tall.height);
    expect(six.perRow * six.width + (six.perRow - 1) * 12).toBeLessThanOrEqual(box.width);
  });

  it("past the shortest card, fits what it can and leaves the rest to +N", () => {
    const fit = roomStripFit({ width: 600, height: 500 }, 12, 30);
    expect(fit.height).toBe(ROOM_STRIP_MIN_PX);
    expect(fit.perRow).toBeLessThan(30);
  });

  it("alone, lays out our card beside the alone card", () => {
    const plan = planRoomCards(room(1), { aloneCard: true });
    expect(plan.shown.map((p) => p.key)).toEqual(["me"]);
    expect(plan.cells).toBe(2);
    expect(plan.columns).toBe(2);
    expect(planRoomCards(room(1), { aloneCard: false }).cells).toBe(1);
  });

  it("draws sixteen people whole, and never spends a card on +1", () => {
    const plan = planRoomCards(room(ROOM_CARD_LIMIT + 1), { aloneCard: true });
    expect(plan.shown).toHaveLength(16);
    expect(plan.overflow).toBe(0);
    expect(plan.columns).toBe(4);
  });

  it("past sixteen, keeps fifteen cards and counts the rest", () => {
    const plan = planRoomCards(room(40), { aloneCard: true });
    expect(plan.shown).toHaveLength(ROOM_CARD_LIMIT);
    expect(plan.overflow).toBe(25);
    expect(plan.cells).toBe(16);
  });

  it("keeps us, then whoever speaks, then raised hands, in roster order", () => {
    const people = [
      ...Array.from({ length: 30 }, (_, at) => person(`p${at}`)),
      person("talker", { speaking: true }),
      person("hand2", { handPosition: 2 }),
      person("hand1", { handPosition: 1 }),
      person("me", { isSelf: true }),
    ];
    const keys = planRoomCards(people, { aloneCard: true, limit: 4 }).shown.map(
      (p) => p.key,
    );
    expect(keys).toEqual(["talker", "hand2", "hand1", "me"]);
  });
});
