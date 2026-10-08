import { useEffect, useState } from "react";
import { fetchVoiceConfig, type VoiceConfig } from "@/lib/api";
import { onConfigRefresh } from "@/lib/config-refresh";

/**
 * Per-server voice call switches, from `GET /api/voice/config?serverId=`
 * (`voiceConfigForServer` on the server). Today that is one field,
 * `audienceMode`: whether a host here is offered "Modo plateia".
 *
 * Runtime flags flipped from the operator dashboard with no deploy, so the
 * answers held here are re-asked on focus and on a slow timer by
 * `lib/config-refresh.ts`, and a hook re-renders when its server's answer
 * changes. A failed ask keeps what was there (stale beats blank) and an
 * unknown answer reads as `{}`, which is off.
 */
const settled = new Map<string, VoiceConfig>();
const inflight = new Map<string, Promise<VoiceConfig>>();
const listeners = new Map<string, Set<() => void>>();
let refreshRegistered = false;

function ask(serverId: string): Promise<VoiceConfig> {
  let pending = inflight.get(serverId);
  if (!pending) {
    pending = fetchVoiceConfig(serverId)
      .then((answer) => {
        const before = settled.get(serverId);
        settled.set(serverId, answer);
        if (before === undefined || JSON.stringify(before) !== JSON.stringify(answer)) {
          for (const listener of listeners.get(serverId) ?? []) {
            listener();
          }
        }
        return answer;
      })
      .finally(() => {
        inflight.delete(serverId);
      });
    inflight.set(serverId, pending);
  }
  return pending;
}

function registerRefresh(): void {
  if (refreshRegistered) {
    return;
  }
  refreshRegistered = true;
  onConfigRefresh(() => {
    for (const serverId of listeners.keys()) {
      void ask(serverId).catch(() => {
        // Stale beats blank.
      });
    }
  });
}

/** The current answer for this server, `{}` until one arrives (off). */
export function useVoiceConfig(serverId: string | null | undefined): VoiceConfig {
  const [config, setConfig] = useState<VoiceConfig>(() =>
    serverId ? (settled.get(serverId) ?? {}) : {},
  );
  useEffect(() => {
    if (!serverId) {
      setConfig({});
      return;
    }
    registerRefresh();
    const update = () => setConfig(settled.get(serverId) ?? {});
    let forKey = listeners.get(serverId);
    if (!forKey) {
      forKey = new Set();
      listeners.set(serverId, forKey);
    }
    const set = forKey;
    set.add(update);
    update();
    if (!settled.has(serverId)) {
      void ask(serverId).catch(() => {
        // An older API (404) or a network blip: off until the next refresh.
      });
    }
    return () => {
      set.delete(update);
      if (set.size === 0 && listeners.get(serverId) === set) {
        listeners.delete(serverId);
      }
    };
  }, [serverId]);
  return config;
}

/** Test seam. */
export function resetVoiceConfigForTests(): void {
  settled.clear();
  inflight.clear();
  listeners.clear();
}
