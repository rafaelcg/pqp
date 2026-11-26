import {
  jamPublicNoticeSchema,
  jamTakeDecisionSchema,
  type JamInstrument,
  type JamPublicNotice,
  type JamTakeDecision,
} from "@pqp/shared";
import { isBusEnabled, publishToCluster, subscribeToCluster } from "../lib/bus.js";
import { forEachSocketOfUser } from "../ws/sockets.js";

/**
 * `jam-public-notice` (packages/shared/src/jam-public.ts, LIVE FRAME): to ONE
 * account, on every socket it holds, on every instance. The `notifyBotNotice`
 * arrangement: this machine's sockets now, the cluster bus for the sibling's
 * (`CLUSTER_BUS=postgres` in production). Fire-and-forget: a lost notice is a
 * nudge not given, never lost state, because every notice points at a durable
 * read (`/api/jam-public/consents`, `/inbox`, `/mine`).
 */

const TOPIC = "jam.public-notice";

/** Test seam: every notice sent from this process. */
const sent: Array<{ userId: string; notice: JamPublicNotice }> = [];
export function takeJamPublicNoticesForTests(): Array<{ userId: string; notice: JamPublicNotice }> {
  return sent.splice(0);
}

function deliver(userId: string, notice: JamPublicNotice): void {
  const payload = JSON.stringify(notice);
  forEachSocketOfUser(userId, (socket) => {
    if (socket.readyState === 1) {
      socket.send(payload);
    }
  });
}

export function notifyJamPublic(
  userId: string,
  notice: Omit<JamPublicNotice, "type" | "trackId" | "reason" | "admitted" | "instrument"> & {
    trackId?: string | null;
    reason?: string | null;
    admitted?: boolean;
    instrument?: JamInstrument | null;
  },
): void {
  const frame: JamPublicNotice = {
    type: "jam-public-notice",
    kind: notice.kind,
    songId: notice.songId,
    title: notice.title,
    trackId: notice.trackId ?? null,
    reason: notice.reason ?? null,
    admitted: notice.admitted ?? false,
    instrument: notice.instrument ?? null,
  };
  if (sent.length < 1000) {
    sent.push({ userId, notice: frame });
  }
  try {
    deliver(userId, frame);
    if (isBusEnabled()) {
      publishToCluster(TOPIC, { frame, userId });
    }
  } catch (error) {
    console.error("[jam-public] notice failed:", error instanceof Error ? error.message : error);
  }
}

subscribeToCluster(TOPIC, (data) => {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const parsed = jamPublicNoticeSchema.safeParse(record?.frame);
  if (!parsed.success || typeof record?.userId !== "string") {
    return;
  }
  deliver(record.userId, parsed.data);
});

// ------------------------------------------------------- the sender's frame

/**
 * `jam-take-decision` (packages/shared/src/jam-public.ts, TAKE NOTICES): to the
 * person who sent a take, on every socket, on every instance, when the starter
 * accepted or refused it. A nudge like the one above: the durable item is
 * `GET /api/jam-public/notices`, so a lost frame is a card that shows on the
 * next read. Called once, by the instance that handled the starter's request.
 */
const DECISION_TOPIC = "jam.take-decision";

const decisionsSent: Array<{ userId: string; frame: JamTakeDecision }> = [];
export function takeJamTakeDecisionsForTests(): Array<{ userId: string; frame: JamTakeDecision }> {
  return decisionsSent.splice(0);
}

export function notifyJamTakeDecision(userId: string, frame: Omit<JamTakeDecision, "type">): void {
  const full: JamTakeDecision = { type: "jam-take-decision", ...frame };
  if (decisionsSent.length < 1000) {
    decisionsSent.push({ userId, frame: full });
  }
  try {
    const payload = JSON.stringify(full);
    forEachSocketOfUser(userId, (socket) => {
      if (socket.readyState === 1) {
        socket.send(payload);
      }
    });
    if (isBusEnabled()) {
      publishToCluster(DECISION_TOPIC, { frame: full, userId });
    }
  } catch (error) {
    console.error("[jam-public] decision notice failed:", error instanceof Error ? error.message : error);
  }
}

subscribeToCluster(DECISION_TOPIC, (data) => {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const parsed = jamTakeDecisionSchema.safeParse(record?.frame);
  if (!parsed.success || typeof record?.userId !== "string") {
    return;
  }
  const payload = JSON.stringify(parsed.data);
  forEachSocketOfUser(record.userId, (socket) => {
    if (socket.readyState === 1) {
      socket.send(payload);
    }
  });
});
