import type { Channel } from "@pqp/shared";
import { COMMUNITY_HOME_CHANNEL_ID } from "./id";

/**
 * What to open when entering a server with no channel in the URL.
 *
 * A community always lands on Overview (the Baú pane with the identity
 * header). A private hall still needs the server's own Baú opt-in.
 * A URL that already names a channel still opens that channel; this only
 * runs when nothing in the address picked one.
 */
export function pickServerLandingTarget(
  channels: readonly Pick<Channel, "id" | "type">[],
  communityHomeEnabled: boolean,
  isCommunity: boolean,
): { kind: "home"; id: typeof COMMUNITY_HOME_CHANNEL_ID } | { kind: "channel"; id: string } | null {
  if (isCommunity || communityHomeEnabled) {
    return { kind: "home", id: COMMUNITY_HOME_CHANNEL_ID };
  }
  const general =
    channels.find((c) => c.type === "text") ??
    channels.find((c) => c.type !== "category");
  return general ? { kind: "channel", id: general.id } : null;
}
