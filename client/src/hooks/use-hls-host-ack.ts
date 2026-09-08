import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";

interface HlsHostAckResponse {
  acknowledged: boolean;
}

/**
 * Gate for the one-time "you're responsible for what you stream" sheet.
 * `checkNeedsAck` asks the server (per user+server, `hls_host_acks`) right
 * before a host would start a watch party; `confirm` persists the ack so it
 * never shows again for that pair.
 */
export function useHlsHostAck() {
  const [checking, setChecking] = useState(false);

  const checkNeedsAck = useCallback(async (serverId: string) => {
    setChecking(true);
    try {
      const result = await apiFetch<HlsHostAckResponse>(
        `/api/voice/hls-host-ack/${serverId}`,
      );
      return !result.acknowledged;
    } catch {
      // Storage/network trouble: fail open rather than block a host from
      // starting their stream over a sheet that could not be checked.
      return false;
    } finally {
      setChecking(false);
    }
  }, []);

  const confirm = useCallback(async (serverId: string) => {
    await apiFetch<HlsHostAckResponse>(
      `/api/voice/hls-host-ack/${serverId}`,
      { method: "POST" },
    );
  }, []);

  return { checking, checkNeedsAck, confirm };
}
