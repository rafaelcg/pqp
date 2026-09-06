import { useEffect, useMemo, useRef } from "react";
import { getDesktop } from "@/lib/desktop";
import {
  bindingsEqual,
  defaultShortcutBindings,
  matchShortcut,
  type ShortcutAction,
  type ShortcutOverrides,
  resolveShortcutBindings,
} from "@/lib/keyboard-shortcuts";
import type { KeyBinding } from "@/components/voice/push-to-talk";

interface KeyboardShortcutOptions {
  overrides: ShortcutOverrides | undefined;
  isMac: boolean;
  enabled?: boolean;
  onAction: (action: ShortcutAction) => void;
}

/**
 * Desktop already has Cmd/Ctrl+Shift+M (and after this change, Shift+D) on
 * the app menu. Handling the default chord again in the renderer would
 * toggle twice and look like the key did nothing. Remaps still fire here.
 * Older shells without `onToggleDeafen` keep deafen in the renderer.
 */
function desktopOwnsDefault(
  action: ShortcutAction,
  binding: KeyBinding,
  defaults: Record<ShortcutAction, KeyBinding>,
): boolean {
  const desktop = getDesktop();
  if (!desktop) {
    return false;
  }
  if (action === "toggleMute") {
    return bindingsEqual(binding, defaults.toggleMute);
  }
  if (action === "toggleDeafen" && desktop.onToggleDeafen) {
    return bindingsEqual(binding, defaults.toggleDeafen);
  }
  return false;
}

/**
 * Window-level Discord keys. Capture phase so a stopped bubble still
 * reaches us; skipped while a key-binding field is armed. Bindings without
 * Ctrl/Meta still yield to the composer (`matchShortcut`).
 */
export function useKeyboardShortcuts({
  overrides,
  isMac,
  enabled = true,
  onAction,
}: KeyboardShortcutOptions): Record<ShortcutAction, KeyBinding> {
  const bindings = useMemo(
    () => resolveShortcutBindings(overrides, isMac),
    [overrides, isMac],
  );
  const defaults = useMemo(() => defaultShortcutBindings(isMac), [isMac]);
  const onActionRef = useRef(onAction);
  const bindingsRef = useRef(bindings);
  const defaultsRef = useRef(defaults);

  useEffect(() => {
    onActionRef.current = onAction;
  }, [onAction]);

  useEffect(() => {
    bindingsRef.current = bindings;
    defaultsRef.current = defaults;
  }, [bindings, defaults]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-key-binding-field][aria-pressed='true']")
      ) {
        return;
      }
      const action = matchShortcut(event, bindingsRef.current);
      if (!action) {
        return;
      }
      if (
        desktopOwnsDefault(action, bindingsRef.current[action], defaultsRef.current)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onActionRef.current(action);
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [enabled]);

  return bindings;
}
