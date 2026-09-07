import { useEffect, useState } from "react";

export interface HlsPlaybackStats {
  width: number;
  height: number;
}

let stats: HlsPlaybackStats | null = null;
const listeners = new Set<(next: HlsPlaybackStats | null) => void>();

export function setHlsPlaybackStats(next: HlsPlaybackStats | null): void {
  stats = next;
  for (const listener of listeners) {
    listener(next);
  }
}

export function useHlsPlaybackStats(): HlsPlaybackStats | null {
  const [value, setValue] = useState(stats);
  useEffect(() => {
    listeners.add(setValue);
    setValue(stats);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}
