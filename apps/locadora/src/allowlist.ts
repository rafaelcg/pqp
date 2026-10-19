/**
 * THE LIST OF GAMES LOCADORA MAY OFFER. IT IS EMPTY, AND IT STAYS EMPTY UNTIL A
 * HUMAN PUTS SOMETHING HERE.
 *
 * pqp does not provide games. Locadora opens a file the person picks from their
 * own disk; nothing in this repository, in the app, on our CDN or on our
 * servers is, fetches, links to, searches for or names a ROM or a game image.
 * The one thing that could ever change that is an entry in this file, so the
 * rules for adding one are strict:
 *
 *  - Homebrew or public-domain titles ONLY, made by someone who published them
 *    for free redistribution, or whose copyright has lapsed.
 *  - VERIFIED BY A HUMAN, who has read the author's own license or release
 *    note, not a "free ROMs" page. "Abandonware", "out of print", "the company
 *    is gone" and "it is on the Internet Archive" are NOT public domain.
 *  - Every entry records where that verification came from (`licenseUrl`) and
 *    who did it (`verifiedBy`), so the next person can check it again.
 *  - Adding an entry is a change to this file in a pull request that says so,
 *    reviewed by Rafael, and it needs the lawyer review in
 *    `docs/EMULATOR_ROOM.md` to be done first. Nothing here is wired to a
 *    download: an entry would still have to be served by a later, separate
 *    change, and that change has its own review.
 *
 * `allowlist.test.ts` fails the build if this list is not empty, so an entry
 * cannot slip in with an unrelated change. (The emulator room of the old menu
 * entry keeps its own copy at `client/src/lib/emulator/allowlist.ts` until that
 * entry is retired.)
 */
export interface AllowlistEntry {
  /** A stable id, lower-case. */
  id: string;
  /** The title as its author published it. */
  title: string;
  /** The author or studio, as they credit themselves. */
  author: string;
  /** Where the author states the terms (their page, release note or license). */
  licenseUrl: string;
  /** Who checked it, and when (ISO date), for example "Rafael, 2026-11-02". */
  verifiedBy: string;
}

export const LOCADORA_ALLOWLIST: readonly AllowlistEntry[] = [];
