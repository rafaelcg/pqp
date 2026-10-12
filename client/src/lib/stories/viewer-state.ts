import {
  STORY_CALL_DISPLAY_MS,
  STORY_PHOTO_DISPLAY_MS,
  storyTextDisplayMs,
  type Story,
} from "@pqp/shared";

/**
 * The story viewer as a state machine, with no DOM and no clock of its own.
 *
 * The component feeds it: a `tick` from one `requestAnimationFrame` loop for
 * a photo, text or call card, the video's own `currentTime` for a video,
 * and taps, keys and gestures as actions. Everything that decides what is on
 * screen next (end of a story, end of a person, end of the walk, a story
 * removed under the viewer) is here, where it is tested without a browser.
 *
 * PAUSE IS A SET OF REASONS, not a boolean. Holding the card, typing a reply,
 * reading the viewers sheet, an open menu and a hidden tab are independent:
 * letting go of the card while the reply box still has focus must not start
 * the story under the person typing.
 */

export interface ViewerPerson {
  authorId: string;
  /** Play order, oldest first, as the strip sent it. */
  storyIds: string[];
}

export type PauseReason =
  | "hold"
  | "reply"
  | "sheet"
  | "menu"
  | "dialog"
  | "hidden"
  | "key";

export type PersonMove = "none" | "forward" | "back";

export interface ViewerState {
  people: ViewerPerson[];
  personIndex: number;
  storyIndex: number;
  /** Time shown of the current story. Owned by the video for a video. */
  elapsedMs: number;
  /** Null until the story has loaded and its length is known. */
  durationMs: number | null;
  pauses: readonly PauseReason[];
  /** Why the viewer closed, or null while it is open. */
  closed: null | "end" | "user" | "empty";
  /**
   * The direction of the last change of PERSON, so the card can play the
   * deck motion the right way round. `none` for a change of story within one
   * person, which is a crossfade, not a slide.
   */
  lastMove: PersonMove;
  /** Bumped on every change of story, so the component can key its media. */
  generation: number;
}

export type ViewerAction =
  | { type: "tick"; deltaMs: number }
  | { type: "progress"; elapsedMs: number }
  | { type: "duration"; durationMs: number }
  | { type: "next" }
  | { type: "prev" }
  | { type: "nextPerson" }
  | { type: "prevPerson" }
  | { type: "goPerson"; index: number }
  | { type: "pause"; reason: PauseReason }
  | { type: "resume"; reason: PauseReason }
  | { type: "remove"; storyIds: readonly string[] }
  | { type: "close" };

export function createViewerState(
  people: readonly ViewerPerson[],
  start: { personIndex?: number; storyIndex?: number } = {},
): ViewerState {
  const usable = people.filter((person) => person.storyIds.length > 0);
  if (usable.length === 0) {
    return {
      people: [],
      personIndex: 0,
      storyIndex: 0,
      elapsedMs: 0,
      durationMs: null,
      pauses: [],
      closed: "empty",
      lastMove: "none",
      generation: 0,
    };
  }
  const personIndex = clamp(start.personIndex ?? 0, 0, usable.length - 1);
  const storyIndex = clamp(
    start.storyIndex ?? 0,
    0,
    usable[personIndex]!.storyIds.length - 1,
  );
  return {
    people: usable.map((person) => ({ ...person, storyIds: [...person.storyIds] })),
    personIndex,
    storyIndex,
    elapsedMs: 0,
    durationMs: null,
    pauses: [],
    closed: null,
    lastMove: "none",
    generation: 0,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function goTo(
  state: ViewerState,
  personIndex: number,
  storyIndex: number,
  lastMove: PersonMove,
): ViewerState {
  return {
    ...state,
    personIndex,
    storyIndex,
    elapsedMs: 0,
    durationMs: null,
    lastMove,
    generation: state.generation + 1,
  };
}

function next(state: ViewerState): ViewerState {
  const person = state.people[state.personIndex]!;
  if (state.storyIndex < person.storyIds.length - 1) {
    return goTo(state, state.personIndex, state.storyIndex + 1, "none");
  }
  return nextPerson(state);
}

function nextPerson(state: ViewerState): ViewerState {
  if (state.personIndex < state.people.length - 1) {
    return goTo(state, state.personIndex + 1, 0, "forward");
  }
  // The end of the walk closes back to the ring that opened it (design §3.4).
  return { ...state, closed: "end" };
}

function prev(state: ViewerState): ViewerState {
  if (state.storyIndex > 0) {
    return goTo(state, state.personIndex, state.storyIndex - 1, "none");
  }
  if (state.personIndex > 0) {
    return goTo(state, state.personIndex - 1, 0, "back");
  }
  // The very first story: start it again, as every stories app does.
  return goTo(state, state.personIndex, 0, "none");
}

function prevPerson(state: ViewerState): ViewerState {
  if (state.personIndex > 0) {
    return goTo(state, state.personIndex - 1, 0, "back");
  }
  return goTo(state, 0, 0, "none");
}

/**
 * Drop stories that went away while the viewer was open (the author deleted
 * one, a moderator removed it, it expired). Whoever is left keeps their place
 * when possible; the current story, if it was one of them, gives way to the
 * story that followed it.
 */
function remove(state: ViewerState, storyIds: readonly string[]): ViewerState {
  const gone = new Set(storyIds);
  const currentId = currentStoryId(state);
  if (!state.people.some((person) => person.storyIds.some((id) => gone.has(id)))) {
    return state;
  }
  const people: ViewerPerson[] = [];
  let personIndex = -1;
  let storyIndex = 0;
  state.people.forEach((person, index) => {
    const kept = person.storyIds.filter((id) => !gone.has(id));
    if (index === state.personIndex) {
      // Where the current story was, or the first one after it that survived.
      const before = person.storyIds
        .slice(0, state.storyIndex)
        .filter((id) => !gone.has(id)).length;
      if (kept.length > 0) {
        personIndex = people.length;
        storyIndex = Math.min(before, kept.length - 1);
      } else {
        // The whole person went: the next one surviving takes the place.
        personIndex = people.length;
        storyIndex = 0;
      }
    }
    if (kept.length > 0) {
      people.push({ ...person, storyIds: kept });
    }
  });
  if (people.length === 0) {
    return { ...state, people, closed: "empty" };
  }
  if (personIndex >= people.length) {
    // The current person was the last and vanished: there is nobody after.
    return { ...state, people, personIndex: people.length - 1, closed: "end" };
  }
  const changed = currentId === null || gone.has(currentId);
  const nextState = { ...state, people, personIndex, storyIndex };
  return changed
    ? goTo(nextState, personIndex, storyIndex, "none")
    : nextState;
}

export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  if (state.closed && action.type !== "close") {
    return state;
  }
  switch (action.type) {
    case "tick": {
      if (isPaused(state) || state.durationMs === null) {
        return state;
      }
      const elapsedMs = state.elapsedMs + Math.max(0, action.deltaMs);
      if (elapsedMs >= state.durationMs) {
        return next(state);
      }
      return { ...state, elapsedMs };
    }
    case "progress":
      return { ...state, elapsedMs: Math.max(0, action.elapsedMs) };
    case "duration":
      return action.durationMs > 0
        ? { ...state, durationMs: action.durationMs }
        : state;
    case "next":
      return next(state);
    case "prev":
      return prev(state);
    case "nextPerson":
      return nextPerson(state);
    case "prevPerson":
      return prevPerson(state);
    case "goPerson": {
      if (action.index < 0 || action.index >= state.people.length) {
        return state;
      }
      if (action.index === state.personIndex) {
        return state;
      }
      return goTo(
        state,
        action.index,
        0,
        action.index > state.personIndex ? "forward" : "back",
      );
    }
    case "pause":
      return state.pauses.includes(action.reason)
        ? state
        : { ...state, pauses: [...state.pauses, action.reason] };
    case "resume":
      return state.pauses.includes(action.reason)
        ? { ...state, pauses: state.pauses.filter((reason) => reason !== action.reason) }
        : state;
    case "remove":
      return remove(state, action.storyIds);
    case "close":
      return state.closed ? state : { ...state, closed: "user" };
  }
}

export function isPaused(state: ViewerState): boolean {
  return state.pauses.length > 0;
}

export function currentPerson(state: ViewerState): ViewerPerson | null {
  return state.people[state.personIndex] ?? null;
}

export function currentStoryId(state: ViewerState): string | null {
  return currentPerson(state)?.storyIds[state.storyIndex] ?? null;
}

/** 0..1 for the current bar. */
export function progressFraction(state: ViewerState): number {
  if (!state.durationMs || state.durationMs <= 0) {
    return 0;
  }
  return clamp(state.elapsedMs / state.durationMs, 0, 1);
}

/**
 * How long a story stays on screen when nothing else decides it. A video
 * plays for its own length, read from the element; this is only its fallback
 * while the element has not said.
 */
export function storyDisplayMs(
  story: Pick<Story, "kind" | "text" | "sticker" | "media">,
): number {
  if (story.kind === "video") {
    return story.media?.durationMs ?? STORY_PHOTO_DISPLAY_MS;
  }
  if (story.sticker?.type === "call") {
    return STORY_CALL_DISPLAY_MS;
  }
  if (story.kind === "text") {
    return storyTextDisplayMs(story.text ?? "");
  }
  return STORY_PHOTO_DISPLAY_MS;
}

/**
 * The ids worth fetching now: the rest of this person's stories and the next
 * person's first one (design §3.2, Preload). Order matters only for which
 * request goes first.
 */
export function idsToPreload(state: ViewerState): string[] {
  const person = currentPerson(state);
  if (!person) {
    return [];
  }
  const ids = person.storyIds.slice(state.storyIndex);
  const following = state.people[state.personIndex + 1];
  if (following?.storyIds[0]) {
    ids.push(following.storyIds[0]);
  }
  const previous = state.people[state.personIndex - 1];
  if (previous?.storyIds[0]) {
    ids.push(previous.storyIds[0]);
  }
  return ids;
}
