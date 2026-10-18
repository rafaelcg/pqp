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

/**
 * "agora há pouco", "há 3 min", "há 2 h": how old a reading is, in pt-BR.
 * Only the pt-BR concept previews call this; the home page uses
 * `relativeAge` below.
 */
// literal-ok:begin pt-BR on purpose, for the concept previews
export function ageLabel(at: Date | null, now: Date = new Date()): string {
  if (!at) return "sem horário";
  const s = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
  if (s < 60) return "agora há pouco";
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  return `há ${Math.round(m / 60)} h`;
}
// literal-ok:end

/**
 * How old a reading is, in the reader's language: "now", "3 min. ago",
 * "há 2 h", "ayer". The same steps as `ageLabel` (under a minute is
 * "now", then minutes, then hours), plus days for a reading a day old or
 * more. A reading from the future (a clock ahead of ours) counts as now.
 *
 * `Intl.RelativeTimeFormat` writes the words, with `numeric: "auto"` (so 0 is
 * "now", not "0 seconds ago") and `style: "short"`. The exact text depends on
 * the ICU data of the browser, so callers put it in a sentence slot and never
 * parse it.
 */
export function relativeAge(at: Date, locale: string, now: Date = new Date()): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const s = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
  if (s < 60) return format.format(0, "second");
  const m = Math.round(s / 60);
  if (m < 60) return format.format(-m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return format.format(-h, "hour");
  return format.format(-Math.round(h / 24), "day");
}
