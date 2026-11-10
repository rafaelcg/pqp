import { useEffect, useMemo, useRef, useState } from "react";
import type { JamEngine, TransportState } from "@/lib/jam";

/**
 * The engine's transport as a screen sees it.
 *
 * THE CLOCK IS NOT STATE. The playhead moves every animation frame, and
 * re-rendering six lanes of waveform at 60 Hz to move a line is the cost this
 * avoids: `clock.subscribe` hands a callback the position, and a lane writes it
 * straight to its own element. Only the things that change rarely (transport,
 * length) are React state.
 */

export interface JamClock {
  subscribe(listener: (positionMs: number, durationMs: number) => void): () => void;
}

export function useEngineClock(engine: JamEngine | null): {
  clock: JamClock;
  transport: TransportState;
  durationMs: number;
} {
  const [transport, setTransport] = useState<TransportState>("stopped");
  const [durationMs, setDurationMs] = useState(0);
  const listeners = useRef(new Set<(positionMs: number, durationMs: number) => void>());
  const last = useRef({ positionMs: 0, durationMs: 0 });

  useEffect(() => {
    if (!engine) {
      return;
    }
    // Start from what the engine is doing NOW: a second screen on the shared engine
    // (the studio over a playing song) must not say "paused" while it plays.
    setTransport(engine.player.state);
    return engine.player.subscribe((tick) => {
      last.current = { positionMs: tick.positionMs, durationMs: tick.durationMs };
      for (const listener of listeners.current) {
        listener(tick.positionMs, tick.durationMs);
      }
      setTransport((before) => (before === tick.state ? before : tick.state));
      setDurationMs((before) => (before === tick.durationMs ? before : tick.durationMs));
    });
  }, [engine]);

  const clock = useMemo<JamClock>(
    () => ({
      subscribe(listener) {
        listeners.current.add(listener);
        listener(last.current.positionMs, last.current.durationMs);
        return () => {
          listeners.current.delete(listener);
        };
      },
    }),
    [],
  );

  return { clock, transport, durationMs };
}
