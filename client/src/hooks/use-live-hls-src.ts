import { useEffect, useState } from "react";
import { playlistLooksLive } from "@pqp/shared";

/**
 * Whether each advertised playlist is actually a live window.
 *
 * A `voice-stream` URL can exist before the first segment lands, or still
 * point at the previous share's `#EXT-X-ENDLIST`. Attaching either is a
 * black `<video>`, so the stage keeps WebRTC until this says go.
 */
export function useLiveHlsReady(urls: string[]): ReadonlySet<string> {
  const key = [...urls].sort().join("\n");
  const [ready, setReady] = useState<string[]>([]);

  useEffect(() => {
    const wanted = key === "" ? [] : key.split("\n");
    if (wanted.length === 0) {
      setReady([]);
      return;
    }
    let cancelled = false;
    const have = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      for (const url of wanted) {
        if (have.has(url)) {
          continue;
        }
        try {
          const response = await fetch(url, { cache: "no-store" });
          if (response.ok && playlistLooksLive(await response.text())) {
            have.add(url);
          }
        } catch {
          // 404 / CORS: keep WebRTC and try again.
        }
      }
      if (cancelled) {
        return;
      }
      setReady([...have]);
      if (have.size < wanted.length) {
        timer = setTimeout(tick, 1000);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [key]);

  return new Set(ready);
}
