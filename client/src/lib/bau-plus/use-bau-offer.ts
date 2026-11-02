import type { BauOffer } from "@pqp/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBauOffer } from "./api";
import { onBauPlusUpdate } from "./updates";

/**
 * What this server sells and the fan's own membership, kept fresh: re-read on
 * every `bau-plus-update` for this server and when the window comes back into
 * focus (a payment confirmed while the tab was hidden, or on another device).
 *
 * `null` while loading, or when the server does not answer (an older API, a
 * self-host): every caller treats that as "not selling" and draws the old card.
 */
export function useBauOffer(serverId: string | null, enabled = true) {
  const [offer, setOffer] = useState<BauOffer | null>(null);
  const [loaded, setLoaded] = useState(false);
  const current = useRef(serverId);
  current.current = serverId;
  // Only the newest read may write (a slow answer must not undo a newer one).
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!serverId || !enabled) {
      return null;
    }
    const mine = ++seq.current;
    try {
      const next = await fetchBauOffer(serverId);
      if (current.current === serverId && mine === seq.current) {
        setOffer(next);
        setLoaded(true);
      }
      return next;
    } catch {
      if (current.current === serverId && mine === seq.current) {
        setLoaded(true);
      }
      return null;
    }
  }, [serverId, enabled]);

  useEffect(() => {
    setOffer(null);
    setLoaded(false);
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!serverId || !enabled) {
      return undefined;
    }
    const off = onBauPlusUpdate((message) => {
      if (message.serverId === serverId) {
        void reload();
      }
    });
    const onFocus = () => {
      if (document.visibilityState === "visible") {
        void reload();
      }
    };
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [serverId, enabled, reload]);

  return { offer, loaded, reload, setOffer };
}
