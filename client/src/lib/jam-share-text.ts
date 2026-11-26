/**
 * What a shared jam says, chosen from what the song is missing.
 *
 * Pure: the app and the public site each have their own catalogue (the site
 * keeps three small ones of its own, `lib/i18n/jam-site.ts`), so the words come
 * in through `say` and this file only decides WHICH sentence and with what.
 *
 *   needs    the song asks for parts: "Falta baixo nessa. Grava a tua parte:"
 *   open     any part is welcome, none is asked for by name
 *   listen   nothing is missing (complete, or closed): an invitation to listen
 *
 * The message never carries a "made with" line: it is the person's own message
 * to their own people, and the link at its end is the only mention of pqp.
 */

export type JamShareKind = "needs" | "open" | "listen";

export interface JamShareSong {
  title: string;
  joinMode: "open" | "wanted" | "closed";
  /** The instruments still missing, as ids ("bass"), in the order the song asks for them (`jamStillNeeds`). */
  needs: readonly string[];
  /**
   * The instruments the sender already sent that wait for the song's starter, as ids. The message says
   * so: a friend who opens the link hears the song WITHOUT them, and "falta bateria" from somebody whose
   * drums are on their way would be untrue from where they stand. Empty or absent for everybody else
   * (the site's visitor has no part of their own to speak of).
   */
  pending?: readonly string[];
}

export function jamShareKind(song: Pick<JamShareSong, "joinMode" | "needs">): JamShareKind {
  if (song.joinMode === "closed") {
    return "listen";
  }
  if (song.needs.length > 0) {
    return "needs";
  }
  return song.joinMode === "open" ? "open" : "listen";
}

export interface JamShareWords {
  /**
   * The sentence for a kind, with `{title}`, `{list}` and `count` filled by the caller's catalogue.
   * With `pending` the sentence also says that the sender's own part (`mine`, "bateria") waits for the starter.
   */
  say: (
    kind: JamShareKind,
    vars: { title: string; list: string; count: number; pending: boolean; mine: string },
  ) => string;
  /** An instrument's name in the reader's language, lower case: "baixo". */
  name: (instrument: string) => string;
  /** "baixo e voz", in the language's own list grammar. */
  list: (names: readonly string[]) => string;
}

/** The prepared message, without the link (the link travels beside it, or after it). */
export function jamShareText(song: JamShareSong, words: JamShareWords): string {
  const kind = jamShareKind(song);
  const names = kind === "needs" ? song.needs.map((one) => words.name(one)) : [];
  const mine = (song.pending ?? []).map((one) => words.name(one));
  return words
    .say(kind, {
      title: song.title,
      list: words.list(names),
      count: names.length,
      pending: mine.length > 0,
      mine: words.list(mine),
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * WHAT A SONG STILL NEEDS: the ONE rule, for the share card, the song page's own
 * share button and (as the server's `needs`, which is the same rule) the public site.
 *
 * The instruments the song asks for, minus those already in the band, minus the
 * ones the person sent that wait for the starter (`pending`): they cannot ask their
 * friends for a part they just sent. User test round 3 (N-2): the card said "falta
 * voz" and the song page's share said "faltam bateria e voz" for the same sender
 * and the same song, because only one of the two knew about the part in the queue.
 * An open or closed song names nothing.
 */
export function jamStillNeeds(
  song: { joinMode: "open" | "wanted" | "closed"; wantedInstruments: readonly string[]; instruments: readonly string[] },
  pending: readonly string[] = [],
): string[] {
  if (song.joinMode !== "wanted") {
    return [];
  }
  return song.wantedInstruments.filter((one) => !pending.includes(one) && !song.instruments.includes(one));
}
