import { hasPermission, Permission } from "@pqp/shared";
import { computeMemberPermissions } from "../services/permissions.js";

export interface VoicePublishGrant {
  canSpeak: boolean;
  canStream: boolean;
}

/**
 * SPEAK and STREAM, resolved for one member in one voice room.
 *
 * THE ONE PLACE THE ANSWER COMES FROM. The WS join (`ws/voice.ts`), the SFU
 * token (`POST /api/voice/token`) and the live re-check after a permissions
 * change all call this, so they cannot disagree about who may talk or present.
 *
 * A conversation (DM or group call) has no roles and no overwrites, and its
 * participants are all equals: always true. A server voice channel resolves
 * the member's bits *with the channel's overwrites*. Owner and Administrator
 * resolve to every bit, so they can never lock themselves out.
 *
 * Permissive by default: a channel this cannot place (no server id) answers
 * true, so nothing that worked before these bits were enforced goes quiet.
 */
export async function resolveVoicePublish(
  channel: { kind?: string; server_id?: string | null } | null | undefined,
  channelId: string,
  userId: string,
): Promise<VoicePublishGrant> {
  if (!channel || channel.kind !== "server" || !channel.server_id) {
    return { canSpeak: true, canStream: true };
  }
  const perms = await computeMemberPermissions(
    channel.server_id,
    userId,
    channelId,
  );
  return {
    canSpeak: hasPermission(perms, Permission.SPEAK),
    canStream: hasPermission(perms, Permission.STREAM),
  };
}

export async function resolveCanSpeak(
  channel: { kind?: string; server_id?: string | null } | null | undefined,
  channelId: string,
  userId: string,
): Promise<boolean> {
  return (await resolveVoicePublish(channel, channelId, userId)).canSpeak;
}
