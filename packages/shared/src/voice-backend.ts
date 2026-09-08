import { z } from "zod";
import type { VoiceRoomTransport } from "./signaling.js";

export type VoiceBackendType = "mesh" | "cloudflare-sfu" | "livekit";

export interface VoiceBackendConfig {
  type: VoiceBackendType;
  cloudflareAppId?: string;
  cloudflareAppSecret?: string;
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
}

export const MESH_VOICE_LIMIT = 8;
export const MESH_VOICE_WARNING = 6;

/**
 * How many people have to be in a mesh room before it moves to the media
 * server, whatever the room's size policy said when it opened.
 *
 * WHY THIS EXISTS AT ALL. Every cap a small call meets is a mesh cap:
 * `CAMERA_LIMIT.mesh` is 3 and `SCREEN_SHARE_LIMIT.mesh` is 2, both because a
 * mesh encodes one copy per peer, so the fourth camera in a six-person room
 * asks each publisher for about 7.5 Mbit/s of upload that a home connection in
 * Brazil does not have. The room moves to the SFU when somebody hits one of
 * those, which works but makes the caps something people meet, in the middle
 * of a call, as a refusal. Moving earlier means nobody meets them.
 *
 * WHY FOUR. Rafael's line: "a 2 or 3 person call is fine. 4 or 5 becomes a
 * proper thing. I want people to be able to share screen or use webcam." Four
 * is where a call stops being a chat and starts being an event, and it is also
 * exactly where the mesh arithmetic turns: three cameras is the mesh limit, so
 * a room of four is the first size at which somebody is told no.
 *
 * WHY NOT LOWER. Two and three person calls stay peer to peer on purpose.
 * Direct is one hop instead of two, so it is the lowest latency path we have;
 * it costs the media box nothing; and it keeps working if the box does not.
 * Most calls are this size, so this is also what keeps the box's load
 * proportional to the calls that actually need it.
 *
 * The server may override this with `VOICE_PROMOTION_ROOM_SIZE` (see
 * `promotionRoomSize` in `server/src/voice/promotion.ts`), which is a tuning
 * knob, not a second policy: `0` turns the trigger off. The constant is the
 * default and the number the client reasons about.
 */
export const MESH_ROOM_PROMOTION_SIZE = 4;

/**
 * How many people may share a screen in one call at the same time.
 *
 * MESH IS A NUMBER THE LINK DECIDES, and `2` here is only what is assumed of a
 * link nobody has measured. See `meshVideoLimit` below: a mesh share is a full
 * copy per viewer off one uplink, so what a room can hold is a fact about that
 * uplink and about how many people are in the room, and two was a guess that
 * ignored both. It stays as the fallback because a client that reports nothing
 * must behave exactly as it did before this existed.
 *
 * LIVEKIT IS `null`, MEANING "NOT A HEADCOUNT", for the same reason
 * `CAMERA_LIMIT.livekit` is. A presenter on the voice server uploads once
 * whatever the room size, so a fifth share costs its publisher no more than
 * the first. What it does cost is egress, once per viewer, and that is priced
 * per room by `server/src/voice/promotion.ts` and refused there when the box
 * is full. Four was Zoom's number, not this box's.
 */
export const SCREEN_SHARE_LIMIT = {
  mesh: 2,
  livekit: null,
} as const satisfies Record<VoiceRoomTransport, number | null>;

/**
 * How many people may publish a camera in one call at the same time.
 *
 * MESH IS THREE AND IT IS PHYSICS. A mesh camera is another full-size video
 * uplink per peer, so the fourth camera in a six-person room asks each
 * publisher for roughly 7.5 Mbit/s of upload, which a home connection does not
 * have. That number is not ours to move, and the answer at it is the
 * promotion in `server/src/ws/voice.ts`: the room goes to the voice server and
 * the camera turns on.
 *
 * LIVEKIT IS `null`, MEANING "NOT A HEADCOUNT". It used to be eight, and eight
 * was ours rather than the box's: it matched the mesh room size because that
 * was a number lying around, not because a ninth camera costs anything a
 * publisher cannot pay. On the voice server a publisher uploads once whatever
 * the room size, so the only real ceilings are the box's egress, each viewer's
 * downlink and each viewer's decode, and none of those is a count of
 * publishers. The first is priced per room by `server/src/voice/promotion.ts`
 * and refused there. The second and third are the client's, and they are
 * answered by publishing a simulcast ladder
 * (`client/src/lib/video-quality.ts`) and by bounding how many tiles a grid
 * draws (`client/src/components/voice/stage-layout.ts`), not by telling the
 * ninth person their face is not welcome.
 *
 * `null` is deliberately not a very large number. A consumer has to say what
 * it does without a count, and every one of them has a different honest
 * answer: the server prices the box, and the client stops drawing a limit it
 * cannot state.
 */
export const CAMERA_LIMIT = {
  mesh: 3,
  livekit: null,
  // `satisfies` rather than an annotation, so `CAMERA_LIMIT.mesh` stays a
  // number for the callers that only ever mean mesh, while the exhaustiveness
  // over `VoiceRoomTransport` that an annotation buys is kept: a third
  // transport still has to answer this question.
} as const satisfies Record<VoiceRoomTransport, number | null>;

// ------------------------------------------ what a mesh room's link can hold

/**
 * The two things a mesh room may hold several of at once.
 *
 * Kept apart because a screen and a face do not cost the same. A shared screen
 * is full-frame motion with text in it; a talking head is a still background
 * with a moving oval. The same label costs roughly twice as much on the first.
 */
export type MeshVideoKind = "screens" | "cameras";

/**
 * What a mesh room is assumed to be able to spend on upload when nobody has
 * measured it, in bits per second.
 *
 * The same 5 Mbit/s as `DEFAULT_SCREEN_UPLOAD_BUDGET_BPS` in
 * `client/src/lib/screen-upload-budget.ts`, and it is the same number for the
 * same reason: it is what every share in this product got before anything was
 * measured. `voice-backend.test.ts` pins the two together.
 */
export const MESH_DEFAULT_UPLINK_BPS = 5_000_000;

/**
 * The window a reported uplink is believed inside of, in bits per second.
 *
 * THIS IS THE ANSWER TO "WHAT IF THE CLIENT LIES". A report is a number a
 * browser sends, so it is a number somebody can edit. Clamping it here means
 * the largest possible lie is `MESH_UPLINK_MAX_BPS`, which is exactly what an
 * honest person on fibre already reports: a liar therefore cannot obtain
 * anything a truthful fibre user is not already given, and cannot obtain it at
 * anybody else's expense either, because a mesh publication is uploaded by the
 * person publishing it and by nobody else. On the voice server, where the cost
 * IS shared, no client number is read at all (`decideVideoAdmission`).
 *
 * The bounds mirror `MIN_SCREEN_UPLOAD_BUDGET_BPS` and
 * `MAX_SCREEN_UPLOAD_BUDGET_BPS`, the floor and ceiling the client's own
 * budget controller already runs between.
 */
export const MESH_UPLINK_MIN_BPS = 1_000_000;
export const MESH_UPLINK_MAX_BPS = 16_000_000;

/**
 * The least a copy of each kind may be given before it stops being worth
 * sending, in bits per second.
 *
 * Both sit just above the bottom rung of their own SFU ladder
 * (`SCREEN_SIMULCAST_RUNGS` is 450 kbps at 360p, `CAMERA_SIMULCAST_RUNGS` is
 * 400 kbps at 360p), because that rung is the smallest picture this product is
 * willing to call a picture. Below it a share is unreadable text and a camera
 * is a smear, and a room that can only afford that has not got room for one
 * more of them.
 */
export const MESH_COPY_FLOOR_BPS: Record<MeshVideoKind, number> = {
  screens: 800_000,
  cameras: 500_000,
};

/**
 * The most a mesh room may hold whatever the link says.
 *
 * WHY A CEILING AT ALL, when the number below is derived. Because the
 * derivation reads an UPLINK and the thing a fourth share also costs is every
 * viewer's DOWNLINK and every viewer's decode, and no browser reports those.
 * Four screens is roughly 10 Mbit/s down and four simultaneous video decodes;
 * six cameras is about 6 Mbit/s and six decodes. Past that a mesh room is the
 * wrong tool, and the right answer is the one the promotion path already gives
 * (`server/src/ws/voice.ts`): move the room to the voice server, where a
 * publisher uploads once and the ceiling stops being about anybody's link.
 */
export const MESH_VIDEO_HARD_LIMIT: Record<MeshVideoKind, number> = {
  screens: 4,
  cameras: 6,
};

export interface MeshVideoLimitInput {
  kind: MeshVideoKind;
  /** Seats in the room, the publisher included. */
  roomSize: number;
  /**
   * The room's measured upload budget in bit/s, or null when nothing has been
   * measured. Null is not "assume the worst": it is "behave exactly as this
   * product did before any of this existed", which is `SCREEN_SHARE_LIMIT.mesh`
   * and `CAMERA_LIMIT.mesh`.
   */
  uplinkBps: number | null;
}

/**
 * HOW MANY CAMERAS OR SHARES A MESH ROOM MAY HOLD, GIVEN THE LINK.
 *
 * `SCREEN_SHARE_LIMIT.mesh` was 2 and `CAMERA_LIMIT.mesh` was 3, for every
 * room, on every connection, forever. Both are the same shape of mistake as
 * the constant `screen-upload-budget.ts` replaced: a fair guess about a
 * typical Brazilian home connection, applied as a rule to links that are
 * nothing like it in both directions. A three-person call on fibre was held to
 * two shares with tens of megabits going spare; an eight-person call on 4G was
 * allowed three cameras, which is twenty-one uplink copies, and the call fell
 * apart while every number in the product said it was fine.
 *
 * THE ARITHMETIC. A mesh publication is encoded once per viewer, so one
 * publication into a room of `n` costs its publisher `(n - 1)` copies. A room
 * whose measured budget is `B` can therefore carry `B / ((n - 1) * floor)`
 * publications at the smallest picture worth sending.
 *
 * AND WHAT THAT ARITHMETIC DOES NOT MODEL, said plainly because it is the
 * honest limit of this function. The uplink cost of one publication does not
 * actually depend on how many OTHER people are publishing: my copies are mine.
 * What does depend on it is every participant's downlink and decode, and
 * nothing in a browser reports those. So the room's own upload budget is used
 * as a proxy for the room's links generally. That proxy is conservative in the
 * only direction that matters, because no domestic connection has more upload
 * than download, and it is bounded above by `MESH_VIDEO_HARD_LIMIT`, which is
 * where the unmeasurable half is accounted for.
 *
 * NEVER BELOW ONE. A weak link is not refused its first share. A weak link
 * gets a smaller picture, which is what the budget controller has done since
 * PR 340 and does continuously; what this governs is the second and beyond,
 * where making the picture smaller has stopped being enough.
 *
 * THE NUMBER IS NOT A WALL where there is a voice server to move to. Reaching
 * it is what asks the server to promote the room, and on the hosted deployment
 * that is the usual outcome, which is why a limit that falls in a big room is
 * a better outcome rather than a worse one: the room stops copying and starts
 * forwarding.
 */
export function meshVideoLimit(input: MeshVideoLimitInput): number {
  const budget = clampReportedUplinkBps(input.uplinkBps);
  if (budget === null) {
    return input.kind === "screens"
      ? SCREEN_SHARE_LIMIT.mesh
      : CAMERA_LIMIT.mesh;
  }
  // One viewer minimum: a 1:1 call has one copy, and dividing by zero here
  // would hand a two-person call an infinite allowance.
  const viewers = Math.max(1, Math.floor(input.roomSize) - 1);
  const affordable = Math.floor(
    budget / (viewers * MESH_COPY_FLOOR_BPS[input.kind]),
  );
  return Math.max(1, Math.min(MESH_VIDEO_HARD_LIMIT[input.kind], affordable));
}

/**
 * A reported uplink, believed only as far as it is worth believing.
 *
 * Returns null for anything that is not a usable number, so a malformed or
 * absent report reads as "nothing was measured" rather than as zero, which
 * would refuse everybody.
 */
export function clampReportedUplinkBps(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return Math.min(MESH_UPLINK_MAX_BPS, Math.max(MESH_UPLINK_MIN_BPS, raw));
}

/**
 * The narrowest link the room has told us about.
 *
 * WHY THE NARROWEST AND NOT THE CLAIMANT'S OWN. Both readings are defensible
 * and this one is the safer of the two: a mesh publication has to be received
 * by everybody, so a room whose weakest member is on 4G cannot hold what its
 * fibre members could hold between themselves. Taking the minimum also removes
 * the only thing an inflated report could otherwise buy, because a bigger
 * number cannot lower a minimum somebody else has already set.
 *
 * Seats that have reported nothing are skipped rather than counted as the
 * default, so one iOS client (which does not report) does not pin a room of
 * web clients to the old constant.
 */
export function narrowestUplinkBps(
  reports: readonly (number | null | undefined)[],
): number | null {
  let narrowest: number | null = null;
  for (const report of reports) {
    const clamped = clampReportedUplinkBps(report);
    if (clamped === null) {
      continue;
    }
    narrowest = narrowest === null ? clamped : Math.min(narrowest, clamped);
  }
  return narrowest;
}

/**
 * The room size above which a presenter's top layer is held down, shared with
 * the server so the budget guard can price a share at what it will actually
 * cost rather than at what a small room's share costs.
 *
 * Lived in `client/src/lib/video-quality.ts` until the server needed it, and
 * is re-exported from there so every existing import still reads. The reason
 * for the number is in that file, where the client-side rule that applies it
 * lives.
 */
export const LARGE_ROOM_PARTICIPANTS = 20;

export function getDefaultVoiceBackend(
  deployment: "hosted" | "selfhost",
): VoiceBackendType {
  return deployment === "hosted" ? "cloudflare-sfu" : "livekit";
}

/**
 * Request for an SFU session. `peerId` is the id the WS voice room assigned in
 * its `welcome` message — reusing it as the SFU participant identity keeps
 * roster, speaking rings, and occupancy keyed consistently across both paths.
 */
export const voiceSessionRequestSchema = z.object({
  voiceChannelId: z.string().uuid(),
  peerId: z.string().uuid(),
  /**
   * The resume HMAC `welcome` handed out for this peer id. Optional, and
   * older clients never send it: without it the server proves ownership
   * against its own peer map, which is exact on a single instance. With more
   * than one API instance the HTTP request may land on a machine that never
   * saw this peer, and the HMAC (which already binds user, peer and channel)
   * is the proof that works from anywhere.
   */
  resumeToken: z.string().min(1).optional(),
});

export const voiceSessionSchema = z.object({
  backend: z.enum(["livekit"]),
  /** Media server websocket URL the client connects to. */
  url: z.string(),
  token: z.string(),
  /** SFU room name (the voice channel id). */
  room: z.string(),
  identity: z.string(),
  /**
   * Whether the token allows a microphone publish (`Permission.SPEAK`).
   * Absent reads as true.
   */
  speak: z.boolean().optional(),
  /**
   * Whether the token allows camera or screen share (`Permission.STREAM`).
   * Absent reads as `speak`.
   */
  stream: z.boolean().optional(),
});

export type VoiceSessionRequest = z.infer<typeof voiceSessionRequestSchema>;
export type VoiceSessionInfo = z.infer<typeof voiceSessionSchema>;
