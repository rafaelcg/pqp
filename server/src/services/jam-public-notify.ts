import { jamPublicNoticeSchema, type JamPublicNotice } from "@pqp/shared";
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
  notice: Omit<JamPublicNotice, "type" | "trackId" | "reason" | "admitted"> & {
    trackId?: string | null;
    reason?: string | null;
    admitted?: boolean;
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
