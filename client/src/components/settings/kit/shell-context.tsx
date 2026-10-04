import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SettingsSectionId } from "@/components/settings/kit/sections";

export interface SettingsShellValue {
  /** The profile has staged edits nobody has saved or discarded. */
  profileDirty: boolean;
  /**
   * Switches tab. With `rowId`, scrolls that row into view and flashes it
   * once the tab has rendered it. A row that never shows only switches.
   */
  openSection: (section: SettingsSectionId, rowId?: string) => void;
  /**
   * The last profile save failed because the public link is somebody else's
   * (the handle claim's 409), already localized. Perfil draws it under the
   * link field. Cleared when the link draft changes, on discard and on a
   * successful save. Optional so a test can build the value without it.
   */
  profileHandleError?: string | null;
  /**
   * Asked before leaving the account (sign out). True means staged profile
   * edits stopped it and Perfil now asks to save or discard. Optional so a
   * test can build the value without it.
   */
  holdForDrafts?: () => boolean;
  /**
   * Where the pane header's actions render. Internal: tabs use
   * `SettingsHeaderActions`, never this.
   */
  headerActionsSlot: HTMLElement | null;
}

const NOOP_SHELL: SettingsShellValue = {
  profileDirty: false,
  openSection: () => undefined,
  headerActionsSlot: null,
};

/** Provided by `layout/settings-modal.tsx`. */
export const SettingsShellContext = createContext<SettingsShellValue>(NOOP_SHELL);

/**
 * The cross-tab seam. A tab that needs something from another tab or from the
 * shell asks here, so no tab's props have to grow for it. Outside the dialog it
 * answers "nothing is dirty" and a no-op `openSection`.
 */
export function useSettingsShell(): Pick<
  SettingsShellValue,
  "profileDirty" | "openSection"
> & { profileHandleError: string | null; holdForDrafts: () => boolean } {
  const { profileDirty, openSection, profileHandleError, holdForDrafts } =
    useContext(SettingsShellContext);
  return {
    profileDirty,
    openSection,
    profileHandleError: profileHandleError ?? null,
    holdForDrafts: holdForDrafts ?? notHeld,
  };
}

const notHeld = () => false;

/**
 * Secondary or ghost buttons for the pane header, beside the title the shell
 * draws ("Testar conexão" in Voz, "Ver o mapa" in Atalhos). Rendered from
 * inside the tab, portalled into the header, so the title stays the shell's
 * and the tab keeps owning its own actions. Renders nothing outside the
 * dialog.
 */
export function SettingsHeaderActions({ children }: { children: ReactNode }) {
  const { headerActionsSlot } = useContext(SettingsShellContext);
  return headerActionsSlot ? createPortal(children, headerActionsSlot) : null;
}
