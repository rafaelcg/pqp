import type { Channel } from "@pqp/shared";
import { COMMUNITY_HOME_CHANNEL_ID } from "./id";

/**
 * What to open when entering a server with no channel in the URL.
 *
 * `communityHomeEnabled` is already the rollout flag AND this server's
 * persisted opt-in.
 *
 * Off: first text channel (today's behaviour).
 * On: the Baú, every time. A server that turned the feed on is saying that
 * is the front door — community or private hall, first visit or tenth.
 * A URL that already names a channel still opens that channel; this only
 * runs when nothing in the address picked one.
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
