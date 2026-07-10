import type {
  ChatClientMessage,
  ChatServerMessage,
  VoiceClientMessage,
  VoiceSignalingMessage,
} from "@pqp/shared";
import { getWsUrl } from "@/lib/utils";

type MessageHandler = (message: ChatServerMessage | VoiceSignalingMessage) => void;

export interface RealtimeTransport {
  connect(token: string): void;
  disconnect(): void;
  sendChat(message: ChatClientMessage): void;
  sendVoice(message: VoiceClientMessage): void;
  onMessage(handler: MessageHandler): void;
  onReady(handler: () => void): void;
  onError(handler: (message: string) => void): void;
  isConnected(): boolean;
}

export function createRealtimeTransport(): RealtimeTransport {
  let socket: WebSocket | null = null;
  let handler: MessageHandler | null = null;
  let readyHandler: (() => void) | null = null;
  let errorHandler: ((message: string) => void) | null = null;
  let isReady = false;
  let authToken: string | null = null;
  const chatQueue: ChatClientMessage[] = [];
  const voiceQueue: VoiceClientMessage[] = [];

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
    chatQueue.push(message);
  }

  function sendOrQueueVoice(message: VoiceClientMessage) {
    if (socket?.readyState === WebSocket.OPEN && isReady) {
      socket.send(JSON.stringify(message));
      return;
    }
    voiceQueue.push(message);
  }

  function connectSocket() {
    if (!authToken) {
      return;
    }

    isReady = false;
    socket = new WebSocket(getWsUrl());

    socket.addEventListener("open", () => {
      socket?.send(JSON.stringify({ type: "auth", token: authToken }));
    });

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as
          | { type: "ready" }
          | ChatServerMessage
          | VoiceSignalingMessage;

        if (message.type === "ready") {
          isReady = true;
          flushQueues();
          readyHandler?.();
          return;
        }

        handler?.(message);
      } catch {
        // ignore
      }
    };

    socket.onerror = () => {
      errorHandler?.("Realtime connection error");
    };

    socket.onclose = (event) => {
      isReady = false;
      if (event.code === 4401) {
        errorHandler?.("Realtime authentication failed — sign in again");
      } else if (event.code !== 1000) {
        errorHandler?.("Realtime connection closed");
      }
    };
  }

  return {
    connect(token: string) {
      authToken = token;
      connectSocket();
    },

    disconnect() {
      socket?.close();
      socket = null;
      isReady = false;
      authToken = null;
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

    isConnected() {
      return socket?.readyState === WebSocket.OPEN && isReady;
    },
  };
}
