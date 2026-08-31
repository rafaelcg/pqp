import { createHmac, timingSafeEqual } from "node:crypto";
import type { VoiceRoomTransport } from "@pqp/shared";

/**
 * HMAC that proves a resume belongs to the user who was issued the peer id.
 *
 * `peerId` is on every roster. After a process restart the in-memory map is
 * empty, so "claim this unused uuid" would let whoever saw the roster take
 * the slot and force the real owner into a cold join (which drops their
 * audio). The token is the proof. It is derived from `CLERK_SECRET_KEY`,
 * which production already has, so a merge does not need a new Fly secret.
 * Invalid or missing tokens are a cold join, never a 500.
 */

export const VOICE_RESUME_TTL_MS = 90_000;

interface ResumeClaims {
  v: 1;
  u: string;
  p: string;
  c: string;
  t: VoiceRoomTransport;
  e: number;
}

export interface VerifiedResume {
  userId: string;
  peerId: string;
  voiceChannelId: string;
  transport: VoiceRoomTransport;
}

function resumeSecret(): string | null {
  if (process.env.CLERK_SECRET_KEY) {
    return process.env.CLERK_SECRET_KEY;
  }
  if (process.env.DEV_AUTH_BYPASS === "true") {
    return "pqp-dev-voice-resume";
  }
  return null;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function mintVoiceResumeToken(input: {
  userId: string;
  peerId: string;
  voiceChannelId: string;
  transport: VoiceRoomTransport;
  now?: number;
}): string | null {
  const secret = resumeSecret();
  if (!secret) {
    return null;
  }
  const now = input.now ?? Date.now();
  const claims: ResumeClaims = {
    v: 1,
    u: input.userId,
    p: input.peerId,
    c: input.voiceChannelId,
    t: input.transport,
    e: now + VOICE_RESUME_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyVoiceResumeToken(
  token: string | undefined,
  expected: { userId: string; peerId: string; voiceChannelId: string },
  now = Date.now(),
): VerifiedResume | null {
  if (!token) {
    return null;
  }
  const secret = resumeSecret();
  if (!secret) {
    return null;
  }
  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!equal(mac, sign(payload, secret))) {
    return null;
  }
  let claims: ResumeClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as ResumeClaims;
  } catch {
    return null;
  }
  if (claims.v !== 1 || claims.e < now) {
    return null;
  }
  if (claims.t !== "mesh" && claims.t !== "livekit") {
    return null;
  }
  if (
    claims.u !== expected.userId ||
    claims.p !== expected.peerId ||
    claims.c !== expected.voiceChannelId
  ) {
    return null;
  }
  return {
    userId: claims.u,
    peerId: claims.p,
    voiceChannelId: claims.c,
    transport: claims.t,
  };
}
