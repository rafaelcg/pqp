import { registerSettingsRow } from "@/components/settings/kit/registry";
import { useSettingsSection } from "@/components/settings/kit/sections";

/**
 * Registers a row under the section the shell rendered it in. Called during
 * render on purpose (see `registry.ts`): it is idempotent and notifies nobody.
 */
export function useSettingsRow(id: string, label: string): void {
  const section = useSettingsSection();
  if (section) {
    registerSettingsRow({ id, section, label });
  }
}
