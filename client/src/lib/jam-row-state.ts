/**
 * Which face the sidebar's Jam row wears. One answer from the signals the
 * client already holds, so the art and the icon never disagree about it:
 *
 * - `playing`: this client is playing a Jam song, on the Jam page or from a card in a chat (the shared
 *   audio engine's transport, `jam-now-playing.ts`). The loudest state.
 * - `news`: a song or take moved since the person last opened the Jam
 *   (`useJamSidebar`'s `news`). Only while the Jam is not the open page, because
 *   opening it is what spends the dot.
 * - `empty`: the Jam loaded and holds no song yet. A quiet room.
 * - `quiet`: everything else, including a count that has not loaded.
 *
 * Hover and keyboard focus are not here: they are CSS (`:hover`,
 * `:focus-within`) so they cost no render.
 */
export type JamRowMood = "playing" | "news" | "empty" | "quiet";

export interface JamRowSignals {
  /** The row is the open page. */
  selected: boolean;
  /** The shared engine is playing a song. */
  playing: boolean;
  /** Something moved since the person last looked. */
  news: boolean;
  loaded: boolean;
  songCount: number;
}

export function jamRowMood({ selected, playing, news, loaded, songCount }: JamRowSignals): JamRowMood {
  // The engine is released when the person leaves the Jam, so `playing` is never a
  // leftover. It is true off the Jam's page too: a song's card in a conversation
  // plays on the same engine (`jam-chat-player.ts`), and the row says so.
  if (playing) {
    return "playing";
  }
  if (news && !selected) {
    return "news";
  }
  if (loaded && songCount === 0) {
    return "empty";
  }
  return "quiet";
}

/**
 * Whether the row's art may run its animations right now: it is on screen and
 * the tab is visible. A row that is scrolled out of the list or a hidden tab
 * pays nothing.
 */
export function jamRowMayAnimate(inView: boolean, pageVisible: boolean): boolean {
  return inView && pageVisible;
}
