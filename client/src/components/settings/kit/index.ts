/**
 * The settings kit: the blocks every Settings tab is composed from, and
 * nothing else. A block that is missing goes to the lead; a tab never grows a
 * local copy. The grammar and the reasons are in
 * `docs/plans/SETTINGS_REDESIGN_SPEC.md` section E, and the live sheet is the
 * "Settings kit" section of `/qa/ui`.
 */
export { SettingsBuildLine, formatBuildLine } from "@/components/settings/kit/build-line";
export {
  SETTINGS_COPIED_MS,
  SettingsCopyButton,
  useCopyText,
  type SettingsCopyButtonProps,
} from "@/components/settings/kit/copy-button";
export {
  SETTINGS_DESCRIPTION,
  SETTINGS_FOCUS,
  SETTINGS_INSET_FOCUS,
  SETTINGS_LABEL,
  SETTINGS_TRANSITION,
} from "@/components/settings/kit/classes";
export {
  SettingsChoiceGrid,
  type SettingsChoice,
} from "@/components/settings/kit/choice-grid";
export { SettingsEmpty } from "@/components/settings/kit/empty";
export { flashSettingsRow } from "@/components/settings/kit/flash-row";
export { SettingsGroup } from "@/components/settings/kit/group";
export { SettingsInlineStatus } from "@/components/settings/kit/inline-status";
export {
  SettingsKeyCombo,
  SettingsKeycap,
  isModifierKeyLabel,
} from "@/components/settings/kit/keycap";
export { SettingsLinkRow, type SettingsLinkRowProps } from "@/components/settings/kit/link-row";
export { SettingsNotice } from "@/components/settings/kit/notice";
export { SettingsPaneHeader } from "@/components/settings/kit/pane-header";
export { SettingsPreview } from "@/components/settings/kit/preview";
export {
  findSettingsRow,
  listSettingsRows,
  registerSettingsRow,
  type SettingsRowEntry,
} from "@/components/settings/kit/registry";
export { SettingsRow, type SettingsRowProps } from "@/components/settings/kit/row";
export {
  SettingsSectionContext,
  useSettingsSection,
  type SettingsSectionId,
} from "@/components/settings/kit/sections";
export { SettingsSelect } from "@/components/settings/kit/select";
export {
  SettingsHeaderActions,
  SettingsShellContext,
  useSettingsShell,
  type SettingsShellValue,
} from "@/components/settings/kit/shell-context";
export {
  SettingsSliderRow,
  type SettingsSliderRowProps,
} from "@/components/settings/kit/slider-row";
export {
  SettingsSwitchRow,
  type SettingsSwitchRowProps,
} from "@/components/settings/kit/switch-row";
export {
  UnsavedChangesBar,
  type UnsavedChangesBarProps,
} from "@/components/settings/kit/unsaved-bar";
export {
  INLINE_SAVED_MS,
  inlineErrorMessage,
  useInlineSave,
  type InlineSaveState,
  type UseInlineSaveOptions,
} from "@/components/settings/kit/use-inline-save";
