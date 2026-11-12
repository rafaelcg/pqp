/**
 * Posting a message into a channel the person is not looking at (a song's link
 * from the song panel into a text channel).
 *
 * The chat controller owns the socket's frames for the channel on screen: its
 * optimistic bubble, its failure timer, its retry. This is not that. It sends
 * the same `message-create` frame (the server posts it for a socket that never
 * joined the channel and answers that socket with the broadcast carrying the
 * nonce, or a `message-rejected` carrying it) and waits for the one answer, so
 * the picker can say "sent" or say why not. Nothing is queued: a message that
 * waited for a reconnect would arrive hours after somebody pressed a button
 * that said "sent".
 *
 * `App` owns the socket, so it registers the way to send and hands every frame
 * it receives to `settleShareFrame`.
 */

export interface ShareSender {
  isOnline(): boolean;
  send(frame: { type: "message-create"; channelId: string; body: string; nonce: string }): void;
}

export type ShareResult =
  | { ok: true }
  | { ok: false; reason: "offline" | "timeout" | "rate-limited" | "slow-mode" | "no-access" | "automod" | "other" };

const ANSWER_TIMEOUT_MS = 10_000;

let sender: ShareSender | null = null;
const pending = new Map<string, { resolve: (result: ShareResult) => void; timer: ReturnType<typeof setTimeout> }>();

/** `App` says how to send. Returns the way to take it back. */
export function registerShareSender(next: ShareSender | null): () => void {
  sender = next;
  return () => {
    if (sender === next) {
      sender = null;
    }
  };
}

function newNonce(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function reasonOf(raw: string | undefined): Extract<ShareResult, { ok: false }>["reason"] {
  switch (raw) {
    case "rate-limited":
    case "slow-mode":
    case "automod":
      return raw;
    case "no-access":
    case "cannot-send":
    case "locked":
      return "no-access";
    default:
      return "other";
  }
}

export function sendShareMessage(channelId: string, body: string): Promise<ShareResult> {
  if (!sender || !sender.isOnline()) {
    return Promise.resolve({ ok: false, reason: "offline" });
  }
  const nonce = newNonce();
  return new Promise<ShareResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(nonce);
      resolve({ ok: false, reason: "timeout" });
    }, ANSWER_TIMEOUT_MS);
    pending.set(nonce, { resolve, timer });
    sender!.send({ type: "message-create", channelId, body, nonce });
  });
}

/** Every frame `App` receives goes through here; true when it was the answer to a share. */
export function settleShareFrame(frame: { type: string; nonce?: string; reason?: string }): boolean {
  if (!frame.nonce || (frame.type !== "message-broadcast" && frame.type !== "message-rejected")) {
    return false;
  }
  const waiting = pending.get(frame.nonce);
  if (!waiting) {
    return false;
  }
  pending.delete(frame.nonce);
  clearTimeout(waiting.timer);
  waiting.resolve(frame.type === "message-broadcast" ? { ok: true } : { ok: false, reason: reasonOf(frame.reason) });
  return true;
}
