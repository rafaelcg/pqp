import { cameraSoloId } from "@/components/dm/call-stage-state";

/**
 * Who owns the call stage, and who collapses into the strip under it.
 *
 * WHY THIS EXISTS. A 200-person watch party on 5 Sep 2026 put the streamer's
 * webcam in the same scrolling thumbnail rail as everybody else's avatar, so a
 * viewer asking "where is his face" had to scroll a column of 200 tiles to
 * find a 96px one. The share was large and the camera was not, because the
 * stage was built around *one* focused picture and treated every other
 * publisher as a participant thumbnail.
 *
 * The rule this file encodes is the opposite, and it is one sentence:
 * PUBLISHING VIDEO PUTS YOU ON THE STAGE, WATCHING PUTS YOU IN THE STRIP.
 * A webcam and a shared screen are the same kind of thing here, because to
 * somebody looking for the streamer they are: a picture with a person's name
 * on it. Everyone else is a face, a name and two indicators, which is all a
 * listener has ever needed and all a room of 200 can afford to draw.
 *
 * Pure, and separate from `call-stage.tsx`, because every one of these
 * decisions is a bug with a visible shape (a webcam sent to a thumbnail rail,
 * a strip that scrolls for a hundred names, a grid that shrinks the one tile
 * anybody came for) and the client suite runs in node with no DOM.
 */

export type StageTileKind = "screen" | "camera";

export interface StageTile {
  /**
   * Unique across the stage AND the id the fullscreen machinery already
   * speaks: a screen is its `peerId`, a camera is `camera:<personKey>`. See
   * `screen-fullscreen.ts` — one solo id, one path in and out, whichever kind
   * of picture is on it.
   */
  id: string;
  kind: StageTileKind;
  /** `peerId` for a screen tile, the person's stage key for a camera tile. */
  key: string;
  isSelf: boolean;
}

export interface StagePlan {
  /** The large tiles, in the order they are drawn. */
  tiles: StageTile[];
  /**
   * Our own camera is the floating corner preview rather than a tile.
   *
   * True in exactly one shape: somebody else is publishing exactly one
   * picture. That is the 1:1 video call, where the other person IS the call
   * and taking half the stage away from them to show a face we are already
   * behind is the layout people complained about before the stage existed.
   * With two or more other pictures the stage is a grid already, and a
   * floating preview over a grid reads as a bug rather than as a choice.
   */
  selfPreview: boolean;
  /**
   * The first tile spans the full width of the grid. Set by a pin: "make that
   * one big without hiding the rest", which is the half of the old spotlight
   * layout worth keeping now that everything else is a grid.
   */
  featured: boolean;
  /**
   * Publishers the bounded grid did not draw, by person key.
   *
   * They are not dropped from the call: `listenersOf` takes this list and puts
   * them in the strip as chips, so a camera the grid could not fit is still a
   * face with a name and a mute indicator, and the strip's own "+43" counts
   * them like anybody else. Empty whenever the grid drew everything, which is
   * every call that is not large.
   */
  overflowKeys: string[];
}

export interface StageScreenInput {
  peerId: string;
  isSelf: boolean;
}

export interface StagePersonInput {
  key: string;
  /** A camera picture, or null. Typed loosely so a test needs no MediaStream. */
  stream: unknown;
  isSelf: boolean;
}

/**
 * The stage's tiles, in order: shares, then other people's cameras, then ours.
 *
 * Shares first because a share is the thing a room gathers around, and the
 * order inside each group is the roster's, never the speaking order: a grid
 * that reshuffles itself every time somebody says "yeah" is unusable, and the
 * whole point of this stage is that a picture stays where you last saw it.
 */
export function planStage(input: {
  screens: readonly StageScreenInput[];
  people: readonly StagePersonInput[];
  /** The pinned tile id, when the user asked for one. */
  pinnedTileId?: string | null;
  /**
   * The most tiles this stage will draw. Omitted means no bound, which is what
   * every test that predates the bound expects and what a one-tile call wants.
   */
  tileLimit?: number;
  /** Person keys (a camera tile's `key`) that are speaking right now. */
  speakingKeys?: ReadonlySet<string>;
}): StagePlan {
  const screens: StageTile[] = input.screens.map((screen) => ({
    id: screen.peerId,
    kind: "screen",
    key: screen.peerId,
    isSelf: screen.isSelf,
  }));
  const remoteCameras: StageTile[] = input.people
    .filter((person) => !person.isSelf && person.stream != null)
    .map((person) => ({
      id: cameraSoloId(person.key),
      kind: "camera",
      key: person.key,
      isSelf: false,
    }));
  const self = input.people.find((person) => person.isSelf) ?? null;
  const others = [...screens, ...remoteCameras];
  const selfCamera: StageTile | null =
    self && self.stream != null
      ? { id: cameraSoloId(self.key), kind: "camera", key: self.key, isSelf: true }
      : null;
  const selfPreview = selfCamera !== null && others.length === 1;
  const tiles = selfCamera && !selfPreview ? [...others, selfCamera] : others;
  const pinned = input.pinnedTileId
    ? tiles.find((tile) => tile.id === input.pinnedTileId)
    : undefined;
  const ordered = pinned
    ? [pinned, ...tiles.filter((tile) => tile.id !== pinned.id)]
    : tiles;
  // A crowded room watching ONE screen: the screen takes the whole first row
  // and the faces line up underneath. Four pictures in a plain grid puts that
  // screen at a quarter of the stage, which is not what a room gathered to
  // watch it looks like. One screen only — two presenters is a comparison, and
  // the grid is right for that — and a pin always outranks it.
  const slots = stageTileSlots(
    ordered,
    input.tileLimit ?? Number.POSITIVE_INFINITY,
    input.speakingKeys ?? EMPTY_KEYS,
  );
  const shown = slots.shown;
  const watchParty =
    pinned === undefined &&
    screens.length === 1 &&
    shown.length >= 4 &&
    shown[0]?.kind === "screen";
  return {
    tiles: shown,
    selfPreview,
    featured: (pinned !== undefined || watchParty) && shown.length > 1,
    overflowKeys: slots.overflow.map((tile) => tile.key),
  };
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/**
 * HOW MANY PICTURES A STAGE DRAWS AT ONCE, AND WHY THERE IS A NUMBER AT ALL.
 *
 * The grid rendered every publisher until 2026-09-08, which was correct while
 * the camera cap was eight. It is not correct in a room of twenty with twenty
 * cameras: that is twenty subscriptions, twenty decoders and twenty tiles the
 * size of a stamp, and the phone gives out long before the box does. Nothing
 * about that is fixed by a smaller layer. A 180p stream is cheap; twenty of
 * them still cost twenty decodes.
 *
 * So the grid is bounded, and the tiles it does not draw are not drawn at all
 * rather than drawn small: an unmounted `<video>` unbinds from its track, and
 * `remote-video-delivery.ts` then tells the server to stop forwarding it a
 * second later. The bound is therefore a bandwidth control as much as a layout
 * one, which is why it lives here beside the column count and not in CSS.
 *
 * TWELVE AND SIX, AND HOW THEY WERE PICKED. Both are the shape
 * `stageGridColumns` already tops out at (four columns wide, three narrow)
 * carried down to a whole number of rows. What decided the row count is what
 * a tile that size actually costs a viewer, measured against a local LiveKit
 * with this ladder published:
 *
 * | video element | layer received | per stream | decode per frame |
 * |---|---|---|---|
 * | 424x490 | 1280x720 | 703 kbps | 0.75 ms |
 * | 424x360 | 640x360  | 317 kbps | 0.26 ms |
 * | 350x197 | 320x180  | 145 kbps | 0.10 ms |
 * | 160x90  | 320x180  | 149 kbps | 0.10 ms |
 *
 * A 1440px window gives the grid about 860 px, so four columns is a tile
 * around 210 px wide and three on a phone is around 120 px. Both land on the
 * bottom rung, which is about 150 kbps and a tenth of a millisecond of decode
 * each: twelve of them is roughly 1.8 Mbit/s and six is under 1. Bandwidth is
 * therefore NOT what sets these numbers, and saying otherwise would be the
 * comfortable lie. What sets them is that a tile of a face below about 200 px
 * has stopped being a picture of a person, and that a phone is holding six
 * decoders plus a compositor plus the app. Twelve is where the grid stops
 * being legible; the bandwidth is a rounding error by then, and that is only
 * true because the ladder above exists.
 */
export const STAGE_TILE_LIMIT_WIDE = 12;
export const STAGE_TILE_LIMIT_NARROW = 6;

export interface StageTileSlots {
  /** The tiles the grid draws, in stage order. */
  shown: StageTile[];
  /** Publishers the grid could not fit. They become chips in the strip. */
  overflow: StageTile[];
}

/**
 * Which pictures survive the bound, and in what order they are drawn.
 *
 * Deliberately the same shape as `listenerStripSlots`, because it is the same
 * problem one size up, and the rules are its rules:
 *
 *  1. Every share. A room gathers around a screen; there are at most four of
 *     them (`SCREEN_SHARE_LIMIT`) and cutting one would hide the thing people
 *     came for to make space for a face.
 *  2. The first tile, which is the pin when there is one. Somebody who asked
 *     for a picture keeps it.
 *  3. Our own camera. Same reason our own chip is always in the strip: a
 *     person who cannot see their own picture concludes it is not going out.
 *  4. Anybody speaking. This is the only rule that makes a bounded grid better
 *     than the first twelve people in roster order, and it is the whole answer
 *     to "the person talking is on page two".
 *  5. Everyone else in stage order, until the bound.
 *
 * The chosen set is then drawn in STAGE order, not in priority order, so a
 * person who says "yeah" does not jump to the front and shove eleven tiles
 * sideways. Membership changes; position does not.
 *
 * And, exactly as in the strip: with one publisher over the bound the last
 * slot goes to them rather than to a "+1", because "+1" is never worth a face.
 */
export function stageTileSlots(
  tiles: readonly StageTile[],
  limit: number,
  speakingKeys: ReadonlySet<string>,
): StageTileSlots {
  if (limit <= 0) {
    return { shown: [], overflow: [...tiles] };
  }
  if (tiles.length <= limit + 1) {
    return { shown: [...tiles], overflow: [] };
  }
  const index = new Map(tiles.map((tile, at) => [tile.id, at]));
  const picked = new Map<string, StageTile>();
  const take = (tile: StageTile) => {
    if (picked.size < limit) {
      picked.set(tile.id, tile);
    }
  };
  for (const tile of tiles) {
    if (tile.kind === "screen") {
      take(tile);
    }
  }
  if (tiles[0]) {
    take(tiles[0]);
  }
  for (const tile of tiles) {
    if (tile.isSelf) {
      take(tile);
    }
  }
  for (const tile of tiles) {
    if (speakingKeys.has(tile.key)) {
      take(tile);
    }
  }
  for (const tile of tiles) {
    take(tile);
  }
  const byOrder = (a: StageTile, b: StageTile) =>
    (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0);
  const shown = [...picked.values()].sort(byOrder);
  const overflow = tiles.filter((tile) => !picked.has(tile.id));
  return { shown, overflow };
}

/**
 * Everyone the stage did not take: no camera of their own, and not presenting.
 *
 * A presenter with their camera off is NOT repeated down here. Their screen
 * already carries their name on the stage, and a room where the person
 * everybody is watching also sits in the "just listening" row is a room that
 * lies about who is doing what.
 */
export function listenersOf<T extends StagePersonInput>(
  people: readonly T[],
  screens: readonly StageScreenInput[],
  /** Our own peer id, which is how our own share is spelled in `screens`. */
  localPeerId: string | null,
  /**
   * People whose camera the bounded grid could not draw (`StagePlan.overflowKeys`).
   *
   * They publish, so the rule above would send them to the stage, and the
   * stage has already said no. A chip is what is left, and it is the right
   * thing: the alternative is a person who is in the call, with their camera
   * on, appearing nowhere on the screen at all.
   */
  demoted: ReadonlySet<string> = EMPTY_KEYS,
): T[] {
  const presenting = new Set(screens.map((screen) => screen.peerId));
  return people.filter((person) => {
    if (person.stream != null && !demoted.has(person.key)) {
      return false;
    }
    const peerId = person.isSelf ? localPeerId : person.key;
    return peerId === null || !presenting.has(peerId);
  });
}

/**
 * How many columns the grid gets.
 *
 * The shape of the answer, and why it is not `ceil(sqrt(n))`: a call tile is
 * 16:9, so columns cost width and rows cost height, and a stage is a wide box
 * roughly two thirds as tall as it is wide. Squaring the count fills that box
 * with letterboxing; keeping the column count one step behind it fills it with
 * picture.
 *
 * Portrait is not the same question with smaller numbers. A phone stacks: one
 * column up to two publishers, because a 390px-wide tile is the biggest a
 * phone can give and two of them stacked is still a picture each, and only
 * then does a second column start. That is what keeps "the streamer is big"
 * true on the device most of that watch party was holding.
 */
export function stageGridColumns(count: number, wide: boolean): number {
  if (count <= 1) {
    return 1;
  }
  if (!wide) {
    if (count <= 2) {
      return 1;
    }
    return count <= 6 ? 2 : 3;
  }
  if (count <= 4) {
    return 2;
  }
  return count <= 9 ? 3 : 4;
}

/**
 * A click on the picture opens that tile fullscreen only once the stage holds
 * more than one.
 *
 * With a single tile the stage *is* the tile, and a tap on it already means
 * something on a phone: show the controls (`use-idle-chrome.ts`). Taking that
 * gesture for fullscreen would trade a control bar people reach for every call
 * for a state they can also reach from the button on the tile and from a
 * double click. With two or more tiles the tap is unambiguous — "that one" —
 * and it is the gesture the watch-party report was reaching for.
 */
export function tileClickFullscreens(tileCount: number): boolean {
  return tileCount >= 2;
}

/**
 * How many listener chips fit before the overflow chip earns its place.
 *
 * Measured against the chip, not guessed: a chip is an avatar, a name clamped
 * to 8rem and maybe a mute glyph, so about 9rem at the widest. Twelve of those
 * is a laptop's stage width, and four is a 390px phone with the toggle beside
 * them. Past that the row would scroll, and a row you have to scroll to find
 * out who is in it is the rail this replaced.
 */
export const STRIP_LIMIT_WIDE = 12;
export const STRIP_LIMIT_NARROW = 4;

export interface StripPerson {
  key: string;
  speaking: boolean;
  isSelf: boolean;
}

export interface StripSlots<T> {
  shown: T[];
  /** People behind the "+43" chip. Zero means the chip is not drawn. */
  overflow: number;
}

/**
 * Which listeners the strip draws, and how many hide behind "+43".
 *
 * Three rules, in this order:
 *
 *  1. We are always shown. The strip is where our own mute indicator lives,
 *     and a person who cannot find themselves in a room assumes they are not
 *     in it.
 *  2. Anybody speaking is shown, even from the far end of a 200-person room.
 *     This is the only thing that makes a strip better than a headcount: in a
 *     watch party the question is never "who is here", it is "who just said
 *     that".
 *  3. Everyone else in roster order, until the limit.
 *
 * The chosen set is then drawn in ROSTER order, not in priority order, so a
 * person who speaks does not jump to the front and shove the row sideways.
 *
 * One more thing, which is why the limit is not simply a slice: with exactly
 * one person over the limit the chip would replace the very person it counts,
 * so the last slot goes to them instead. "+1" is never worth a face.
 */
export function listenerStripSlots<T extends StripPerson>(
  people: readonly T[],
  limit: number,
): StripSlots<T> {
  if (limit <= 0) {
    return { shown: [], overflow: people.length };
  }
  if (people.length <= limit + 1) {
    return { shown: [...people], overflow: 0 };
  }
  const index = new Map(people.map((person, at) => [person.key, at]));
  const picked = new Map<string, T>();
  const take = (person: T) => {
    if (picked.size < limit) {
      picked.set(person.key, person);
    }
  };
  for (const person of people) {
    if (person.isSelf) {
      take(person);
    }
  }
  for (const person of people) {
    if (person.speaking) {
      take(person);
    }
  }
  for (const person of people) {
    take(person);
  }
  const shown = [...picked.values()].sort(
    (a, b) => (index.get(a.key) ?? 0) - (index.get(b.key) ?? 0),
  );
  return { shown, overflow: people.length - shown.length };
}
