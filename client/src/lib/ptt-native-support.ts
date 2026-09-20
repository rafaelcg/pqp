import { useCallback, useEffect, useState } from "react";
import { getDesktop, type PttPermissionStatus } from "@/lib/desktop";

export interface PttNativeSupport {
  /** Whether this shell offers the Tier 2 (native-hook) bridge at all. */
  available: boolean;
  /**
   * macOS Accessibility permission, so far as Electron can see it.
   * `"not-required"` off macOS or on a shell too old to answer. See the
   * caveat on `getPttPermissionStatus` in `lib/desktop.ts`: this is a
   * necessary condition for the native hook to work, not a sufficient one,
   * because Input Monitoring has no query API at all.
   */
  permission: PttPermissionStatus;
  /**
   * Whether this OS session can run the native hook at all, independent of
   * any binding. `true` until an old shell or a browser proves otherwise,
   * see `getPttNativeCapability` in `lib/desktop.ts`.
   */
  platformSupported: boolean;
  /** Set when `platformSupported` is false. `"wayland"` is the one worth explaining. */
  platformReason?: "wayland" | "platform";
  /** Re-probe permission. Call after sending someone to System Settings. */
  recheck: () => void;
  /** Opens the macOS Accessibility and Input Monitoring panes. No-op elsewhere. */
  openSettings: () => void;
}

/**
 * Reads the desktop shell's native push-to-talk support once, and again
 * whenever the window regains focus. The ordinary flow for granting a
 * macOS permission is alt-tabbing to System Settings and back, and a focus
 * event is the closest thing to a signal that "back" just happened. macOS
 * itself never tells an app a permission changed; polling on focus is the
 * standard workaround every app in this position uses.
 */
export function usePttNativeSupport(): PttNativeSupport {
  const desktop = getDesktop();
  const [permission, setPermission] = useState<PttPermissionStatus>("not-required");
  const [platform, setPlatform] = useState<{
    supported: boolean;
    reason?: "wayland" | "platform";
  }>({ supported: true });

  const recheck = useCallback(() => {
    const probe = desktop?.getPttPermissionStatus;
    if (probe) {
      void probe.call(desktop).then((status) => setPermission(status));
    }
    const capability = desktop?.getPttNativeCapability;
    if (capability) {
      void capability.call(desktop).then((result) => setPlatform(result));
    }
  }, [desktop]);

  useEffect(() => {
    recheck();
  }, [recheck]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [recheck]);

  const openSettings = useCallback(() => {
    desktop?.openPttPermissionSettings?.();
  }, [desktop]);

  return {
    available: typeof desktop?.bindPushToTalkNative === "function",
    permission,
    platformSupported: platform.supported,
    platformReason: platform.reason,
    recheck,
    openSettings,
  };
}

/**
 * Which i18n key explains push-to-talk's reach right now, given what the
 * settings dialog can see about this shell. Pure, so it is unit-testable
 * without mounting the dialog. The decision table is small but every
 * branch is a different sentence somebody will read, so getting the
 * priority order wrong (denied vs. Wayland vs. not-desktop) is exactly the
 * kind of thing worth pinning.
 */
export function pttHintMessageKey({
  isDesktop,
  platformSupported,
  platformReason,
  permission,
}: {
  isDesktop: boolean;
  platformSupported: boolean;
  platformReason?: "wayland" | "platform";
  permission: PttPermissionStatus;
}):
  | "settings.voice.pttHint"
  | "settings.voice.pttHintDesktopWayland"
  | "settings.voice.pttHintDesktopDenied"
  | "settings.voice.pttHintDesktopNative" {
  if (!isDesktop) {
    return "settings.voice.pttHint";
  }
  if (!platformSupported && platformReason === "wayland") {
    return "settings.voice.pttHintDesktopWayland";
  }
  if (permission === "denied") {
    return "settings.voice.pttHintDesktopDenied";
  }
  return "settings.voice.pttHintDesktopNative";
}
