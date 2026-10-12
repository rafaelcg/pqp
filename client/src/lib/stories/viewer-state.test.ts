import { describe, expect, it } from "vitest";
import {
  STORY_CALL_DISPLAY_MS,
  STORY_PHOTO_DISPLAY_MS,
  storyTextDisplayMs,
} from "@pqp/shared";
import {
  createViewerState,
  currentStoryId,
  idsToPreload,
  isPaused,
  progressFraction,
  storyDisplayMs,
  viewerReducer,
  type ViewerAction,
  type ViewerState,
} from "./viewer-state";

const people = [
  { authorId: "bia", storyIds: ["b1", "b2"] },
  { authorId: "caio", storyIds: ["c1"] },
  { authorId: "fe", storyIds: ["f1", "f2", "f3"] },
];

function run(state: ViewerState, ...actions: ViewerAction[]): ViewerState {
  return actions.reduce(viewerReducer, state);
}

describe("createViewerState", () => {
  it("starts on the person asked for, first story, nothing elapsed", () => {
    const state = createViewerState(people, { personIndex: 2 });
    expect(currentStoryId(state)).toBe("f1");
    expect(state.elapsedMs).toBe(0);
    expect(state.durationMs).toBeNull();
    expect(state.closed).toBeNull();
  });

  it("drops people with no stories and closes when nobody is left", () => {
    expect(createViewerState([{ authorId: "x", storyIds: [] }]).closed).toBe("empty");
    const state = createViewerState([{ authorId: "x", storyIds: [] }, ...people]);
    expect(state.people.map((person) => person.authorId)).toEqual(["bia", "caio", "fe"]);
  });

  it("clamps a start index past the end", () => {
    expect(currentStoryId(createViewerState(people, { personIndex: 9 }))).toBe("f1");
  });
});

describe("the clock", () => {
  it("does not advance until the story has a length", () => {
    const state = run(createViewerState(people), { type: "tick", deltaMs: 4_000 });
    expect(state.elapsedMs).toBe(0);
  });

  it("advances linearly and moves on when the story is over", () => {
    let state = run(createViewerState(people), { type: "duration", durationMs: 5_000 });
    state = run(state, { type: "tick", deltaMs: 2_500 });
    expect(progressFraction(state)).toBeCloseTo(0.5);
    state = run(state, { type: "tick", deltaMs: 2_600 });
    expect(currentStoryId(state)).toBe("b2");
    expect(state.elapsedMs).toBe(0);
    expect(state.durationMs).toBeNull();
    expect(state.lastMove).toBe("none");
  });

  it("walks from the last story of one person into the next person", () => {
    let state = createViewerState(people, { storyIndex: 1 });
    state = run(state, { type: "duration", durationMs: 1_000 }, { type: "tick", deltaMs: 1_000 });
    expect(currentStoryId(state)).toBe("c1");
    expect(state.lastMove).toBe("forward");
  });

  it("closes at the end of the walk", () => {
    let state = createViewerState(people, { personIndex: 2, storyIndex: 2 });
    state = run(state, { type: "duration", durationMs: 1_000 }, { type: "tick", deltaMs: 5_000 });
    expect(state.closed).toBe("end");
  });

  it("a video sets its own position and is not ticked past it", () => {
    let state = run(createViewerState(people), { type: "duration", durationMs: 12_000 });
    state = run(state, { type: "progress", elapsedMs: 6_000 });
    expect(progressFraction(state)).toBeCloseTo(0.5);
  });
});

describe("pauses", () => {
  it("hold pauses the clock and letting go resumes it", () => {
    let state = run(
      createViewerState(people),
      { type: "duration", durationMs: 5_000 },
      { type: "pause", reason: "hold" },
      { type: "tick", deltaMs: 3_000 },
    );
    expect(isPaused(state)).toBe(true);
    expect(state.elapsedMs).toBe(0);
    state = run(state, { type: "resume", reason: "hold" }, { type: "tick", deltaMs: 1_000 });
    expect(state.elapsedMs).toBe(1_000);
  });

  it("reasons are independent: letting go of the card does not resume a reply", () => {
    const state = run(
      createViewerState(people),
      { type: "duration", durationMs: 5_000 },
      { type: "pause", reason: "reply" },
      { type: "pause", reason: "hold" },
      { type: "resume", reason: "hold" },
      { type: "tick", deltaMs: 1_000 },
    );
    expect(isPaused(state)).toBe(true);
    expect(state.elapsedMs).toBe(0);
  });

  it("pausing twice for one reason needs one resume", () => {
    const state = run(
      createViewerState(people),
      { type: "pause", reason: "key" },
      { type: "pause", reason: "key" },
      { type: "resume", reason: "key" },
    );
    expect(isPaused(state)).toBe(false);
  });
});

describe("navigation", () => {
  it("next and prev move by story inside a person", () => {
    let state = run(createViewerState(people), { type: "next" });
    expect(currentStoryId(state)).toBe("b2");
    state = run(state, { type: "prev" });
    expect(currentStoryId(state)).toBe("b1");
    expect(state.lastMove).toBe("none");
  });

  it("prev at a person's first story goes back a person", () => {
    const state = run(createViewerState(people, { personIndex: 1 }), { type: "prev" });
    expect(currentStoryId(state)).toBe("b1");
    expect(state.lastMove).toBe("back");
  });

  it("prev at the very first story restarts it", () => {
    let state = run(
      createViewerState(people),
      { type: "duration", durationMs: 5_000 },
      { type: "tick", deltaMs: 2_000 },
      { type: "prev" },
    );
    expect(currentStoryId(state)).toBe("b1");
    expect(state.elapsedMs).toBe(0);
    state = run(state, { type: "prevPerson" });
    expect(currentStoryId(state)).toBe("b1");
  });

  it("Shift+arrow moves by person, starting each at its first story", () => {
    let state = run(createViewerState(people, { storyIndex: 1 }), { type: "nextPerson" });
    expect(currentStoryId(state)).toBe("c1");
    state = run(state, { type: "nextPerson" });
    expect(currentStoryId(state)).toBe("f1");
    expect(state.lastMove).toBe("forward");
    state = run(state, { type: "nextPerson" });
    expect(state.closed).toBe("end");
  });

  it("clicking a neighbour jumps to that person", () => {
    const state = run(createViewerState(people), { type: "goPerson", index: 2 });
    expect(currentStoryId(state)).toBe("f1");
    expect(state.lastMove).toBe("forward");
    expect(run(state, { type: "goPerson", index: 7 })).toBe(state);
  });

  it("every change of story bumps the generation", () => {
    const start = createViewerState(people);
    expect(run(start, { type: "next" }).generation).toBe(start.generation + 1);
  });

  it("close is user-initiated and final", () => {
    const state = run(createViewerState(people), { type: "close" }, { type: "next" });
    expect(state.closed).toBe("user");
    expect(currentStoryId(state)).toBe("b1");
  });
});

describe("remove (a story deleted, removed or expired under the viewer)", () => {
  it("the current story gives way to the one after it", () => {
    const state = run(createViewerState(people, { personIndex: 2, storyIndex: 1 }), {
      type: "remove",
      storyIds: ["f2"],
    });
    expect(currentStoryId(state)).toBe("f3");
    expect(state.people[2]!.storyIds).toEqual(["f1", "f3"]);
  });

  it("removing the last story of a person falls back to that person's previous one", () => {
    const state = run(createViewerState(people, { personIndex: 2, storyIndex: 2 }), {
      type: "remove",
      storyIds: ["f3"],
    });
    expect(currentStoryId(state)).toBe("f2");
  });

  it("a whole person removed: the next person takes the place", () => {
    const state = run(createViewerState(people, { personIndex: 1 }), {
      type: "remove",
      storyIds: ["c1"],
    });
    expect(currentStoryId(state)).toBe("f1");
    expect(state.people).toHaveLength(2);
  });

  it("the last person removed while watching them closes the viewer", () => {
    const state = run(createViewerState(people, { personIndex: 2 }), {
      type: "remove",
      storyIds: ["f1", "f2", "f3"],
    });
    expect(state.closed).toBe("end");
  });

  it("everything removed closes as empty", () => {
    const state = run(createViewerState(people), {
      type: "remove",
      storyIds: ["b1", "b2", "c1", "f1", "f2", "f3"],
    });
    expect(state.closed).toBe("empty");
  });

  it("removing somebody else's story keeps the current one playing", () => {
    let state = run(
      createViewerState(people),
      { type: "duration", durationMs: 5_000 },
      { type: "tick", deltaMs: 1_000 },
    );
    const before = state.generation;
    state = run(state, { type: "remove", storyIds: ["f2"] });
    expect(currentStoryId(state)).toBe("b1");
    expect(state.elapsedMs).toBe(1_000);
    expect(state.generation).toBe(before);
  });

  it("removing an unknown id is a no-op", () => {
    const state = createViewerState(people);
    expect(run(state, { type: "remove", storyIds: ["zzz"] })).toBe(state);
  });
});

describe("pacing and preload", () => {
  it("photo 5 s, call 8 s, text by length, video its own", () => {
    expect(storyDisplayMs({ kind: "image", text: null, sticker: null, media: null })).toBe(
      STORY_PHOTO_DISPLAY_MS,
    );
    expect(
      storyDisplayMs({
        kind: "text",
        text: "bora",
        sticker: { type: "call", serverId: "s", channelId: "c" },
        media: null,
      }),
    ).toBe(STORY_CALL_DISPLAY_MS);
    expect(storyDisplayMs({ kind: "text", text: "x".repeat(40), sticker: null, media: null })).toBe(
      storyTextDisplayMs("x".repeat(40)),
    );
    expect(
      storyDisplayMs({
        kind: "video",
        text: null,
        sticker: null,
        media: {
          url: "u",
          posterUrl: null,
          contentType: "video/mp4",
          width: 1,
          height: 1,
          durationMs: 12_345,
        },
      }),
    ).toBe(12_345);
  });

  it("preloads the rest of this person and the first story of each neighbour", () => {
    expect(idsToPreload(createViewerState(people, { personIndex: 1 }))).toEqual(["c1", "f1", "b1"]);
    expect(idsToPreload(createViewerState(people, { storyIndex: 1 }))).toEqual(["b2", "c1"]);
  });
});
