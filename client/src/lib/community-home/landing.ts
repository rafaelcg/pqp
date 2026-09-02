import type { Channel } from "@pqp/shared";
import { COMMUNITY_HOME_CHANNEL_ID } from "./id";

/**
 * What to open when entering a server with no channel in the URL.
 *
 * `communityHomeEnabled` is already the rollout flag AND this server's
 * persisted opt-in.
 *
 * Off: first text channel (today's behaviour).
 * On + community server: the Baú, every time. A community's front page is
 * the thing it publishes.
 * On + never opened this server's Baú: the Baú, once. This is what makes a
 * new member meet the welcome post instead of a chat log they have no
 * context for, and it is the whole reason a pinned post exists. `firstVisit`
 * comes from the same localStorage mark that drives the row's "New" chip, so
 * the two can never disagree.
 * On + private hall they have already visited: first text channel. The Baú is
 * a place you go back to, not a wall between you and the conversation.
 */
export function pickServerLandingTarget(
  channels: readonly Pick<Channel, "id" | "type">[],
  communityHomeEnabled: boolean,
  isCommunityServer = false,
  firstVisit = false,
): { kind: "home"; id: typeof COMMUNITY_HOME_CHANNEL_ID } | { kind: "channel"; id: string } | null {
  if (communityHomeEnabled && (isCommunityServer || firstVisit)) {
    return { kind: "home", id: COMMUNITY_HOME_CHANNEL_ID };
  }
  const general =
    channels.find((c) => c.type === "text") ??
    channels.find((c) => c.type !== "category");
  return general ? { kind: "channel", id: general.id } : null;
}
