/**
 * Server settings is the discovery surface for the per-server Baú switch
 * (`servers.community_home_enabled`). The NEW sticker lives on that control
 * while the bit is still false.
 *
 * Do NOT put the toggle in channel settings, the /c/slug community listing
 * editor, or user settings. Fail closed: instance flag/latch off → omit the
 * row. Flag/latch on + MANAGE_SERVER → show it.
 */

export function shouldShowCommunityHomeSettingsRow(input: {
  /** Instance `COMMUNITY_HOME_ENABLED` (client: `isCommunityHomeEnabled`). */
  featureOn: boolean;
  /** Viewer holds MANAGE_SERVER on this server. */
  canManageServer: boolean;
}): boolean {
  return input.featureOn === true && input.canManageServer === true;
}

/**
 * NEW on the Server settings toggle while the per-server bit is still off
 * and this browser has not acted on the control yet. Opening the panel must
 * not clear it — that is how managers find the switch.
 */
export function shouldShowCommunityHomeSettingsNew(input: {
  enabled: boolean;
  settingsNew: boolean;
}): boolean {
  return input.enabled === false && input.settingsNew === true;
}
