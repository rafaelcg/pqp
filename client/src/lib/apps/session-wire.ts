import {
  appServerFrameSchema,
  type AppClientFrame,
  type AppEndReason,
  type AppServerFrame,
  type BridgeConnectionStatus,
  type JsonValue,
} from "@pqp/shared";
import {
  AppTransportError,
  type AppErrorCode,
  type AppSessionHandlers,
  type AppSessionTransport,
  type SessionSnapshot,
} from "./types";

/**
 * THE APP SESSION OVER `/ws`.
 *
 * The frame host (`bridge-host.ts`) talks to a session through
 * `AppSessionTransport`; this is the implementation that puts those calls on
 * the page's one WebSocket and reads the answers back off it. Nothing in here
 * opens a socket: the owner of the realtime link gives the wire a `send`, feeds
 * it every server frame (`dispatch`) and tells it when the link drops and
 * returns, which is what keeps this file testable without a network.
 *
 * ONE RECORD PER SESSION. A session id is the key, and the transport handed
 * out for it is always the same object, because `AppFrame` treats a new
 * transport as a new frame.
 *
 * RESUME IS THE WIRE'S JOB, NOT THE HOST'S. The server holds a dropped seat for
 * 90 seconds and a second `app-join` from the same account takes it back with
 * the same seat id. So when the link returns the wire re-sends `app-join` for
 * every record that was seated, and the `app-session` snapshot that follows
 * tells the host to go back to `online`. The bridge host only ever sees
 * `reconnecting` and `online`.
 *
 * A STATE WRITE IS ANSWERED BY THE NEXT `app-state`. The server coalesces a
 * session's writes (last value wins) and broadcasts the result to everybody,
 * the writer included, so the first `app-state` after a patch is the answer to
 * it. Another seat's write can land in between and answer first; the revision
 * is still monotonic, which is all the bridge promises. A patch nobody answers
 * within `PATCH_TIMEOUT_MS` rejects `unavailable` rather than hanging the app.
 */

/** A join that never answers is a failure, not a spinner (mock 01 uses 8 s too). */
export const JOIN_TIMEOUT_MS = 8_000;
export const PATCH_TIMEOUT_MS = 6_000;

/**
 * What an app is told when the session ended while this tab could not hear:
 * the resume found nothing to resume. The page's own strip says "terminou"
 * without a cause in that case; the app only needs some reason.
 */
export const ENDED_WHILE_AWAY: AppEndReason = "idle";

export interface AppWireLink {
  /** Put one client frame on the socket. False when it could not be sent right now. */
  send(frame: AppClientFrame): boolean;
}

interface PendingJoin {
  resolve(snapshot: SessionSnapshot): void;
  reject(error: AppTransportError): void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingPatch {
  resolve(answer: { rev: number }): void;
  reject(error: AppTransportError): void;
  timer: ReturnType<typeof setTimeout>;
}

interface SessionRecord {
  sessionId: string;
  handlers: Set<AppSessionHandlers>;
  /** Holds a seat (or is asking for one): what a resume re-asks for. */
  seated: boolean;
  asSpectator: boolean;
  pendingJoin: PendingJoin | null;
  patches: PendingPatch[];
  /** What the handlers were last told about the link. */
  connection: BridgeConnectionStatus;
  transport: AppSessionTransport | null;
  end: () => Promise<void>;
}

export interface AppSessionWire {
  /** The transport for one session. Same object for the same id. */
  transportFor(sessionId: string, end: () => Promise<void>): AppSessionTransport;
  /**
   * Feed every server frame here. Returns true for a frame that is about a
   * session this wire holds (so a caller may stop it), false for anything else.
   */
  dispatch(message: { type: string }): boolean;
  /** The link to the server went down (false) or is up (true). */
  setOnline(online: boolean): void;
  /** The socket authenticated again: resume every seat. Call after `setOnline(true)`. */
  resume(): void;
  /** Whether this wire holds a seat in the session. */
  isSeated(sessionId: string): boolean;
  /** For the card: send `app-join` / `app-leave` without a record. */
  sendJoin(sessionId: string, options: { asSpectator?: boolean }): boolean;
  sendLeave(sessionId: string): boolean;
  /** Tests and sign-out: drop everything. */
  reset(): void;
}

export function createAppSessionWire(link: { current: AppWireLink | null }): AppSessionWire {
  const records = new Map<string, SessionRecord>();
  let online = true;

  const send = (frame: AppClientFrame): boolean => {
    try {
      return link.current?.send(frame) ?? false;
    } catch {
      return false;
    }
  };

  function recordFor(sessionId: string, end?: () => Promise<void>): SessionRecord {
    let record = records.get(sessionId);
    if (!record) {
      record = {
        sessionId,
        handlers: new Set(),
        seated: false,
        asSpectator: false,
        pendingJoin: null,
        patches: [],
        connection: "online",
        transport: null,
        end: end ?? (() => Promise.reject(new AppTransportError("unavailable"))),
      };
      records.set(sessionId, record);
    } else if (end) {
      record.end = end;
    }
    return record;
  }

  function settleJoin(record: SessionRecord, outcome: SessionSnapshot | AppTransportError) {
    const pending = record.pendingJoin;
    if (!pending) return;
    record.pendingJoin = null;
    clearTimeout(pending.timer);
    if (outcome instanceof AppTransportError) {
      pending.reject(outcome);
    } else {
      pending.resolve(outcome);
    }
  }

  function failPatches(record: SessionRecord, code: AppErrorCode, count = Infinity) {
    const failed = record.patches.splice(0, count);
    for (const patch of failed) {
      clearTimeout(patch.timer);
      patch.reject(new AppTransportError(code));
    }
  }

  function notifyConnection(record: SessionRecord, status: BridgeConnectionStatus) {
    if (record.connection === status) return;
    record.connection = status;
    for (const handlers of [...record.handlers]) handlers.onConnection(status);
  }

  function finish(record: SessionRecord, reason: AppEndReason) {
    settleJoin(record, new AppTransportError("ended"));
    failPatches(record, "ended");
    record.seated = false;
    for (const handlers of [...record.handlers]) handlers.onEnded(reason);
    records.delete(record.sessionId);
  }

  function handleFrame(frame: AppServerFrame): boolean {
    switch (frame.type) {
      case "app-session": {
        const record = records.get(frame.sessionId);
        if (!record) return false;
        const snapshot: SessionSnapshot = {
          sessionId: frame.sessionId,
          seatId: frame.seatId,
          role: frame.role,
          isHost: frame.isHost,
          state: frame.state,
          participants: frame.participants,
        };
        record.seated = true;
        settleJoin(record, snapshot);
        for (const handlers of [...record.handlers]) handlers.onSession(snapshot);
        if (online) notifyConnection(record, "online");
        return true;
      }
      case "app-state": {
        const record = records.get(frame.sessionId);
        if (!record) return false;
        for (const handlers of [...record.handlers]) handlers.onState(frame.rev, frame.value);
        const answered = record.patches.shift();
        if (answered) {
          clearTimeout(answered.timer);
          answered.resolve({ rev: frame.rev });
        }
        return true;
      }
      case "app-event": {
        const record = records.get(frame.sessionId);
        if (!record) return false;
        for (const handlers of [...record.handlers]) {
          handlers.onEvent({ fromSeatId: frame.fromSeatId, name: frame.name, data: frame.data });
        }
        return true;
      }
      case "app-ended": {
        const record = records.get(frame.sessionId);
        if (!record) return false;
        finish(record, frame.reason);
        return true;
      }
      case "app-error": {
        const record = records.get(frame.sessionId);
        if (!record) return false;
        if (frame.op === "join") {
          if (record.pendingJoin) {
            settleJoin(record, new AppTransportError(frame.code));
          } else if (record.seated && frame.code === "ended") {
            // a resume that found the session over
            finish(record, ENDED_WHILE_AWAY);
          } else if (record.seated && frame.code === "not-allowed") {
            // the seat is gone for good (lost the right to be here)
            finish(record, ENDED_WHILE_AWAY);
          }
        } else if (frame.op === "state") {
          failPatches(record, frame.code, 1);
        } else if (frame.code === "ended") {
          finish(record, ENDED_WHILE_AWAY);
        }
        return true;
      }
      default:
        return false;
    }
  }

  function makeTransport(record: SessionRecord): AppSessionTransport {
    return {
      join(options) {
        if (record.pendingJoin) {
          return Promise.reject(new AppTransportError("rate-limited"));
        }
        record.asSpectator = options.asSpectator === true;
        if (
          !online ||
          !send({
            type: "app-join",
            sessionId: record.sessionId,
            ...(record.asSpectator ? { asSpectator: true } : {}),
          })
        ) {
          return Promise.reject(new AppTransportError("unavailable"));
        }
        return new Promise<SessionSnapshot>((resolve, reject) => {
          const timer = setTimeout(() => {
            settleJoin(record, new AppTransportError("unavailable"));
          }, JOIN_TIMEOUT_MS);
          record.pendingJoin = { resolve, reject, timer };
        });
      },
      leave() {
        const wasSeated = record.seated;
        record.seated = false;
        failPatches(record, "unavailable");
        if (wasSeated || record.pendingJoin) {
          send({ type: "app-leave", sessionId: record.sessionId });
        }
        settleJoin(record, new AppTransportError("unavailable"));
      },
      patchState(patch: JsonValue, baseRev: number | undefined) {
        if (!online || !record.seated) {
          return Promise.reject(new AppTransportError("unavailable"));
        }
        const sent = send({
          type: "app-state-patch",
          sessionId: record.sessionId,
          ...(baseRev !== undefined ? { baseRev } : {}),
          patch,
        });
        if (!sent) return Promise.reject(new AppTransportError("unavailable"));
        return new Promise<{ rev: number }>((resolve, reject) => {
          const entry: PendingPatch = {
            resolve,
            reject,
            timer: setTimeout(() => {
              const at = record.patches.indexOf(entry);
              if (at >= 0) record.patches.splice(at, 1);
              reject(new AppTransportError("unavailable"));
            }, PATCH_TIMEOUT_MS),
          };
          record.patches.push(entry);
        });
      },
      sendEvent(name, data) {
        if (!online || !record.seated) return;
        send({ type: "app-event-send", sessionId: record.sessionId, name, data });
      },
      end() {
        return record.end();
      },
      subscribe(handlers) {
        record.handlers.add(handlers);
        // a late subscriber learns the link's state at once
        if (record.connection !== "online") handlers.onConnection(record.connection);
        return () => {
          record.handlers.delete(handlers);
          if (record.handlers.size === 0 && !record.seated && !record.pendingJoin) {
            records.delete(record.sessionId);
          }
        };
      },
    };
  }

  return {
    transportFor(sessionId, end) {
      const record = recordFor(sessionId, end);
      record.transport ??= makeTransport(record);
      return record.transport;
    },
    dispatch(message) {
      const parsed = appServerFrameSchema.safeParse(message);
      if (!parsed.success) return false;
      return handleFrame(parsed.data);
    },
    setOnline(next) {
      if (online === next) return;
      online = next;
      if (!next) {
        // A join in flight cannot complete on a dead link.
        for (const record of records.values()) {
          settleJoin(record, new AppTransportError("unavailable"));
          failPatches(record, "unavailable");
          if (record.seated) notifyConnection(record, "reconnecting");
        }
      }
    },
    resume() {
      if (!online) return;
      for (const record of records.values()) {
        if (!record.seated) continue;
        send({
          type: "app-join",
          sessionId: record.sessionId,
          ...(record.asSpectator ? { asSpectator: true } : {}),
        });
      }
    },
    isSeated(sessionId) {
      return records.get(sessionId)?.seated === true;
    },
    sendJoin(sessionId, options) {
      return send({
        type: "app-join",
        sessionId,
        ...(options.asSpectator ? { asSpectator: true } : {}),
      });
    },
    sendLeave(sessionId) {
      return send({ type: "app-leave", sessionId });
    },
    reset() {
      for (const record of [...records.values()]) {
        settleJoin(record, new AppTransportError("unavailable"));
        failPatches(record, "unavailable");
      }
      records.clear();
      online = true;
    },
  };
}
