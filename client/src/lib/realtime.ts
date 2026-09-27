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
import { onNetworkHint } from "@/lib/network-hints";
import {
  freshKeepaliveState,
  KEEPALIVE_TICK_MS,
  keepaliveAction,
  noteInbound,
  noteNetworkUp,
  noteProbeSent,
  notePingSent,
  OPEN_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  reconnectCauseForClose,
  reconnectDelayMs,
  resetInFlight,
  STALE_CONNECT_MS,
  TOKEN_ABANDON_MS,
  TOKEN_TIMEOUT_MS,
  type KeepaliveMode,
  type KeepaliveState,
  type ReconnectCause,
} from "@/lib/realtime-liveness";

type MessageHandler = (message: ChatServerMessage | VoiceSignalingMessage) => void;
type TokenProvider = () => Promise<string | null>;

export type RealtimeStatus =
  | "idle"
  | "connecting"
  | "online"
  | "reconnecting"
  | "unauthorized";

/**
 * Optional wire features this build understands, declared on the `auth` frame.
 *
 * The server sends the old frames to anything that does not ask, which is what
 * lets a wire change ship without waiting for the packaged desktop shell and
 * the two app stores. An entry here is a promise about THIS bundle, so it is
 * only added once the handler for the frame is in the same bundle.
 *
 * `voice-roster-delta`: send what changed in a voice room instead of the whole
 * room. Handled in `hooks/use-voice.ts`; the convergence rule it must obey is
 * on `voiceRosterDeltaMessageSchema` in `@pqp/shared`.
 *
 * `presence-delta`: send who arrived and who left a channel instead of every
 * viewer of it. Handled in `hooks/use-chat.ts`, under the same convergence
 * rule, written out on `presenceDeltaSchema` in `@pqp/shared`.
 *
 * `mesh-resume`: this build keeps its MESH peer connections alive across a
 * signalling drop and comes back to the same peer id, so the server may hold
 * its seat for the resume window. Browsers can do this and phones cannot, and
 * an iOS build that claimed otherwise spent 2026-09-08 leaving a phantom in
 * every DM call. `join-voice-room.resume` is the older, coarser promise and
 * stays exactly as it was; this one scopes it to the transport where it is
 * hard to keep. Nothing changes for a LiveKit room, whose media is a separate
 * connection that survives on its own.
 *
 * `voice-transport-changed`: this build can move its own media from a peer
 * mesh onto the voice server, mid-call, without rejoining. Handled in
 * `hooks/use-voice.ts`. A socket that does not declare it is released from a
 * promoted room instead of being left on a mesh nobody else is on.
 *
 * `sfu-region`: this build dials whatever media server URL
 * `POST /api/voice/token` names (`session.url` into `Room.connect`, see
 * `lib/livekit-session.ts`) and never a host of its own. With SFU regions on,
 * the server only moves a room off the home box when the room's FIRST joiner
 * declared this; see `server/src/voice/regions.ts`.
 */
const WIRE_CAPS = [
  "voice-roster-delta",
  "presence-delta",
  "voice-transport-changed",
  "mesh-resume",
  "sfu-region",
] as const;

// The timing rules (keepalive, connect timeouts, reconnect delay) live in
// `realtime-liveness.ts` as pure functions, with the incident that shaped
// them. Re-exported so callers and tests keep one import.
export { reconnectDelayMs } from "@/lib/realtime-liveness";

const PING_FRAME = JSON.stringify({ type: "ping" });

// Bound the offline outbound queues so a long disconnect can't grow memory
// without limit; overflow drops the oldest entries.
const MAX_CHAT_QUEUE = 200;
const MAX_VOICE_QUEUE = 100;
// The server admits a burst of 60 messages per connection, refilled at 20/s
// (server/src/ws/frame-budget.ts; WebRTC offer/answer/ICE frames draw from a
// separate, larger relay bucket and do not count here). The queues above can hold 300 between them, so a
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
  /**
   * True while this tab holds a voice seat. Switches the keepalive to the
   * fast profile (`KEEPALIVE_PROFILES` in `realtime-liveness.ts`), so a dead
   * link under a call is found in about ten seconds, not half a minute.
   */
  setCallActive(active: boolean): void;
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
  /** Open, then ready, deadline for the attempt in flight. */
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectStartedAt = 0;
  let keepalive: KeepaliveState | null = null;
  let keepaliveMode: KeepaliveMode = "normal";
  /** When the link was lost, for the fast-retry window; null while online. */
  let lossStartedAt: number | null = null;
  /**
   * Why the pending reconnect is waiting. Only a `network` wait may be cut
   * short by evidence that the network is back: a drain's spread protects the
   * server from every tab at once, and a refusal's backoff protects it from
   * being hammered, and neither is about this tab's link.
   */
  let pendingCause: ReconnectCause | null = null;
  /**
   * The token request still out, and when it started. A request that hung
   * past `TOKEN_TIMEOUT_MS` is not called again on every retry, or a long
   * outage piles one more stuck refresh up per attempt; the next attempt
   * waits on the same one, until it is old enough to give up on.
   */
  let tokenInFlight: Promise<string | null> | null = null;
  let tokenInFlightSince = 0;
  let unsubscribeHints: (() => void) | null = null;
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
    pendingCause = null;
  }

  function clearConnectTimer() {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  function stopKeepalive() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    keepalive = null;
  }

  function stopFlushTimer() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  /**
   * This socket is gone as far as we are concerned, whatever the browser
   * thinks: a half-open TCP connection never fires `close` on its own, and
   * the closing handshake `close()` starts can take as long again. Detach
   * first so nothing waits on it.
   */
  function declareDead(ws: WebSocket) {
    handleConnectionLoss(ws, false, "network");
    try {
      ws.close();
    } catch {
      // already closing
    }
  }

  function sendPing(ws: WebSocket, probe: boolean) {
    if (!keepalive) {
      return;
    }
    try {
      ws.send(PING_FRAME);
    } catch {
      declareDead(ws);
      return;
    }
    if (probe) {
      noteProbeSent(keepalive, Date.now());
    } else {
      notePingSent(keepalive, Date.now());
    }
  }

  function startKeepalive(ws: WebSocket) {
    stopKeepalive();
    keepalive = freshKeepaliveState(Date.now());
    // A tick, not a ping interval: the schedule is `keepaliveAction`'s, and
    // evaluating it every second is what lets the fast profile find a dead
    // link in about ten seconds. The tick itself sends nothing unless the
    // socket has been silent.
    pingTimer = setInterval(() => {
      if (ws !== socket || ws.readyState !== WebSocket.OPEN || !keepalive) {
        return;
      }
      const action = keepaliveAction(keepalive, Date.now(), keepaliveMode);
      if (action === "dead") {
        declareDead(ws);
      } else if (action === "ping") {
        sendPing(ws, false);
      }
    }, KEEPALIVE_TICK_MS);
  }

  /**
   * Something outside the socket says the network may have changed. One ping
   * with a short deadline settles whether this socket survived it.
   */
  function probe() {
    const ws = socket;
    if (manualClose || !ws || !isReady || !keepalive) {
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      declareDead(ws);
      return;
    }
    if (keepalive.probeDeadlineAt !== null) {
      return; // one probe at a time
    }
    sendPing(ws, true);
  }

  /**
   * Evidence that the network works right now (the browser's `online`, media
   * reconnecting). Whatever the transport is waiting on BECAUSE OF THE
   * NETWORK, stop waiting. A drain spread or a refusal backoff stays: media
   * recovering says nothing about the server that closed us, and every tab
   * in a call would otherwise hear the same hint and reconnect together.
   */
  function networkIsUp(source: "browser" | "media") {
    if (manualClose) {
      return;
    }
    const ws = socket;
    if (!ws) {
      // The browser's own `online` / visible is about this machine alone, so
      // it may cut an abnormal-close spread short too. A media hint may not:
      // every tab in a call hears one, and the spread is what keeps a crash's
      // worth of tabs from reaching auth together.
      const skippable =
        pendingCause === "network" ||
        (source === "browser" && pendingCause === "abnormal");
      if (reconnectTimer && skippable) {
        clearReconnectTimer();
        void connectSocket();
      }
      return;
    }
    if (
      !isReady &&
      ws.readyState === WebSocket.CONNECTING &&
      Date.now() - connectStartedAt >= STALE_CONNECT_MS
    ) {
      // Most likely dialled on the network that just went away, and would
      // otherwise sit out its open timeout. Redo it on the one that is here.
      declareDead(ws);
      clearReconnectTimer();
      void connectSocket();
      return;
    }
    if (isReady && keepalive) {
      // Pings still unanswered now that the network is back: a socket that
      // survived answers within a round trip, so stop waiting for the full
      // deadline (`UP_GRACE_MS`).
      noteNetworkUp(keepalive, Date.now());
    }
  }

  /**
   * `cause` picks the schedule in `reconnectDelayMs`: a drain gets the deploy
   * spread, a loss this tab detected retries at once, a 1005 / 1006 close
   * within 1.5 s (a crash sends it to every tab at once), both then quickly,
   * and a refusal (auth, rate limit, a deliberate close) keeps the slow
   * backoff.
   */
  function scheduleReconnect(cause: ReconnectCause = "refused") {
    if (manualClose || reconnectTimer) {
      return;
    }
    setPendingStatus();
    const now = Date.now();
    if (lossStartedAt === null) {
      lossStartedAt = now;
    }
    const delay = reconnectDelayMs(reconnectAttempt, cause, now - lossStartedAt);
    reconnectAttempt += 1;
    pendingCause = cause;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      pendingCause = null;
      void connectSocket();
    }, delay);
  }

  function handleOnline() {
    // Network came back: this is the user's own connectivity returning. A
    // retry waiting on the network goes now; a drain spread or a refusal
    // backoff is left alone (`networkIsUp`).
    // A socket that looks open may be the pre-outage one, dead on an address
    // this machine no longer has: probe it.
    networkIsUp("browser");
    probe();
  }

  function handleVisibility() {
    if (manualClose || document.visibilityState !== "visible") {
      return;
    }
    // Coming back to the foreground: background tabs throttle timers, so an
    // in-flight ping count here is stale. Forget it rather than dropping a
    // link that is actually fine, and probe instead: a laptop that slept or a
    // phone that switched networks while this tab was hidden comes back to a
    // socket that is dead, and the probe finds that out in seconds.
    if (keepalive) {
      resetInFlight(keepalive);
    }
    networkIsUp("browser");
    probe();
  }

  function handleNetworkHint(hint: "up" | "suspect") {
    if (hint === "up") {
      networkIsUp("media");
    } else {
      probe();
    }
  }

  // Idempotent per socket: reached from the close event, the keepalive, a
  // connect timeout and a failed send.
  function handleConnectionLoss(
    ws: WebSocket,
    authFailed = false,
    cause: ReconnectCause = "network",
  ) {
    if (ws !== socket) {
      return;
    }
    socket = null;
    const wasReady = isReady;
    isReady = false;
    stopKeepalive();
    clearConnectTimer();
    if (wasReady) {
      lossStartedAt = Date.now();
    }
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
      scheduleReconnect("refused");
      return;
    }

    if (wasReady) {
      closeHandler?.();
    }
    setPendingStatus();
    errorHandler?.(translateMessage("connection.reconnecting"));
    scheduleReconnect(cause);
  }

  /** The token, null for "no session", or "timeout" for a provider that hung. */
  async function resolveToken(
    provider: TokenProvider,
  ): Promise<string | null | "timeout"> {
    const now = Date.now();
    if (!tokenInFlight || now - tokenInFlightSince >= TOKEN_ABANDON_MS) {
      // One request at a time: a retry after a timeout waits on the request
      // that is still out instead of stacking another beside it. Clerk's
      // `getToken` takes no abort signal, so this is the only bound there is.
      const call = provider();
      tokenInFlight = call;
      tokenInFlightSince = now;
      const settle = () => {
        if (tokenInFlight === call) {
          tokenInFlight = null;
        }
      };
      call.then(settle, settle);
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), TOKEN_TIMEOUT_MS);
    });
    try {
      return await Promise.race([tokenInFlight, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  function armConnectTimer(ws: WebSocket, ms: number) {
    clearConnectTimer();
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (ws === socket && !isReady) {
        declareDead(ws);
      }
    }, ms);
  }

  async function connectSocket() {
    if (!tokenProvider || manualClose || socket) {
      return;
    }

    setPendingStatus();

    let token: string | null = null;
    let tokenFetchFailed = false;
    let tokenTimedOut = false;
    try {
      const resolved = await resolveToken(tokenProvider);
      if (resolved === "timeout") {
        tokenTimedOut = true;
      } else {
        token = resolved;
      }
    } catch {
      tokenFetchFailed = true;
      token = null;
    }
    if (manualClose || socket) {
      return;
    }
    if (tokenTimedOut) {
      // A hung refresh is the network, not the session: no "unauthorized",
      // no hang-up, just the next attempt on the fast schedule.
      scheduleReconnect("network");
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
      scheduleReconnect(offline ? "network" : "refused");
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
      scheduleReconnect("refused");
      return;
    }
    socket = ws;
    connectStartedAt = Date.now();
    // Without a bound, an attempt made while the network was down waits out
    // the operating system's connect timeout (75 s on macOS), and the attempt
    // that would have worked waits behind it.
    armConnectTimer(ws, OPEN_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      if (ws === socket) {
        armConnectTimer(ws, READY_TIMEOUT_MS);
        ws.send(JSON.stringify({ type: "auth", token, caps: WIRE_CAPS }));
      }
    });

    ws.onmessage = (event) => {
      if (ws !== socket) {
        return;
      }
      // Any frame proves the link, so a busy socket never needs a ping.
      if (keepalive) {
        noteInbound(keepalive, Date.now());
      }
      try {
        const message = JSON.parse(event.data as string) as
          | { type: "ready" }
          | { type: "pong" }
          | ChatServerMessage
          | VoiceSignalingMessage;

        if (message.type === "pong") {
          return;
        }

        if (message.type === "ready") {
          isReady = true;
          clearConnectTimer();
          reconnectAttempt = 0;
          lossStartedAt = null;
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
        declareDead(ws);
      }
    };

    ws.onclose = (event) => {
      lastClose = {
        code: event.code,
        reason: event.reason ?? "",
        at: Date.now(),
      };
      handleConnectionLoss(
        ws,
        event.code === 4401,
        reconnectCauseForClose(event.code),
      );
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

  /**
   * Send now if the socket is ready and nothing is queued ahead; false means
   * the caller queues. A send that finds the socket already closing, or that
   * throws, is the link telling us it is gone before `close` has fired (or
   * when it never will): act on it now rather than at the next keepalive.
   */
  function trySendNow(message: ChatClientMessage | VoiceClientMessage): boolean {
    const ws = socket;
    if (!ws || !isReady || flushTimer !== null) {
      return false;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      if (ws.readyState !== WebSocket.CONNECTING) {
        declareDead(ws);
      }
      return false;
    }
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      declareDead(ws);
      return false;
    }
  }

  function sendOrQueueChat(message: ChatClientMessage) {
    // While a paced flush is draining, join the back of the queue — a direct
    // send would overtake older messages and spend the same rate budget.
    if (trySendNow(message)) {
      return;
    }
    enqueueBounded(chatQueue, message, MAX_CHAT_QUEUE);
  }

  function sendOrQueueVoice(message: VoiceClientMessage) {
    if (trySendNow(message)) {
      return;
    }
    // Voice signaling is ephemeral (peer ids reset on rejoin), so a small cap
    // is plenty — stale entries would just be ignored server-side anyway.
    enqueueBounded(voiceQueue, message, MAX_VOICE_QUEUE);
  }

  return {
    connect(provider: TokenProvider) {
      tokenProvider = provider;
      tokenInFlight = null;
      manualClose = false;
      hasConnectedOnce = false;
      window.addEventListener("online", handleOnline);
      document.addEventListener("visibilitychange", handleVisibility);
      unsubscribeHints?.();
      unsubscribeHints = onNetworkHint(handleNetworkHint);
      void connectSocket();
    },

    disconnect() {
      manualClose = true;
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      unsubscribeHints?.();
      unsubscribeHints = null;
      clearReconnectTimer();
      clearConnectTimer();
      stopKeepalive();
      lossStartedAt = null;
      reconnectAttempt = 0;
      socket?.close(1000);
      socket = null;
      isReady = false;
      tokenProvider = null;
      tokenInFlight = null;
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

    setCallActive(active: boolean) {
      keepaliveMode = active ? "fast" : "normal";
    },
  };
}
