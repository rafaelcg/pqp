/**
 * Who can walk into a server without being invited, as plain logic, so the
 * panel, the server header and the rail all answer the question the same way
 * and a test can pin the rules the screens draw.
 *
 * It exists because the setting was invisible. An owner turned a private test
 * server into a public community (address plus directory), nothing in the UI
 * said so afterwards, and weeks later a stranger joined through the directory.
 * The phones got the same two answers in the same words (Android
 * `CommunityAccess`, iOS `CommunitySettings`).
 */

/** How open the room is right now, in the four states the screens name. */
export type CommunityVisibility =
  | "private"
  /** `pqp.gg/c/<slug>` answers: whoever holds the link joins with one tap. */
  | "public"
  /** Also in the directory: any account can find it and join. */
  | "listed"
  /** The operator pulled the page and the listing; nobody can walk in. */
  | "suspended";

export function communityVisibility(settings: {
  isCommunity: boolean;
  isListed?: boolean;
  suspended?: boolean;
}): CommunityVisibility {
  if (!settings.isCommunity) {
    return "private";
  }
  // The switches are still on, but nobody can walk in, and saying otherwise
  // would be a lie.
  if (settings.suspended) {
    return "suspended";
  }
  return settings.isListed ? "listed" : "public";
}

/**
 * Whether a server wears the "Public" mark in the header and on the rail.
 *
 * The address is what lets a stranger in, so it is the test; the directory only
 * makes the room easier to find. Gated on the instance having communities on,
 * because with them off the address answers 404 and the mark would be a lie.
 *
 * KNOWN GAP: the member's own server list does not say whether the operator
 * suspended the room (only the settings panel reads that), so a suspended
 * community still wears the mark to members until the list carries it.
 */
export function isServerPublic(
  server: { isCommunity?: boolean } | null | undefined,
  communitiesEnabled: boolean,
): boolean {
  return communitiesEnabled && server?.isCommunity === true;
}

/** Which door a save is about to open. */
export type DoorOpening = "address" | "directory" | "both";

/**
 * The doors this save would OPEN, or null when it opens none.
 *
 * Only the direction that lets strangers in asks for a second thought. Turning
 * a switch off is never confirmed: closing a door needs no hesitation, and a
 * dialog there would only slow down undoing a mistake.
 */
export function doorsOpening(
  saved: { isCommunity: boolean; isListed: boolean },
  next: { isCommunity: boolean; isListed: boolean },
): DoorOpening | null {
  const address = !saved.isCommunity && next.isCommunity;
  const directory = !saved.isListed && next.isListed;
  if (address && directory) {
    return "both";
  }
  if (address) {
    return "address";
  }
  if (directory) {
    return "directory";
  }
  return null;
}
