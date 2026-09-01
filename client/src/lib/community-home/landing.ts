import type { Channel } from "@pqp/shared";
import { COMMUNITY_HOME_CHANNEL_ID } from "./id";

/**
 * What to open when entering a server with no channel in the URL.
 *
 * Flag off: first text channel (today's behaviour). Flag on: Community Home.
 * Pure so the flag-off path is pinned by a unit test without mounting App.
 */
export function pickServerLandingTarget(
  channels: readonly Pick<Channel, "id" | "type">[],
  communityHomeEnabled: boolean,
): { kind: "home"; id: typeof COMMUNITY_HOME_CHANNEL_ID } | { kind: "channel"; id: string } | null {
  if (communityHomeEnabled) {
    return { kind: "home", id: COMMUNITY_HOME_CHANNEL_ID };
  }
  const general =
    channels.find((c) => c.type === "text") ??
    channels.find((c) => c.type !== "category");
  return general ? { kind: "channel", id: general.id } : null;
}
