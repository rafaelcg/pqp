/**
 * The offline outbox: messages typed while the socket was down, kept in
 * storage so a reload or a quit does not lose them.
 *
 * The transport already queues outbound chat in memory and flushes it on
 * reconnect. That queue dies with the tab, and `disconnect()` empties it, so
 * anything typed on a bad connection vanished the moment the page reloaded,
 * while the bubble had looked like every delivered one. This is the durable
 * half: `createChatController` writes every send here before it goes to the
 * transport, removes it when the server answers (broadcast or rejection),
 * and replays whatever is left every time the socket reports ready.
 *
 * Replaying is safe because the nonce is stored with the row and the server
 * treats a repeated nonce as the same message (`messages.nonce`, unique per
 * author and channel), so a double flush cannot post twice.
 *
 * Text and replies only. An attachment's `blob:` preview does not survive a
 * reload and its presigned upload is not worth chasing across sessions, so a
 * message carrying files is sent the way it always was and is not kept here.
 *
 * `localStorage` rather than IndexedDB on purpose: the store is at most
 * `MAX_ENTRIES` short rows, and a synchronous write is what makes "saved
 * before the tab closed" true without a beforeunload dance.
 */

export interface OutboxEntry {
  nonce: string;
  channelId: string;
  body: string;
  replyToId: string | null;
  /** When the user pressed Enter, so the bubble keeps its place. */
  createdAt: string;
}

const KEY_PREFIX = "pqp:outbox:";
const MAX_ENTRIES = 200;
/** A message older than this is stale enough that sending it would surprise. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function storageKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

function isEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.nonce === "string" &&
    typeof entry.channelId === "string" &&
    typeof entry.body === "string" &&
    (entry.replyToId === null || typeof entry.replyToId === "string") &&
    typeof entry.createdAt === "string"
  );
}

export function loadOutbox(userId: string, now = Date.now()): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isEntry).filter((entry) => {
      const at = Date.parse(entry.createdAt);
      return Number.isFinite(at) && now - at <= MAX_AGE_MS;
    });
  } catch {
    return [];
  }
}

export function saveOutbox(userId: string, entries: OutboxEntry[]): void {
  try {
    const key = storageKey(userId);
    if (entries.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    const kept = entries.slice(-MAX_ENTRIES);
    localStorage.setItem(key, JSON.stringify(kept));
  } catch {
    // Storage full or blocked: the in-memory queue still carries the send.
  }
}

/** A stable id per send, unlike a `Date.now()` counter that resets per session. */
export function createSendNonce(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
