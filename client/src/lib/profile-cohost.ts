/**
 * "Promover a co-host" on the member card.
 *
 * Every product we looked at adds a moderator FROM THE PERSON, in the moment
 * (Twitch: click the name in chat, Add Moderator), not from a list in a setup
 * form. The options dialog keeps its co-host list; this is the same action
 * where a host is already looking at somebody. Pure, so the rule is testable
 * without the card.
 */

import {
  canPerformWatchPartyAction,
  type WatchParty,
} from "@pqp/shared";

export type ProfileCohostAction = "promote" | "demote";

export function cohostActionFor(input: {
  party: WatchParty | null | undefined;
  subjectId: string;
  currentUserId: string | null;
}): ProfileCohostAction | null {
  const { party, subjectId, currentUserId } = input;
  if (!party || subjectId === currentUserId || subjectId === party.hostUserId) {
    return null;
  }
  const may = canPerformWatchPartyAction({
    action: "promoteCohost",
    role: party.viewerRole,
    state: party.state,
  });
  if (!may) {
    return null;
  }
  return party.cohosts.some((cohost) => cohost.userId === subjectId)
    ? "demote"
    : "promote";
}
