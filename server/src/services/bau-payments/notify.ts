import type { BauPlusUpdateMessage } from "@pqp/shared";
import { isBusEnabled, publishToCluster, subscribeToCluster } from "../../lib/bus.js";
import { forEachSocketOfUser } from "../../ws/sockets.js";

/**
 * `bau-plus-update` to the fan's own sockets, on every instance. The worker
 * runs the sweep and has no sockets, so the bus is what reaches the fan there;
 * the local half covers the single-process deployment with the bus off.
 * Fire and forget: the durable state is the membership row, which the client
 * re-reads on reconnect and on focus.
 */

const TOPIC = "bau-plus.update";

interface Envelope {
  userId: string;
  frame: BauPlusUpdateMessage;
}

function deliverLocally(envelope: Envelope): void {
  const payload = JSON.stringify(envelope.frame);
  forEachSocketOfUser(envelope.userId, (socket) => {
    if (socket.readyState === 1) {
      socket.send(payload);
    }
  });
}

subscribeToCluster(TOPIC, (data) => {
  const envelope = data as Partial<Envelope> | null;
  if (
    !envelope ||
    typeof envelope.userId !== "string" ||
    !envelope.frame ||
    envelope.frame.type !== "bau-plus-update"
  ) {
    return;
  }
  deliverLocally(envelope as Envelope);
});

export function notifyBauPlusUpdate(
  userId: string,
  frame: Omit<BauPlusUpdateMessage, "type">,
): void {
  const envelope: Envelope = { userId, frame: { type: "bau-plus-update", ...frame } };
  try {
    deliverLocally(envelope);
    if (isBusEnabled()) {
      publishToCluster(TOPIC, envelope);
    }
  } catch (error) {
    console.error("[bau-payments] update notice failed:", error);
  }
}
