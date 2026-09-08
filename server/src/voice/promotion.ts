<<<<<<< HEAD
import {
  MESH_ROOM_PROMOTION_SIZE,
  type VoiceRoomTransport,
} from "@pqp/shared";
=======
import { LARGE_ROOM_PARTICIPANTS, type VoiceRoomTransport } from "@pqp/shared";
>>>>>>> dfccc56e (Unlimited screens on the voice server, and a mesh limit that is measured)

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
 * What one CAMERA costs, in and out, per participant.
 *
 * 1.5 Mbit/s is the top of the camera ladder on Auto (`cameraBitrateFor` in
 * `client/src/lib/video-quality.ts`), which is the rung nearly every camera in
 * this product is on, and the rate every measured run in `docs/CAPACITY.md`
 * was made at. An explicit 1080p camera asks for 2.5, so this is a working
 * figure rather than a hard worst case, and the budget below is set well under
 * the box's measured ceiling to absorb the difference.
 */
export const CAMERA_STREAM_MBPS = 1.5;

/**
 * Kept under its old name so nothing that only ever meant a camera has to
 * change. New code should say which of the two it means.
 */
export const VIDEO_STREAM_MBPS = CAMERA_STREAM_MBPS;

/**
 * What one SCREEN SHARE costs, in and out, per participant, in a room small
 * enough that the presenter may spend what they like.
 *
 * A SHARE IS NOT A CAMERA AND PRICING IT AS ONE WAS WRONG BY A FACTOR OF
 * NEARLY THREE. `SCREEN_BITRATES["1080p"]` is 4 Mbit/s and Auto is 3, against
 * a camera's 1.5, and the reason is in `video-quality.ts`: a talking head is a
 * still background with a moving oval and inter-frame prediction eats it
 * alive, while a shared screen is a game or a film or scrolling text, which is
 * full-frame motion with hard edges the codec cannot blur. 4 rather than 3
 * because the budget prices the worst case a presenter can actually ask for,
 * and 1080p is one menu item away.
 */
export const SCREEN_STREAM_MBPS = 4;

/**
 * What one screen share costs in a room above `LARGE_ROOM_PARTICIPANTS`.
 *
 * The client holds the top layer to `LARGE_ROOM_SCREEN_BITRATE` there unless
 * 1080p was chosen by name (`screenSimulcastPlan`), and a big room is exactly
 * where the multiplication by the audience makes the number matter. Pricing
 * every large room at 4 Mbit/s would have refused a hundred-person watch party
 * that the box carries comfortably, which is the opposite mistake to the one
 * this constant fixes.
 */
export const LARGE_ROOM_SCREEN_MBPS = 1.5;

/** What a share in a room of this size is charged, in Mbit/s per participant. */
export function screenStreamMbps(participants: number): number {
  return participants > LARGE_ROOM_PARTICIPANTS
    ? LARGE_ROOM_SCREEN_MBPS
    : SCREEN_STREAM_MBPS;
}

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

/**
 * How many people in a mesh room move it to the SFU, or `null` for "never on
 * size alone". `VOICE_PROMOTION_ROOM_SIZE`, or `MESH_ROOM_PROMOTION_SIZE`.
 * Read per call, never cached, so tonight's number can change without a deploy.
 *
 * `0` is the off switch and the reason this returns a nullable: the trigger is
 * new, it fires on ordinary joins rather than on a click, and something that
 * cannot be turned off in one command should not be shipped an hour before a
 * peak. Anything under 2 is also off, because a threshold of 1 would move a
 * room the moment one person opened it, which is every call.
 *
 * An unreadable value is the default, exactly as if it were unset: the same
 * rule as `promotionBudgetMbps`, and for the same reason. A typo must not
 * silently change the shape of the night.
 */
export function promotionRoomSize(): number | null {
  const raw = process.env.VOICE_PROMOTION_ROOM_SIZE?.trim();
  if (!raw) {
    return MESH_ROOM_PROMOTION_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return MESH_ROOM_PROMOTION_SIZE;
  }
  if (parsed < 2) {
    return null;
  }
  return Math.floor(parsed);
}

/** One room on the SFU, as the load estimate reads it. */
export interface SfuRoomLoad {
  /** The voice channel id, so the candidate can be found in the list. */
  channelId: string;
  transport: VoiceRoomTransport;
  /** Seats in the room, orphans included: an orphan's media is still flowing. */
  participants: number;
  /** Seats publishing a camera right now. */
  cameraPublishers: number;
  /**
   * Seats sharing a screen right now, counted apart from the cameras because
   * a share costs the box several times what a face does. One person doing
   * both is in both counts, which is right: they publish two tracks.
   */
  screenPublishers: number;
}

/**
 * What one room asks of the box: every publication, up once and down to
 * everybody, each charged at what its own kind actually costs.
 *
 * `publishers * participants` rather than `publishers * (participants - 1)`
 * because the publisher's own uplink is on the same box as the downlinks it
 * feeds, and the box's limit is the socket, not the direction. A six-person
 * room with four 720p cameras is 4 * 6 * 1.5 = 36 Mbit/s, which is the figure
 * the capacity document uses for exactly this shape (4 in, 20 out). The same
 * room with one share instead is 1 * 6 * 4 = 24, and that difference is the
 * whole reason the two counts are kept apart: pricing that share as a camera
 * said 9.
 */
export function estimateRoomMbps(room: SfuRoomLoad): number {
  if (room.transport !== "livekit") {
    return 0;
  }
  const participants = Math.max(0, room.participants);
  const cameras = Math.max(0, room.cameraPublishers);
  const screens = Math.max(0, room.screenPublishers);
  return (
    participants *
    (cameras * CAMERA_STREAM_MBPS + screens * screenStreamMbps(participants))
  );
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
  | "budget"
  /** The channel is pinned to mesh by hand. An operator chose that. */
  | "mesh-override"
  /** The client at the door cannot run LiveKit, so the move would not seat it. */
  | "joiner-cannot-follow";

export interface JoinPromotionGate {
  /** `channels.voice_transport`: the operator's explicit choice, or null. */
  channelOverride: VoiceRoomTransport | null;
  /** The transports the client at the door declared in its `join-voice-room`. */
  joinerCapabilities: readonly VoiceRoomTransport[];
}

/**
 * The two things that stop a JOIN from moving a mesh room, before the box is
 * ever priced. Both belong to the join-triggered promotions (`room-full` and
 * `room-size`), so they live beside the budget rather than inside it.
 *
 * `mesh-override` is the important one. The transport a room opens on is
 * usually a policy guess (server size), and a guess is exactly what a
 * promotion is allowed to correct. `channels.voice_transport = 'mesh'` is not
 * a guess: it is the channel settings dialog's "Small, peer-to-peer", chosen
 * by somebody with Manage Channels, most often to keep a private call off a
 * shared media box. A person at the door does not get to overrule that; they
 * get exactly what they got before this existed.
 *
 * `joiner-cannot-follow` is arithmetic, not policy. The trigger here is one
 * person's join, so a promotion that cannot seat that person (a mesh-only
 * client) spends the box, moves everybody, and still turns them away, or in
 * the room-size case admits nobody and evicts the joiner instead. Refusing
 * leaves the room where it is, and the next capable joiner moves it.
 *
 * Returns null when neither applies, and the ordinary budget guard decides.
 */
export function blockJoinPromotion(
  gate: JoinPromotionGate,
): PromotionRefusal | null {
  if (gate.channelOverride === "mesh") {
    return "mesh-override";
  }
  if (!gate.joinerCapabilities.includes("livekit")) {
    return "joiner-cannot-follow";
  }
  return null;
}

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
  const budget = decideVideoAdmission({
    rooms: input.rooms,
    room: input.room,
    budgetMbps: input.budgetMbps,
  });
  const base = {
    loadMbps: budget.loadMbps,
    addedMbps: budget.addedMbps,
    budgetMbps: input.budgetMbps,
  };
  if (!input.liveKitConfigured) {
    return { ...base, promote: false, refusal: "unconfigured" };
  }
  if (input.sfuReachable === false) {
    return { ...base, promote: false, refusal: "unreachable" };
  }
  if (!budget.admit) {
    return { ...base, promote: false, refusal: "budget" };
  }
  return { ...base, promote: true, refusal: null };
}

// --------------------------------------------------- admission on a live room

/**
 * THE SAME BUDGET, ASKED BY A ROOM THAT IS ALREADY ON THE BOX.
 *
 * `CAMERA_LIMIT.livekit` used to be eight. Eight was ours: it matched the mesh
 * room size because that number was lying around, and it described nothing
 * about the box. The SFU forwards, so the ninth camera costs its publisher one
 * uplink exactly like the first, and refusing it bought nobody anything. What
 * the ninth camera does cost is egress, once per viewer, and egress is what
 * this module already prices for a promotion. So the count is gone and the
 * price is the rule in both places.
 *
 * WHY THE ROOM IS PRICED WHOLE RATHER THAN INCREMENTALLY. The room asking is
 * removed from the box's total and added back at what it will cost with the
 * new publication, because `estimateRoomMbps` is `publishers x participants`:
 * a new camera in a twenty-person room adds twenty downstreams, not one, and
 * an increment that forgets the multiplier is the kind of arithmetic that
 * looks right until the room is large.
 *
 * WHY A LIAR GAINS NOTHING. `VIDEO_STREAM_MBPS` is the top of the camera
 * ladder (`cameraBitrateFor("auto")` is 1.5 Mbit/s), and the estimate charges
 * every participant for every publisher at that rate. A viewer whose client
 * reports a huge tile, or which ignores the ladder entirely and demands the
 * top layer for all of them, is therefore already paid for: the budget prices
 * the worst case, and simulcast and adaptive streaming only ever spend less
 * than it. Nothing here trusts a number the client sent.
 */
export interface VideoAdmissionInput {
  /** Every room the cluster can see, this one included, as it stands now. */
  rooms: readonly SfuRoomLoad[];
  /** The room asking, priced as it WILL be once the publication lands. */
  room: SfuRoomLoad;
  budgetMbps: number;
}

export interface VideoAdmissionVerdict {
  admit: boolean;
  /** Estimated Mbit/s on the box excluding the asking room, for the log line. */
  loadMbps: number;
  /** What the asking room will cost once the publication lands. */
  addedMbps: number;
  budgetMbps: number;
}

/**
 * May one more camera (or share) go up in this room?
 *
 * A budget of zero closes the box, which is the documented way to stop new
 * video without a deploy; a negative or unreadable env value never reaches
 * here (`promotionBudgetMbps` turns it back into the default).
 */
export function decideVideoAdmission(
  input: VideoAdmissionInput,
): VideoAdmissionVerdict {
  const others = input.rooms.filter(
    (room) => room.channelId !== input.room.channelId,
  );
  const loadMbps = estimateSfuLoadMbps(others);
  const addedMbps = estimateRoomMbps({ ...input.room, transport: "livekit" });
  return {
    admit: loadMbps + addedMbps <= input.budgetMbps,
    loadMbps,
    addedMbps,
    budgetMbps: input.budgetMbps,
  };
}
