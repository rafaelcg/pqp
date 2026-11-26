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
  /** The instruments still missing, as ids ("bass"), in the order the song asks for them. */
  needs: readonly string[];
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
  /** The sentence for a kind, with `{title}`, `{list}` and `count` filled by the caller's catalogue. */
  say: (kind: JamShareKind, vars: { title: string; list: string; count: number }) => string;
  /** An instrument's name in the reader's language, lower case: "baixo". */
  name: (instrument: string) => string;
  /** "baixo e voz", in the language's own list grammar. */
  list: (names: readonly string[]) => string;
}

/** The prepared message, without the link (the link travels beside it, or after it). */
export function jamShareText(song: JamShareSong, words: JamShareWords): string {
  const kind = jamShareKind(song);
  const names = kind === "needs" ? song.needs.map((one) => words.name(one)) : [];
  return words
    .say(kind, { title: song.title, list: words.list(names), count: names.length })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What is still missing once the person's own part is in: the song's wanted
 * instruments, minus those already in it, minus the one they just recorded
 * (they cannot ask their friends for the part they just sent).
 */
export function jamMissingAfter(
  song: { joinMode: "open" | "wanted" | "closed"; wantedInstruments: readonly string[]; instruments: readonly string[] },
  justSent: string | null,
): string[] {
  if (song.joinMode !== "wanted") {
    return [];
  }
  return song.wantedInstruments.filter((one) => one !== justSent && !song.instruments.includes(one));
}
