import { useEffect, useRef } from "react";
import {
  createAttentionTracker,
  documentIsForeground,
  type AttentionTracker,
} from "@/lib/attention";

export interface UseAttentionReportOptions {
  /** Sends `set-attention` over the chat socket. */
  sendAttention: (foreground: boolean) => void;
  /**
   * Whether the realtime link is up. Load-bearing, the same way it is for
   * idle: the server forgets attention with the socket, so every reconnect
   * re-announces it.
   */
  connected: boolean;
}

/**
 * Tells the server whether this window is in front of the person, for the
 * push attention gate. The rules are in `lib/attention.ts`; this only feeds
 * them the browser's events. The desktop app runs this same code: its window
 * loads the same SPA. There, focus is the half that does the work: the shell
 * turns background throttling off (`electron/main.js`, for voice resume), and
 * with it off Electron keeps `visibilityState` at "visible" while minimised or
 * hidden to the tray. Both of those take focus away, so the window still
 * reports background after the grace.
 */
export function useAttentionReport({
  sendAttention,
  connected,
}: UseAttentionReportOptions): void {
  const sendRef = useRef(sendAttention);
  sendRef.current = sendAttention;
  const trackerRef = useRef<AttentionTracker | null>(null);
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  useEffect(() => {
    const tracker = createAttentionTracker({
      send: (foreground) => sendRef.current(foreground),
      isForeground: documentIsForeground,
    });
    trackerRef.current = tracker;
    tracker.setConnected(connectedRef.current);

    const evaluate = () => tracker.evaluate();
    document.addEventListener("visibilitychange", evaluate);
    window.addEventListener("focus", evaluate);
    window.addEventListener("blur", evaluate);

    return () => {
      document.removeEventListener("visibilitychange", evaluate);
      window.removeEventListener("focus", evaluate);
      window.removeEventListener("blur", evaluate);
      tracker.dispose();
      trackerRef.current = null;
    };
  }, []);

  useEffect(() => {
    trackerRef.current?.setConnected(connected);
  }, [connected]);
}
