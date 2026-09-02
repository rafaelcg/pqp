import type { SettingsSectionId } from "@/components/layout/settings-modal";

/**
 * "Open Settings at this section", from anywhere.
 *
 * The settings dialog is owned by App. A deep component that wants to send
 * somebody there (the call stage's "your microphone could not start" banner,
 * for one) would otherwise need a prop threaded through two wrappers. This is
 * one subscriber in App and one call at the site.
 */

type Listener = (section: SettingsSectionId) => void;
const listeners = new Set<Listener>();

export function requestSettingsSection(section: SettingsSectionId): void {
  for (const listener of listeners) {
    listener(section);
  }
}

export function onSettingsRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** "Run the connection check", from the voice stage or voice settings. */
const checkListeners = new Set<() => void>();

export function requestConnectionCheck(): void {
  for (const listener of checkListeners) {
    listener();
  }
}

export function onConnectionCheckRequest(listener: () => void): () => void {
  checkListeners.add(listener);
  return () => {
    checkListeners.delete(listener);
  };
}
