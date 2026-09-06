import { hasPermission, Permission } from "@pqp/shared";
import { computeMemberPermissions } from "../services/permissions.js";

/**
 * `Permission.SPEAK`, resolved for one member in one voice room.
 *
 * THE ONE PLACE THE ANSWER COMES FROM. The WS join (`ws/voice.ts`), the SFU
 * token (`POST /api/voice/token`) and the live re-check after a permissions
 * change all call this, so they cannot disagree about who may talk.
 *
 * A conversation (DM or group call) has no roles and no overwrites, and its
 * participants are all equals: always true. A server voice channel resolves
 * the member's bits *with the channel's overwrites*, which is what lets an
 * owner make a stage: deny SPEAK for @everyone on the channel, allow it for a
 * moderator role. Owner and Administrator resolve to every bit, so they can
 * never lock themselves out.
 *
 * Permissive by default: a channel this cannot place (no server id) answers
 * true, so nothing that worked before SPEAK was enforced goes quiet.
 */
export async function resolveCanSpeak(
  channel: { kind?: string; server_id?: string | null } | null | undefined,
  channelId: string,
  userId: string,
): Promise<boolean> {
  if (!channel || channel.kind !== "server" || !channel.server_id) {
    return true;
  }
  const perms = await computeMemberPermissions(
    channel.server_id,
    userId,
    channelId,
  );
  return hasPermission(perms, Permission.SPEAK);
}
