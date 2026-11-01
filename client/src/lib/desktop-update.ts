import { useEffect, useState } from "react";
import {
  getDesktop,
  type DesktopUpdateBridge,
  type DesktopUpdateState,
} from "@/lib/desktop";

/**
 * The desktop shell's updater, as the rail's update button reads it.
 *
 * Null on the web, in a shell built before the bridge, and wherever the shell
 * says its updater is `disabled` (development, Flatpak): the button then only
 * knows about the web build. Reading the state is also how the shell learns
 * the page draws the button, which retires its native "restart" box
 * (`electron/lib/updater.js`).
 */
export function desktopUpdateBridge(): DesktopUpdateBridge | null {
  const update = getDesktop()?.update;
  return update && typeof update.getState === "function" ? update : null;
}

export function useDesktopUpdate(
  bridge: DesktopUpdateBridge | null = desktopUpdateBridge(),
): DesktopUpdateState | null {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    if (!bridge) {
      return;
    }
    let live = true;
    const off = bridge.onState((next) => {
      if (live) {
        setState(next);
      }
    });
    bridge.getState().then(
      (next) => {
        if (live) {
          setState((current) => current ?? next);
        }
      },
      () => {},
    );
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  return state && state.status !== "disabled" ? state : null;
}

/**
 * The one thing the button says, from the shell's updater and the web build
 * together. The shell comes first: its restart also loads the newest site, so
 * a downloaded shell update is the whole answer.
 */
export type UpdatePhase =
  | { kind: "current" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; via: "shell" | "web"; version: string | null }
  | { kind: "error"; context: "check" | "download" };

export function updatePhase(input: {
  shell: DesktopUpdateState | null;
  webOffered: boolean;
  /** The operator pushed the web build (forced or critical): it goes before a shell download. */
  webUrgent?: boolean;
  checking: boolean;
}): UpdatePhase {
  const { shell } = input;
  if (shell?.status === "downloaded") {
    return { kind: "ready", via: "shell", version: shell.version || null };
  }
  if (input.webOffered && input.webUrgent) {
    return { kind: "ready", via: "web", version: null };
  }
  if (shell?.status === "downloading") {
    return { kind: "downloading", version: shell.version, percent: shell.percent };
  }
  if (shell?.status === "available") {
    return { kind: "available", version: shell.version };
  }
  if (input.webOffered) {
    return { kind: "ready", via: "web", version: null };
  }
  if (input.checking || shell?.status === "checking") {
    return { kind: "checking" };
  }
  if (shell?.status === "error") {
    return { kind: "error", context: shell.context };
  }
  return { kind: "current" };
}
