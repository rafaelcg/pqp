import { useSyncExternalStore } from "react";

const QUERY = "(hover: none)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const list = window.matchMedia(QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

function snapshot(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(QUERY).matches
  );
}

/**
 * True on a device whose main input cannot hover: a phone or a tablet. The
 * same test the row action tiles use in CSS (`[@media(hover:none)]`), for copy
 * that has to say a different thing there ("Clique duas vezes" has no meaning
 * for a finger).
 */
export function useTouchPrimary(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
