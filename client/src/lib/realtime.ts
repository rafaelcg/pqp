import type {
  ChatClientMessage,
  ChatServerMessage,
  VoiceClientMessage,
  VoiceSignalingMessage,
} from "@pqp/shared";
// The pure catalogue module, not `lib/i18n` — this file must not pull React
// into a transport.
import { translateMessage } from "@/lib/i18n";
import { getWsUrl } from "@/lib/utils";

type MessageHandler = (message: ChatServerMessage | VoiceSignalingMessage) => void;
type TokenProvider = () => Promise<string | null>;

export type RealtimeStatus =
  | "idle"
  | "connecting"
  | "online"
  | "reconnecting"
  | "unauthorized";

// Hosted proxies (Railway edge) drop idle WebSockets, so keep traffic flowing
// well under typical idle timeouts. A pong is expected each interval, but we
// only declare the link dead after MAX_MISSED_PONGS consecutive misses — one
// slow round-trip (mobile radio, a brief server event-loop stall) must not
// self-disconnect an otherwise healthy connection.
const PING_INTERVAL_MS = 20_000;
const MAX_MISSED_PONGS = 2;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
// Bound the offline outbound queues so a long disconnect can't grow memory
// without limit; overflow drops the oldest entries.
const MAX_CHAT_QUEUE = 200;
const MAX_VOICE_QUEUE = 100;
// The server admits a burst of 60 messages per connection, refilled at 20/s
// (server/src/ws/index.ts). The queues above can hold 300 between them, so a
// reconnect flush that dumps everything in one loop trips that limiter and the
// fresh socket is closed with 4429 — a reconnect-kill loop for exactly the
// flaky networks the queues exist to survive. Drain in paced chunks that leave
// headroom for live traffic (auth, rejoin, fresh signaling) instead.
const FLUSH_FIRST_BURST = 30;
const FLUSH_CHUNK = 8;
const FLUSH_INTERVAL_MS = 500;

function enqueueBounded<T>(queue: T[], message: T, max: number) {
  queue.push(message);
  if (queue.length > max) {
    queue.splice(0, queue.length - max);
  }
}

export interface RealtimeClose {
  code: number;
  reason: string;
  at: number;
}

export interface RealtimeTransport {
  connect(tokenProvider: TokenProvider): void;
  disconnect(): void;
  sendChat(message: ChatClientMessage): void;
  sendVoice(message: VoiceClientMessage): void;
  // Each on* setter holds a SINGLE handler and replaces any previous one — they
  // do not accumulate listeners. Re-registering (e.g. on a bootstrap retry) is
  // therefore idempotent, and auto-reconnects reuse the already-registered
  // handler without re-subscribing, so no side effect fires twice per event.
  onMessage(handler: MessageHandler): void;
  /**
   * Fires after every successful (re)connect. `reconnected` is false only for
   * the first connect of a session, so callers can re-subscribe and re-sync
   * state that went stale while the socket was down.
   */
  onReady(handler: (reconnected: boolean) => void | Promise<void>): void;
  onError(handler: (message: string) => void): void;
  /** Fired once when an established connection is lost (before reconnect attempts). */
  onClose(handler: () => void): void;
  /**
   * Token provider returned null after we had already been online.
   * Distinct from close 4401, which still retries with a refreshed token.
   */
  onAuthUnavailable(handler: () => void): void;
  /** Connection state for UI — drives the "reconnecting" banner. */
  onStatusChange(handler: (status: RealtimeStatus) => void): void;
  getStatus(): RealtimeStatus;
  /** Skip the backoff and try to connect right now (the banner's Retry). */
  retryNow(): void;
  /** The last socket close, for the connection check's report. */
  getLastClose(): RealtimeClose | null;
  /**
   * How many connects in a row ended in a refused or missing token. A
   * session that keeps being refused is not a blip and the UI should say so.
   */
  getUnauthorizedStreak(): number;
  isConnected(): boolean;
}

export function createRealtimeTransport(): RealtimeTransport {
  let socket: WebSocket | null = null;
  let handler: MessageHandler | null = null;
  let readyHandler: ((reconnected: boolean) => void | Promise<void>) | null = null;
  let errorHandler: ((message: string) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let authUnavailableHandler: (() => void) | null = null;
  let statusHandler: ((status: RealtimeStatus) => void) | null = null;
  let status: RealtimeStatus = "idle";
  let isReady = false;
  let hasConnectedOnce = false;
  let tokenProvider: TokenProvider | null = null;
  let manualClose = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let awaitingPong = false;
  let missedPongs = 0;
  const chatQueue: ChatClientMessage[] = [];
  const voiceQueue: VoiceClientMessage[] = [];
  let lastClose: RealtimeClose | null = null;
  let unauthorizedStreak = 0;

  function setStatus(next: RealtimeStatus) {
    if (status === next) {
      return;
    }
    status = next;
    statusHandler?.(next);
  }

  /**
   * Enter the in-flight state, but never downgrade "unauthorized" — why we are
   * retrying is more useful to the user than the fact that we are. Cleared by a
   * successful connect or an explicit disconnect.
   */
  function setPendingStatus() {
    if (status === "unauthorized") {
      return;
    }
    setStatus(hasConnectedOnce ? "reconnecting" : "connecting");
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function stopKeepalive() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    awaitingPong = false;
    missedPongs = 0;
  }

  function stopFlushTimer() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function startKeepalive(ws: WebSocket) {
    stopKeepalive();
    pingTimer = setInterval(() => {
      if (ws !== socket || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (awaitingPong) {
        // Previous ping went unanswered this interval — tolerate a few before
        // giving up, so a single latency spike doesn't drop a live connection.
        missedPongs += 1;
        if (missedPongs >= MAX_MISSED_PONGS) {
          // Half-open connection: the close event may never fire on its own.
          handleConnectionLoss(ws);
          ws.close();
          return;
        }
      }
      awaitingPong = true;
      ws.send(JSON.stringify({ type: "ping" }));
    }, PING_INTERVAL_MS);
  }

  function scheduleReconnect(immediate = false) {
    if (manualClose || reconnectTimer) {
      return;
    }
    setPendingStatus();
    const delay = immediate
      ? 0
      : Math.min(
          RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
          RECONNECT_MAX_DELAY_MS,
        );
    if (!immediate) {
      reconnectAttempt += 1;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectSocket();
    }, delay + (immediate ? 0 : Math.random() * 500));
  }

  function handleOnline() {
    // Network came back: skip the remaining backoff and retry now.
    if (!manualClose && reconnectTimer) {
      clearReconnectTimer();
      void connectSocket();
    }
  }

  function handleVisibility() {
    if (manualClose || document.visibilityState !== "visible") {
      return;
    }
    // Coming back to the foreground: background tabs throttle timers, so a
    // missed-pong count here is stale — reset it instead of dropping a link
    // that is actually fine. If the socket did die while hidden, reconnect now
    // rather than waiting out the backoff.
    awaitingPong = false;
    missedPongs = 0;
    if (!socket && reconnectTimer) {
      clearReconnectTimer();
      void connectSocket();
    }
  }

  // Idempotent per socket: reached from both the close event and pong timeout.
  function handleConnectionLoss(
    ws: WebSocket,
    authFailed = false,
    closeCode?: number,
  ) {
    if (ws !== socket) {
      return;
    }
    socket = null;
    const wasReady = isReady;
    isReady = false;
    stopKeepalive();
    // Anything still undrained stays queued for the next connection — except
    // voice signaling: queued offers/ICE would flush before join-voice-room
    // and race a session resume.
    stopFlushTimer();
    voiceQueue.length = 0;

    if (manualClose) {
      return;
    }

    if (authFailed) {
      // Still retried below — the token provider refreshes on the next attempt.
      unauthorizedStreak += 1;
      setStatus("unauthorized");
      errorHandler?.(translateMessage("connection.authFailed"));
      scheduleReconnect();
      return;
    }

    if (wasReady) {
      closeHandler?.();
    }
    setPendingStatus();
    errorHandler?.(translateMessage("connection.reconnecting"));
    scheduleReconnect(closeCode === 1001);
  }

  async function connectSocket() {
    if (!tokenProvider || manualClose || socket) {
      return;
    }

    setPendingStatus();

    let token: string | null = null;
    let tokenFetchFailed = false;
    try {
      token = await tokenProvider();
    } catch {
      tokenFetchFailed = true;
      token = null;
    }
    if (manualClose || socket) {
      return;
    }
    if (!token) {
      unauthorizedStreak += 1;
      setStatus("unauthorized");
      // Clerk returns null (or throws) when the refresh cannot run offline.
      // That is a blip, not sign-out. Hang up only when we are online and the
      // provider resolved to null — the session is actually gone.
      const offline =
        tokenFetchFailed ||
        (typeof navigator !== "undefined" && navigator.onLine === false);
      if (hasConnectedOnce && !offline) {
        authUnavailableHandler?.();
      }
      scheduleReconnect();
      return;
    }

    isReady = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(getWsUrl());
    } catch {
      // A malformed VITE_WS_URL throws here rather than firing an error event,
      // which would otherwise leave the transport silently idle forever.
      errorHandler?.(translateMessage("connection.wsUrlFailed"));
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.addEventListener("open", () => {
      if (ws === socket) {
        ws.send(JSON.stringify({ type: "auth", token }));
      }
    });

    ws.onmessage = (event) => {
      if (ws !== socket) {
        return;
      }
      try {
        const message = JSON.parse(event.data as string) as
          | { type: "ready" }
          | { type: "pong" }
          | ChatServerMessage
          | VoiceSignalingMessage;

        if (message.type === "pong") {
          awaitingPong = false;
          missedPongs = 0;
          return;
        }

        if (message.type === "ready") {
          isReady = true;
          reconnectAttempt = 0;
          unauthorizedStreak = 0;
          const reconnected = hasConnectedOnce;
          hasConnectedOnce = true;
          setStatus("online");
          startKeepalive(ws);
          // Join (and any other ready work) must go out before queued offers
          // / ICE from the outage. Those frames are dropped if they arrive
          // before this socket owns a peer. A sync handler still flushes in
          // this turn; a promise delays the flush until join is sent.
          const afterReady = readyHandler?.(reconnected);
          if (afterReady && typeof afterReady.then === "function") {
            void afterReady.finally(() => {
              if (ws === socket && isReady) {
                flushQueues();
              }
            });
          } else {
            flushQueues();
          }
          return;
        }

        handler?.(message);
      } catch {
        // ignore
      }
    };

    ws.onerror = () => {
      // Browsers fire close right after error, but not every runtime does
      // (and a socket that errors is done either way) — funnel both paths
      // through the same idempotent loss handler.
      if (ws === socket && !manualClose) {
        handleConnectionLoss(ws);
        try {
          ws.close();
        } catch {
          // already closing
        }
      }
    };

    ws.onclose = (event) => {
      lastClose = {
        code: event.code,
        reason: event.reason ?? "",
        at: Date.now(),
      };
      handleConnectionLoss(ws, event.code === 4401, event.code);
    };
  }

  /** Send up to `limit` queued messages; true when both queues are empty. */
  function drainChunk(ws: WebSocket, limit: number): boolean {
    let budget = limit;
    while (budget > 0 && chatQueue.length > 0) {
      ws.send(JSON.stringify(chatQueue.shift()));
      budget -= 1;
    }
    while (budget > 0 && voiceQueue.length > 0) {
      ws.send(JSON.stringify(voiceQueue.shift()));
      budget -= 1;
    }
    return chatQueue.length === 0 && voiceQueue.length === 0;
  }

  function flushQueues() {
    stopFlushTimer();
    if (!socket || socket.readyState !== WebSocket.OPEN || !isReady) {
      return;
    }
    const ws = socket;
    if (drainChunk(ws, FLUSH_FIRST_BURST)) {
      return;
    }
    const tick = () => {
      flushTimer = null;
      if (ws !== socket || ws.readyState !== WebSocket.OPEN || !isReady) {
        return;
      }
      if (!drainChunk(ws, FLUSH_CHUNK)) {
        flushTimer = setTimeout(tick, FLUSH_INTERVAL_MS);
      }
    };
    flushTimer = setTimeout(tick, FLUSH_INTERVAL_MS);
  }

  function sendOrQueueChat(message: ChatClientMessage) {
    // While a paced flush is draining, join the back of the queue — a direct
    // send would overtake older messages and spend the same rate budget.
    if (flushTimer === null && socket?.readyState === WebSocket.OPEN && isReady) {
      socket.send(JSON.stringify(message));
      return;
    }
    enqueueBounded(chatQueue, message, MAX_CHAT_QUEUE);
  }

  function sendOrQueueVoice(message: VoiceClientMessage) {
    if (flushTimer === null && socket?.readyState === WebSocket.OPEN && isReady) {
      socket.send(JSON.stringify(message));
      return;
    }
    // Voice signaling is ephemeral (peer ids reset on rejoin), so a small cap
    // is plenty — stale entries would just be ignored server-side anyway.
    enqueueBounded(voiceQueue, message, MAX_VOICE_QUEUE);
  }

  return {
    connect(provider: TokenProvider) {
      tokenProvider = provider;
      manualClose = false;
      hasConnectedOnce = false;
      window.addEventListener("online", handleOnline);
      document.addEventListener("visibilitychange", handleVisibility);
      void connectSocket();
    },

    disconnect() {
      manualClose = true;
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      clearReconnectTimer();
      stopKeepalive();
      reconnectAttempt = 0;
      socket?.close(1000);
      socket = null;
      isReady = false;
      tokenProvider = null;
      chatQueue.length = 0;
      voiceQueue.length = 0;
      setStatus("idle");
    },

    sendChat(message: ChatClientMessage) {
      sendOrQueueChat(message);
    },

    sendVoice(message: VoiceClientMessage) {
      sendOrQueueVoice(message);
    },

    onMessage(nextHandler: MessageHandler) {
      handler = nextHandler;
    },

    onReady(nextHandler: (reconnected: boolean) => void | Promise<void>) {
      readyHandler = nextHandler;
    },

    onError(nextHandler: (message: string) => void) {
      errorHandler = nextHandler;
    },

    onClose(nextHandler: () => void) {
      closeHandler = nextHandler;
    },

    onAuthUnavailable(nextHandler: () => void) {
      authUnavailableHandler = nextHandler;
    },

    onStatusChange(nextHandler: (status: RealtimeStatus) => void) {
      statusHandler = nextHandler;
    },

    getStatus() {
      return status;
    },

    retryNow() {
      if (manualClose || socket) {
        return;
      }
      clearReconnectTimer();
      reconnectAttempt = 0;
      void connectSocket();
    },

    getLastClose() {
      return lastClose;
    },

    getUnauthorizedStreak() {
      return unauthorizedStreak;
    },

    isConnected() {
      return socket?.readyState === WebSocket.OPEN && isReady;
    },
  };
}
