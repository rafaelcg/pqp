import { useEffect, useState } from "react";
import { loadAttachmentConfig } from "@/lib/attachments";

/**
 * Whether this deployment can take file uploads: `null` until the probe
 * answers, then true or false.
 *
 * The three states are the point. A drop zone that treated "not answered yet"
 * as "off" would tell somebody uploads are disabled for the first second after
 * the page loads. The probe is memoised in `lib/attachments`, so every caller
 * shares one request.
 */
export function useAttachmentsEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void loadAttachmentConfig().then((config) => {
      if (active) {
        setEnabled(config.enabled);
      }
    });
    return () => {
      active = false;
    };
  }, []);
  return enabled;
}
