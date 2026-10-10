import type { SettingsSectionId } from "@/components/settings/kit/sections";

/**
 * Every settings row that has rendered, by section.
 *
 * WHY A MODULE-LEVEL LIST. `openSection(section, rowId)` needs to know a row
 * exists before it scrolls to it, and the phase 2 search needs a flat list of
 * rows across tabs. Both outlive any one tab's mount, so the list does too: an
 * entry stays after its tab unmounts, and the last label written wins.
 *
 * WHY IT NEVER NOTIFIES ANYONE. Rows register during render. A list that told
 * React subscribers about it would be a state update inside another
 * component's render, which React warns about and which the "no console
 * errors" e2e checks fail on. Readers ask when they need it.
 *
 * Ids are kebab-case and unique within a section (`ptt`, `input-device`). They
 * are also what the DOM carries as `data-settings-row`, which is how
 * `openSection` finds the row on screen.
 */
export interface SettingsRowEntry {
  id: string;
  section: SettingsSectionId;
  label: string;
}

const rows = new Map<string, SettingsRowEntry>();

function keyOf(section: SettingsSectionId, id: string): string {
  return `${section}:${id}`;
}

/** Idempotent, so a row may call it on every render. */
export function registerSettingsRow(entry: SettingsRowEntry): void {
  const key = keyOf(entry.section, entry.id);
  const existing = rows.get(key);
  if (existing && existing.label === entry.label) {
    return;
  }
  rows.set(key, { ...entry });
}

export function findSettingsRow(
  section: SettingsSectionId,
  id: string,
): SettingsRowEntry | null {
  return rows.get(keyOf(section, id)) ?? null;
}

/** Every registered row, in registration order. */
export function listSettingsRows(
  section?: SettingsSectionId,
): readonly SettingsRowEntry[] {
  const all = [...rows.values()];
  return section ? all.filter((entry) => entry.section === section) : all;
}

/** Tests only: module state would otherwise leak between cases. */
export function resetSettingsRowsForTest(): void {
  rows.clear();
}
