import { createContext, useContext } from "react";

/**
 * Every section of the account Settings dialog.
 *
 * Lives in the kit rather than in `layout/settings-modal.tsx` so the kit can
 * name a section (the row registry, `openSection`) without importing the shell
 * that imports every tab that imports the kit. The modal re-exports it as
 * `SettingsSectionId` for the callers that open the dialog on a section.
 */
export type SettingsSectionId =
  | "profile"
  | "connections"
  | "voice"
  | "keyboard"
  | "notifications"
  | "appearance"
  | "privacy"
  | "data"
  | "feedback"
  | "help"
  | "moderation";

/**
 * The section a tab is rendered under. The shell sets it around each tab, and
 * every row reads it to register itself. Null outside the dialog (the `/qa/ui`
 * sheet), where rows render normally and register nothing.
 */
export const SettingsSectionContext = createContext<SettingsSectionId | null>(
  null,
);

export function useSettingsSection(): SettingsSectionId | null {
  return useContext(SettingsSectionContext);
}
