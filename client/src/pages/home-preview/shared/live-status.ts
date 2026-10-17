import { useEffect, useState } from "react";
import { getApiBaseUrl } from "@/lib/utils";
import { parseStatus, type LiveReading } from "@/lib/where-we-run";

/**
 * One read of the public `/status.json` per page load, shared by every
 * component that wants it (the nav pill, the map). The endpoint is rate
 * limited per address, so it is never polled from a landing page.
 *
 * `null` while loading; `"unavailable"` when the read failed, which callers
 * must show as "unknown", never as green.
 */
let pending: Promise<LiveReading | "unavailable"> | null = null;

function load(): Promise<LiveReading | "unavailable"> {
  if (!pending) {
    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(`${getApiBaseUrl()}/status.json`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) return "unavailable";
        return parseStatus(await res.json()) ?? "unavailable";
      } catch {
        return "unavailable";
      } finally {
        clearTimeout(timer);
      }
    })();
  }
  return pending;
}

export function useLiveStatus(): LiveReading | "unavailable" | null {
  const [reading, setReading] = useState<LiveReading | "unavailable" | null>(null);
  useEffect(() => {
    let cancelled = false;
    void load().then((r) => {
      if (!cancelled) setReading(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return reading;
}

/** "agora há pouco", "há 3 min", "há 2 h": how old a reading is, in pt-BR. */
export function ageLabel(at: Date | null, now: Date = new Date()): string {
  if (!at) return "sem horário";
  const s = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
  if (s < 60) return "agora há pouco";
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  return `há ${Math.round(m / 60)} h`;
}
