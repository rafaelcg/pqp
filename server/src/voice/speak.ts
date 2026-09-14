import {
  canStartWatchPartyStream,
  hasPermission,
  isWatchPartyChannelType,
  Permission,
} from "@pqp/shared";
import { computeMemberPermissions } from "../services/permissions.js";
import { loadWatchPartySeat } from "../services/watch-parties.js";

export interface VoicePublishGrant {
  canSpeak: boolean;
  canStream: boolean;
  /**
   * CONVIDADOS' third axis: true for an accepted guest of a live party whose
   * `guests` is not `off`. Only ever true alongside `canStream: false` — a
   * co-host or the host already carries `canStream: true`, which is a
   * superset. See `liveKitPublishGrant` in `backends.ts`.
   */
  canShowFace: boolean;
  /** `Permission.MANAGE_MUSIC`; true where there are no cargos. */
  canManageMusic: boolean;
}

/**
 * SPEAK and STREAM, resolved for one member in one voice room. In a
 * `watch_party` channel the stage is START_WATCH_PARTY instead of STREAM
 * (`canStartWatchPartyStream`), so the audience keeps its everyday bits and
 * still cannot present.
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
  channel:
    | {
        kind?: string;
        server_id?: string | null;
        type?: string | null;
        parent_id?: string | null;
      }
    | null
    | undefined,
  channelId: string,
  userId: string,
): Promise<VoicePublishGrant> {
  if (!channel || channel.kind !== "server" || !channel.server_id) {
    return { canSpeak: true, canStream: true, canShowFace: false, canManageMusic: true };
  }
  // Hand over the row when the caller has one. `type` and `parent_id` are the
  // only two columns the overwrite pass would otherwise re-read the channel
  // for, and every caller here already holds the row (the token mint resolved
  // access with it; the live re-check just fetched it). A caller with only an
  // id keeps the old behaviour.
  const perms = await computeMemberPermissions(
    channel.server_id,
    userId,
    channel.type === undefined
      ? channelId
      : {
          id: channelId,
          type: channel.type ?? null,
          parent_id: channel.parent_id ?? null,
        },
  );
  const canStream = canStartWatchPartyStream({
    channelType: channel.type ?? "voice",
    permissions: perms,
  });
  // Only worth asking on a watch-party channel, and only for somebody who
  // does not already carry STREAM (which is a superset — the host and every
  // co-host). `loadWatchPartySeat` is the same cached snapshot
  // `join-voice-room` already reads, so this costs nothing extra on the hot
  // path once the cache is warm.
  let canShowFace = false;
  if (!canStream && isWatchPartyChannelType(channel.type ?? "")) {
    const seat = await loadWatchPartySeat(channelId, userId);
    canShowFace = Boolean(seat?.isGuest && seat.guests !== "off");
  }
  return {
    canSpeak: hasPermission(perms, Permission.SPEAK),
    canStream,
    canShowFace,
    canManageMusic: hasPermission(perms, Permission.MANAGE_MUSIC),
  };
}

export async function resolveCanSpeak(
  channel: { kind?: string; server_id?: string | null } | null | undefined,
  channelId: string,
  userId: string,
): Promise<boolean> {
  return (await resolveVoicePublish(channel, channelId, userId)).canSpeak;
}
