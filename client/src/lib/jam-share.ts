import { isOwnInstanceOrigin } from "@/lib/community-home/share-card";
import { jamSongRoutePath } from "@/lib/app-route";

/**
 * A Jam song pasted into chat.
 *
 * A song has one stable address, the one the Jam's own address bar shows while
 * it is open: `/app/server/<serverId>/channel/<jamId>/song/<songId>`
 * (`jamSongRoutePath`). A chat message that holds that address, on this
 * instance, is drawn as a card under the message (`jam-link-card.tsx`).
 *
 * Pure on purpose: which link in a message gets a card, and what the sender's
 * words look like with the link taken out. Who may see the song is decided by
 * the server when the card asks for it (the song detail read), never here.
 */

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const SONG_PATH_RE = new RegExp(`^/app/server/(${UUID})/channel/(${UUID})/song/(${UUID})/?$`);
const URL_RE = /https?:\/\/[^\s<>()[\]]+/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?'"]+$/;

export interface JamSongRef {
  serverId: string;
  channelId: string;
  songId: string;
}

export type JamSongLink = JamSongRef & {
  /** The URL exactly as it appears in the text. */
  url: string;
  /** Its origin, e.g. `https://pqp.gg`. */
  origin: string;
  /** Offsets into the scanned text, `end` exclusive. */
  start: number;
  end: number;
};

/** The song a `/app/server/<id>/channel/<id>/song/<id>` path names, or null. */
export function parseJamSongPath(pathname: string): JamSongRef | null {
  const match = SONG_PATH_RE.exec(pathname);
  if (!match) {
    return null;
  }
  return {
    serverId: match[1]!.toLowerCase(),
    channelId: match[2]!.toLowerCase(),
    songId: match[3]!.toLowerCase(),
  };
}

/** The link that goes into the message: this instance's origin plus the song's path. */
export function jamSongShareUrl(origin: string, ref: JamSongRef): string {
  return `${origin}${jamSongRoutePath(ref.serverId, ref.channelId, ref.songId)}`;
}

/** Every Jam song link in a body, in order. Origin policy is the caller's. */
export function findJamSongLinks(text: string): JamSongLink[] {
  const found: JamSongLink[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION_RE, "");
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    const ref = parseJamSongPath(parsed.pathname);
    if (!ref) {
      continue;
    }
    const start = match.index ?? 0;
    found.push({ ...ref, url: raw, origin: parsed.origin, start, end: start + raw.length });
  }
  return found;
}

export interface JamCardSelection {
  link: JamSongLink;
  /** The message says nothing besides the link, so the card can replace it. */
  linkOnly: boolean;
}

/** The first same-instance Jam song link in a message body, or null. */
export function selectJamCardLink(
  body: string | null | undefined,
  currentOrigin: string | null,
): JamCardSelection | null {
  if (!body) {
    return null;
  }
  for (const link of findJamSongLinks(body)) {
    if (isOwnInstanceOrigin(link.origin, currentOrigin)) {
      return { link, linkOnly: `${body.slice(0, link.start)}${body.slice(link.end)}`.trim() === "" };
    }
  }
  return null;
}

/**
 * The message with the card's own link taken out, so the words the sender wrote
 * stay and the long URL they pasted does not sit above its own card.
 */
export function stripJamLink(body: string, link: Pick<JamSongLink, "start" | "end">): string {
  return `${body.slice(0, link.start)}${body.slice(link.end)}`
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
