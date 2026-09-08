import type { VoiceRoomTransport } from "@pqp/shared";

/**
 * WHEN A MESH ROOM MAY BE MOVED TO THE SFU, AND WHAT THAT COSTS THE BOX.
 *
 * `CAMERA_LIMIT.mesh` is three because a mesh camera is a full uplink copy per
 * peer: the fourth camera in a six-person mesh room asks each publisher for
 * roughly 7.5 Mbit/s of upload, which a home connection does not have. The
 * limit is right. What was wrong is what happened at it: the camera was
 * refused, and the room stayed on mesh only because its server has fewer than
 * `LARGE_SERVER_MEMBER_THRESHOLD` members, which is a guess about how many
 * people might show up and says nothing at all about how many of the five who
 * did want their faces on.
 *
 * So where LiveKit is configured the room moves to the SFU instead, and the
 * camera turns on. The SFU forwards rather than copying, so the same four
 * cameras cost each publisher one uplink.
 *
 * THE PART THAT IS NOT FREE. Every promoted room lands on one media box.
 * `docs/CAPACITY.md` measured the production box (4 vCPU, four UDP mux ports,
 * São Paulo) delivering 880 to 935 Mbit/s at 76% CPU, and breaking somewhere
 * between 500 and 600 subscribers of one 720p stream. A promotion is therefore
 * a spend, and a spend that a user makes by clicking a camera button. This
 * module is the budget.
 *
 * Nothing here talks to LiveKit or to Postgres: it is arithmetic on room
 * shapes, so the guard can be tested against numbers from the capacity
 * document rather than against a live SFU.
 */

/**
 * What one video publication costs, in and out, per participant.
 *
 * 1.5 Mbit/s is the large-room cap the client already applies above
 * `LARGE_ROOM_PARTICIPANTS` (`client/src/lib/video-quality.ts`), and the rate
 * every measured run in `docs/CAPACITY.md` was made at. A small room's camera
 * may ask for more (auto is 3 Mbit/s), so this is a floor, not a promise, and
 * the budget below is set well under the box's measured ceiling to absorb it.
 */
export const VIDEO_STREAM_MBPS = 1.5;

/**
 * The default ceiling, in Mbit/s of estimated SFU traffic, past which a room
 * is NOT promoted and the camera is refused as it was before.
 *
 * 600 against a box measured clean at 880 to 935. The margin is deliberate and
 * it is not conservatism for its own sake: the estimate below counts video
 * only, the box also carries every microphone and every screen share on it,
 * and the thing that breaks first (ladder F, `docs/CAPACITY.md` §4.5) does not
 * degrade gracefully: between 500 and 600 subscribers egress *falls* and a
 * quarter of the packets reach nobody. Refusing one camera is a message on one
 * screen. Overshooting is every call on the box at 27% packet loss.
 */
export const VOICE_PROMOTION_DEFAULT_MAX_MBPS = 600;

/** `VOICE_PROMOTION_MAX_SFU_MBPS`, or the default. Read per call, never cached. */
export function promotionBudgetMbps(): number {
  const raw = process.env.VOICE_PROMOTION_MAX_SFU_MBPS?.trim();
  if (!raw) {
    return VOICE_PROMOTION_DEFAULT_MAX_MBPS;
  }
  const parsed = Number(raw);
  // A typo must not silently uncap the box, and must not silently close it
  // either: an unreadable value is the default, exactly as if it were unset.
  if (!Number.isFinite(parsed) || parsed < 0) {
    return VOICE_PROMOTION_DEFAULT_MAX_MBPS;
  }
  return parsed;
}

/** One room on the SFU, as the load estimate reads it. */
export interface SfuRoomLoad {
  /** The voice channel id, so the candidate can be found in the list. */
  channelId: string;
  transport: VoiceRoomTransport;
  /** Seats in the room, orphans included: an orphan's media is still flowing. */
  participants: number;
  /** Seats publishing a camera or a screen share right now. */
  videoPublishers: number;
}

/**
 * What one room asks of the box: every publication, up once and down to
 * everybody.
 *
 * `publishers * participants` rather than `publishers * (participants - 1)`
 * because the publisher's own uplink is on the same box as the downlinks it
 * feeds, and the box's limit is the socket, not the direction. A six-person
 * room with four 720p cameras is 4 * 6 * 1.5 = 36 Mbit/s, which is the figure
 * the capacity document uses for exactly this shape (4 in, 20 out).
 */
export function estimateRoomMbps(room: SfuRoomLoad): number {
  if (room.transport !== "livekit") {
    return 0;
  }
  const publishers = Math.max(0, room.videoPublishers);
  const participants = Math.max(0, room.participants);
  return publishers * participants * VIDEO_STREAM_MBPS;
}

/** The whole box, as far as this cluster can see it. */
export function estimateSfuLoadMbps(rooms: readonly SfuRoomLoad[]): number {
  let total = 0;
  for (const room of rooms) {
    total += estimateRoomMbps(room);
  }
  return total;
}

export type PromotionRefusal =
  /** No `LIVEKIT_*` on this deployment: there is nowhere to promote to. */
  | "unconfigured"
  /** The SFU did not answer its own room listing. Do not send a call to it. */
  | "unreachable"
  /** The estimate, plus what this room would add, is over the budget. */
  | "budget";

export interface PromotionVerdict {
  promote: boolean;
  refusal: PromotionRefusal | null;
  /** Estimated Mbit/s already on the box, for the log line. */
  loadMbps: number;
  /** What this room would add once it is on the SFU, for the log line. */
  addedMbps: number;
  budgetMbps: number;
}

export interface PromotionInput {
  liveKitConfigured: boolean;
  /**
   * `readSfuStats().reachable`. `null` means the SFU was never probed (it is
   * not configured, or the process has not asked yet) and is not treated as a
   * failure: only an explicit `false` refuses.
   */
  sfuReachable: boolean | null;
  /** Every room the cluster knows about, this one included. */
  rooms: readonly SfuRoomLoad[];
  /** The room asking to be promoted, as it will look once the camera is on. */
  room: SfuRoomLoad;
  budgetMbps: number;
}

/**
 * Should this mesh room become an SFU room?
 *
 * The candidate room is priced as if it were already on LiveKit and added to
 * everything else the box is carrying, because that is the state the promotion
 * creates. `rooms` is the cluster's view and may already contain this room on
 * mesh; a mesh room costs the box nothing (`estimateRoomMbps` returns 0 for
 * one), so it is not double counted.
 */
export function decidePromotion(input: PromotionInput): PromotionVerdict {
  const loadMbps = estimateSfuLoadMbps(input.rooms);
  const addedMbps = estimateRoomMbps({ ...input.room, transport: "livekit" });
  const base = {
    loadMbps,
    addedMbps,
    budgetMbps: input.budgetMbps,
  };
  if (!input.liveKitConfigured) {
    return { ...base, promote: false, refusal: "unconfigured" };
  }
  if (input.sfuReachable === false) {
    return { ...base, promote: false, refusal: "unreachable" };
  }
  if (loadMbps + addedMbps > input.budgetMbps) {
    return { ...base, promote: false, refusal: "budget" };
  }
  return { ...base, promote: true, refusal: null };
}
