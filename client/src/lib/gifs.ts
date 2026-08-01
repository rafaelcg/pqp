import { fetchGifConfig } from "@/lib/api";

/**
 * Whether this deployment can serve GIF search, asked once per page load.
 *
 * The composer remounts on every channel switch (its draft is component
 * state), so without a module-level memo a busy session would re-ask on every
 * click in the sidebar. A failed probe resolves false rather than rejecting:
 * "cannot reach the API" and "no provider key" both mean the button should not
 * be there, and neither is worth an error surface of its own.
 */
let probe: Promise<boolean> | null = null;

export function loadGifSearchEnabled(): Promise<boolean> {
  probe ??= fetchGifConfig()
    .then((config) => config.enabled)
    .catch(() => false);
  return probe;
}
