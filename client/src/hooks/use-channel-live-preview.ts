import { useEffect, useState } from "react";
import { fetchChannelLivePreview, type LiveHlsConfig } from "@/lib/api";
import { publicPreviewSwitchSeconds } from "@/lib/live-preview";

/**
 * The "Prévia pública" switch's answer for one watch party channel: the
 * preview window in seconds when the switch should be drawn, null otherwise.
 *
 * Asks `GET /api/channels/:id/live-preview` only when the server's live-hls
 * config carried `livePreview` (the flag is on for this server), so with the
 * flag off the client makes no request it did not make before. Re-asked when
 * the channel changes; a failure hides the switch.
 */
export function useChannelLivePreview(
  channelId: string | null,
  config: LiveHlsConfig | null,
): number | null {
  const flagOn = config?.livePreview !== undefined;
  const [answer, setAnswer] = useState<{
    channelId: string;
    available: boolean;
    seconds: number;
  } | null>(null);
  useEffect(() => {
    if (!channelId || !flagOn) {
      return;
    }
    let cancelled = false;
    fetchChannelLivePreview(channelId)
      .then((body) => {
        if (!cancelled) {
          setAnswer({ channelId, available: body.available === true, seconds: body.seconds });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAnswer({ channelId, available: false, seconds: 0 });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, flagOn]);
  return publicPreviewSwitchSeconds(
    config,
    answer && answer.channelId === channelId ? answer : null,
  );
}
