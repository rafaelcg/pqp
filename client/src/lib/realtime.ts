import type {
  ChatClientMessage,
  ChatServerMessage,
  VoiceClientMessage,
  VoiceSignalingMessage,
} from "@pqp/shared";
import { getWsUrl } from "@/lib/utils";

type MessageHandler = (
  message: ChatServerMessage | VoiceSignalingMessage,
) => void;

export type RealtimeStatus =
  | "idle"
  | "connecting"
  | "online"
  | "reconnecting"
  | "unauthorized";

export interface RealtimeTransport {
  connect(getToken: () => Promise<string | null>): void;
  disconnect(): void;
  sendChat(message: ChatClientMessage): void;
  sendVoice(message: VoiceClientMessage): void;
  onMessage(handler: MessageHandler): void;
  /** Fires after every successful (re)connect — resubscribe channel state here. */
  onReady(handler: (reconnected: boolean) => void): void;
  onStatusChange(handler: (status: RealtimeStatus, detail?: string) => void): void;
  getStatus(): RealtimeStatus;
  isConnected(): boolean;
}

const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 15_000;
/** App-level ping. Browsers cannot observe protocol pongs, so we need our own. */
const PING_INTERVAL_MS = 25_000;
/**
 * No traffic at all for this long means the socket is half-open. Kept well above
 * the ping interval: a backgrounded tab has its timers clamped to roughly one
 * run per minute, and a tighter margin would tear down a healthy connection.
 */
const SILENCE_TIMEOUT_MS = 3 * PING_INTERVAL_MS + 30_000;
/** Outbound messages held while offline. Old signalling is worthless, so cap it. */
const MAX_QUEUE = 100;

export function createRealtimeTransport(): RealtimeTransport {
  let socket: WebSocket | null = null;
  let handler: MessageHandler | null = null;
  let readyHandler: ((reconnected: boolean) => void) | null = null;
  let statusHandler:
    | ((status: RealtimeStatus, detail?: string) => void)
    | null = null;

  let status: RealtimeStatus = "idle";
  let isReady = false;
  let getToken: (() => Promise<string | null>) | null = null;
  let attempts = 0;
  let hasConnectedOnce = false;
  let stopped = true;

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let connectSeq = 0;

  const queue: Array<ChatClientMessage | VoiceClientMessage> = [];

  function setStatus(next: RealtimeStatus, detail?: string) {
    if (status === next) {
      return;
    }
    status = next;
    statusHandler?.(next, detail);
  }

  /**
   * Enter the in-flight state, but never downgrade "unauthorized" — the reason
   * we are retrying is more useful to the user than the fact that we are.
   * Cleared by a successful connect or an explicit disconnect.
   */
  function setPendingStatus(detail?: string) {
    if (status === "unauthorized") {
      return;
    }
    setStatus(hasConnectedOnce ? "reconnecting" : "connecting", detail);
  }

  function clearTimers() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function noteTraffic() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
    }
    silenceTimer = setTimeout(() => {
      // The socket still claims to be OPEN but nothing is arriving. Tear it
      // down so the normal reconnect path runs.
      socket?.close(4000, "Silent connection");
    }, SILENCE_TIMEOUT_MS);
  }

  function flushQueue() {
    if (!socket || socket.readyState !== WebSocket.OPEN || !isReady) {
      return;
    }
    for (const message of queue.splice(0)) {
      socket.send(JSON.stringify(message));
    }
  }

  function enqueue(message: ChatClientMessage | VoiceClientMessage) {
    if (socket?.readyState === WebSocket.OPEN && isReady) {
      socket.send(JSON.stringify(message));
      return;
    }
    if (queue.length >= MAX_QUEUE) {
      queue.shift();
    }
    queue.push(message);
  }

  function scheduleReconnect(detail?: string) {
    if (stopped || reconnectTimer) {
      return;
    }
    setPendingStatus(detail);

    // Exponential backoff with jitter so a server restart does not get a
    // synchronised stampede from every client at once.
    const exponential = Math.min(
      MAX_RECONNECT_DELAY_MS,
      BASE_RECONNECT_DELAY_MS * 2 ** attempts,
    );
    const delay = exponential / 2 + Math.random() * (exponential / 2);
    attempts += 1;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void openSocket();
    }, delay);
  }

  async function openSocket() {
    if (stopped || !getToken) {
      return;
    }

    const seq = ++connectSeq;
    isReady = false;
    setPendingStatus();

    // Retire whatever socket we are replacing. Its handlers are seq-gated, so an
    // already-open one would otherwise stay authenticated and hold ghost
    // presence on the server until the proxy eventually reaped it.
    const previous = socket;
    socket = null;
    previous?.close(1000, "Superseded");

    let token: string | null;
    try {
      token = await getToken();
    } catch {
      token = null;
    }

    // A newer connect started while we were awaiting the token.
    if (stopped || seq !== connectSeq) {
      return;
    }

    if (!token) {
      setStatus("unauthorized", "Could not get a session token");
      scheduleReconnect();
      return;
    }

    let next: WebSocket;
    try {
      next = new WebSocket(getWsUrl());
    } catch {
      scheduleReconnect("Realtime connection failed");
      return;
    }
    socket = next;

    next.onopen = () => {
      if (seq !== connectSeq) {
        next.close();
        return;
      }
      next.send(JSON.stringify({ type: "auth", token }));
      noteTraffic();
    };

    next.onmessage = (event) => {
      if (seq !== connectSeq) {
        return;
      }
      noteTraffic();

      let message: { type: string } & Record<string, unknown>;
      try {
        message = JSON.parse(event.data as string);
      } catch {
        return;
      }

      if (message.type === "pong") {
        return;
      }

      if (message.type === "ready") {
        isReady = true;
        attempts = 0;
        const reconnected = hasConnectedOnce;
        hasConnectedOnce = true;
        setStatus("online");
        flushQueue();

        if (pingTimer) {
          clearInterval(pingTimer);
        }
        pingTimer = setInterval(() => {
          if (next.readyState === WebSocket.OPEN) {
            next.send(JSON.stringify({ type: "ping" }));
          }
        }, PING_INTERVAL_MS);

        readyHandler?.(reconnected);
        return;
      }

      handler?.(message as never);
    };

    next.onerror = () => {
      // `close` always follows; reconnect is handled there.
    };

    next.onclose = (event) => {
      if (seq !== connectSeq) {
        return;
      }
      isReady = false;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      // Only *our own* clean close ends things. A 1000 from the other side —
      // a proxy recycling the connection, or a graceful server shutdown — must
      // still reconnect, otherwise the app sits there claiming to be online.
      if (stopped) {
        return;
      }
      if (event.code === 4401) {
        // Token was rejected. Retry — the provider refreshes it — but say so.
        setStatus("unauthorized", "Session expired — reconnecting");
      }
      scheduleReconnect(
        event.code === 4401 ? undefined : "Realtime connection lost",
      );
    };
  }

  function handleOnline() {
    if (stopped || status === "online") {
      return;
    }
    // The network came back; do not wait out the current backoff.
    attempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    void openSocket();
  }

  function handleVisibility() {
    if (document.visibilityState === "visible") {
      handleOnline();
    }
  }

  return {
    connect(nextGetToken) {
      getToken = nextGetToken;
      stopped = false;
      attempts = 0;
      hasConnectedOnce = false;
      window.addEventListener("online", handleOnline);
      document.addEventListener("visibilitychange", handleVisibility);
      void openSocket();
    },

    disconnect() {
      stopped = true;
      connectSeq += 1;
      clearTimers();
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      const current = socket;
      socket = null;
      isReady = false;
      queue.length = 0;
      getToken = null;
      setStatus("idle");
      current?.close(1000, "Client disconnect");
    },

    sendChat(message) {
      enqueue(message);
    },

    sendVoice(message) {
      enqueue(message);
    },

    onMessage(nextHandler) {
      handler = nextHandler;
    },

    onReady(nextHandler) {
      readyHandler = nextHandler;
    },

    onStatusChange(nextHandler) {
      statusHandler = nextHandler;
    },

    getStatus() {
      return status;
    },

    isConnected() {
      return socket?.readyState === WebSocket.OPEN && isReady;
    },
  };
}
