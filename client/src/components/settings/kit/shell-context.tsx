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
> {
  const { profileDirty, openSection } = useContext(SettingsShellContext);
  return { profileDirty, openSection };
}

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
