import type {
  ChatClientMessage,
  ChatServerMessage,
  VoiceClientMessage,
  VoiceSignalingMessage,
} from "@pqp/shared";
import { getWsUrl } from "@/lib/utils";

type MessageHandler = (message: ChatServerMessage | VoiceSignalingMessage) => void;
type TokenProvider = () => Promise<string | null>;

// Hosted proxies (Railway edge) drop idle WebSockets, so keep traffic flowing
// well under typical idle timeouts and treat a missed pong as a dead link.
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
// Bound the offline outbound queues so a long disconnect can't grow memory
// without limit; overflow drops the oldest entries.
const MAX_CHAT_QUEUE = 200;
const MAX_VOICE_QUEUE = 100;

function enqueueBounded<T>(queue: T[], message: T, max: number) {
  queue.push(message);
  if (queue.length > max) {
    queue.splice(0, queue.length - max);
  }
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
  onReady(handler: () => void): void;
  onError(handler: (message: string) => void): void;
  /** Fired once when an established connection is lost (before reconnect attempts). */
  onClose(handler: () => void): void;
  isConnected(): boolean;
}

export function createRealtimeTransport(): RealtimeTransport {
  let socket: WebSocket | null = null;
  let handler: MessageHandler | null = null;
  let readyHandler: (() => void) | null = null;
  let errorHandler: ((message: string) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let isReady = false;
  let tokenProvider: TokenProvider | null = null;
  let manualClose = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  const chatQueue: ChatClientMessage[] = [];
  const voiceQueue: VoiceClientMessage[] = [];

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
    if (pongTimer) {
      clearTimeout(pongTimer);
      pongTimer = null;
    }
  }

  function startKeepalive(ws: WebSocket) {
    stopKeepalive();
    pingTimer = setInterval(() => {
      if (ws !== socket || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(JSON.stringify({ type: "ping" }));
      if (!pongTimer) {
        pongTimer = setTimeout(() => {
          pongTimer = null;
          // Half-open connection: the close event may never fire on its own.
          handleConnectionLoss(ws);
          ws.close();
        }, PONG_TIMEOUT_MS);
      }
    }, PING_INTERVAL_MS);
  }

  function scheduleReconnect() {
    if (manualClose || reconnectTimer) {
      return;
    }
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectSocket();
    }, delay + Math.random() * 500);
  }

  function handleOnline() {
    // Network came back: skip the remaining backoff and retry now.
    if (!manualClose && reconnectTimer) {
      clearReconnectTimer();
      void connectSocket();
    }
  }

  // Idempotent per socket: reached from both the close event and pong timeout.
  function handleConnectionLoss(ws: WebSocket, authFailed = false) {
    if (ws !== socket) {
      return;
    }
    socket = null;
    const wasReady = isReady;
    isReady = false;
    stopKeepalive();

    if (manualClose) {
      return;
    }

    if (authFailed) {
      errorHandler?.("Realtime authentication failed — sign in again");
      return;
    }

    if (wasReady) {
      closeHandler?.();
    }
    errorHandler?.("Connection lost — reconnecting…");
    scheduleReconnect();
  }

  async function connectSocket() {
    if (!tokenProvider || manualClose || socket) {
      return;
    }

    let token: string | null = null;
    try {
      token = await tokenProvider();
    } catch {
      token = null;
    }
    if (manualClose || socket) {
      return;
    }
    if (!token) {
      scheduleReconnect();
      return;
    }

    isReady = false;
    const ws = new WebSocket(getWsUrl());
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
          if (pongTimer) {
            clearTimeout(pongTimer);
            pongTimer = null;
          }
          return;
        }

        if (message.type === "ready") {
          isReady = true;
          reconnectAttempt = 0;
          startKeepalive(ws);
          flushQueues();
          readyHandler?.();
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
      handleConnectionLoss(ws, event.code === 4401);
    };
  }

  function flushQueues() {
    if (!socket || socket.readyState !== WebSocket.OPEN || !isReady) {
      return;
    }
    for (const message of chatQueue.splice(0)) {
      socket.send(JSON.stringify(message));
    }
    for (const message of voiceQueue.splice(0)) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendOrQueueChat(message: ChatClientMessage) {
    if (socket?.readyState === WebSocket.OPEN && isReady) {
      socket.send(JSON.stringify(message));
      return;
    }
    enqueueBounded(chatQueue, message, MAX_CHAT_QUEUE);
  }

  function sendOrQueueVoice(message: VoiceClientMessage) {
    if (socket?.readyState === WebSocket.OPEN && isReady) {
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
      window.addEventListener("online", handleOnline);
      void connectSocket();
    },

    disconnect() {
      manualClose = true;
      window.removeEventListener("online", handleOnline);
      clearReconnectTimer();
      stopKeepalive();
      reconnectAttempt = 0;
      socket?.close(1000);
      socket = null;
      isReady = false;
      tokenProvider = null;
      chatQueue.length = 0;
      voiceQueue.length = 0;
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

    onReady(nextHandler: () => void) {
      readyHandler = nextHandler;
    },

    onError(nextHandler: (message: string) => void) {
      errorHandler = nextHandler;
    },

    onClose(nextHandler: () => void) {
      closeHandler = nextHandler;
    },

    isConnected() {
      return socket?.readyState === WebSocket.OPEN && isReady;
    },
  };
}
