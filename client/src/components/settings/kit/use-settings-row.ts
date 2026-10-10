import { registerSettingsRow } from "@/components/settings/kit/registry";
import { useSettingsSection } from "@/components/settings/kit/sections";

/**
 * Registers a row under the section the shell rendered it in. Called during
 * render on purpose (see `registry.ts`): it is idempotent and notifies nobody.
 *
 * `searchable: false` skips the registry and nothing else. A row built from
 * data rather than from the tab's own layout (a blocked person, a linked
 * account) is not a setting, and the phase 2 search must never list it. The
 * context read stays unconditional, because a hook may not be skipped.
 */
export function useSettingsRow(id: string, label: string, searchable = true): void {
  const section = useSettingsSection();
  if (section && searchable) {
    registerSettingsRow({ id, section, label });
  }
}
