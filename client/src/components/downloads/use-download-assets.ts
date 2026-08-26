import { useCallback, useEffect, useState } from "react";
import {
  RELEASES_PAGE_URL,
  detectDownloadPlan,
  detectPlatform,
  readPlatformSignals,
  resolveLatestAssets,
  type AssetId,
  type AssetUrls,
  type DownloadPlan,
} from "@/lib/downloads";

/**
 * Cached across mounts: the architecture probe is cheap but the answer never
 * changes within a session, and re-running it would re-flash the layout.
 */
let cachedPlan: DownloadPlan | null = null;

function seedPlan(): DownloadPlan | null {
  if (cachedPlan) {
    return cachedPlan;
  }
  if (typeof navigator === "undefined") {
    return null;
  }
  // Platform is sync; chip (Apple Silicon vs Intel) is the async bit. Showing
  // both Mac builds for a frame on Chromium is better than a blank download
  // line while `getHighEntropyValues` round-trips.
  return { platform: detectPlatform(readPlatformSignals()), macArch: null };
}

/**
 * Which file to offer, and the GitHub asset URLs once the visitor has reached
 * for a download (or the catalog has asked on mount).
 */
export function useDownloadAssets() {
  const [plan, setPlan] = useState<DownloadPlan | null>(seedPlan);
  const [assets, setAssets] = useState<AssetUrls>({});

  useEffect(() => {
    let live = true;
    void detectDownloadPlan().then((resolved) => {
      cachedPlan = resolved;
      if (live) {
        setPlan(resolved);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const prefetch = useCallback(() => {
    void resolveLatestAssets().then(setAssets);
  }, []);

  const href = (id: AssetId) => assets[id] ?? RELEASES_PAGE_URL;

  return { plan, assets, prefetch, href };
}
