import { createContext, useContext } from "react";

/**
 * What the call and the chat need to know when they are drawn in the column
 * beside a running app (`app_pane_layout_v2`). `AppSessionLayout` provides it
 * around its children; everything outside an app session reads the inactive
 * default and draws exactly what it drew before.
 *
 * - `active`: the column is beside (or under) an app. The call keeps its one
 *   set of controls in the column with it instead of docking them into the
 *   composer, its "Mais" takes what does not fit one row, and the share picture
 *   is a tile with a size cap rather than the column's whole height.
 * - `chatAway`: the transcript and composer are put away; the call stays.
 * - `hideChat` / `showChat`: the one chat toggle, so the chat header's own
 *   "Esconder chat" means the same thing as the strip's.
 */
export interface AppColumnState {
  active: boolean;
  chatAway: boolean;
  /**
   * Where the column is (`appColumnLayout`): `stage` is the side column holding
   * only the call's pictures, which leaves room for a way back to the chat.
   */
  column?: "full" | "side" | "below" | "bar" | "stage" | "hidden";
  /**
   * The most a call's pictures may take, in px, when they sit under the app
   * with the chat away (a share of the body's height). The column there is
   * only as tall as the tile, so its own height cannot be the cap.
   */
  belowCap?: number;
  hideChat: () => void;
  showChat: () => void;
}

const noop = () => {};

export const INACTIVE_APP_COLUMN: AppColumnState = {
  active: false,
  chatAway: false,
  hideChat: noop,
  showChat: noop,
};

export const AppColumnContext = createContext<AppColumnState>(INACTIVE_APP_COLUMN);

export function useAppColumn(): AppColumnState {
  return useContext(AppColumnContext);
}

/**
 * The keyboard shortcut's way in (`toggleAppChat`). The layout that has an app
 * on screen registers; with none on screen the shortcut does nothing and says
 * so by returning false.
 */
let toggler: (() => void) | null = null;

export function registerAppChatToggler(next: () => void): () => void {
  toggler = next;
  return () => {
    if (toggler === next) toggler = null;
  };
}

export function toggleAppChat(): boolean {
  if (!toggler) return false;
  toggler();
  return true;
}
