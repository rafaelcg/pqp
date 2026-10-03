import { useMemo, useState } from "react";
import { Map as MapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ACTION_LABEL, GROUP_LABEL } from "@/components/layout/shortcut-overlay";
import {
  SettingsGroup,
  SettingsHeaderActions,
  SettingsLinkRow,
  SettingsNotice,
  SettingsRow,
  useSettingsShell,
} from "@/components/settings/kit";
import { KeyBindingField } from "@/components/voice/key-binding-field";
import { isApplePlatform } from "@/lib/composer-formatting";
import { findBindingConflict, resolveShortcutBindings, SHORTCUT_GROUPS, type BindableId, type ShortcutAction } from "@/lib/keyboard-shortcuts";
import { defaultPttBinding, formatBinding, supportsKeyBinding, type KeyBinding } from "@/components/voice/push-to-talk";
import { DEFAULT_RELEASE_DELAY_MS } from "@/lib/ptt-release-delay";
import { useTranslation } from "@/lib/i18n";
import { LocalSettings } from "@/components/settings/local-settings";

export function bindableMap(
  settings: LocalSettings,
): Record<BindableId, KeyBinding> {
  return {
    ...resolveShortcutBindings(settings.shortcuts, isApplePlatform()),
    pushToTalk: settings.pushToTalkKey,
  };
}

/** `toggleMute` becomes `toggle-mute`: the row id, stable because the action names are. */
function rowId(action: ShortcutAction): string {
  return action.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function KeyboardSection({
  draftLocal,
  patchLocal,
  onShowOverlay,
}: {
  draftLocal: LocalSettings;
  patchLocal: (partial: Partial<LocalSettings>) => void;
  onShowOverlay: () => void;
}) {
  const { t } = useTranslation();
  const { openSection } = useSettingsShell();
  const [confirmingReset, setConfirmingReset] = useState(false);
  const canBindKey = useMemo(() => supportsKeyBinding(), []);
  const bindings = useMemo(
    () => resolveShortcutBindings(draftLocal.shortcuts, isApplePlatform()),
    [draftLocal.shortcuts],
  );
  const owned = bindableMap(draftLocal);

  function remap(action: ShortcutAction, binding: KeyBinding) {
    if (findBindingConflict(owned, action, binding)) {
      return;
    }
    patchLocal({
      shortcuts: { ...draftLocal.shortcuts, [action]: binding },
    });
  }

  function takenBy(action: BindableId) {
    return (binding: KeyBinding) => {
      const conflict = findBindingConflict(owned, action, binding);
      return conflict ? t(ACTION_LABEL[conflict]) : null;
    };
  }

  function resetAll() {
    patchLocal({
      shortcuts: {},
      pushToTalkKey: defaultPttBinding(),
      pttReleaseDelayMs: DEFAULT_RELEASE_DELAY_MS,
    });
  }

  return (
    <div className="space-y-6">
      <SettingsHeaderActions>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onShowOverlay}
        >
          <MapIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {t("settings.keyboard.showMap")}
        </Button>
      </SettingsHeaderActions>

      {canBindKey ? (
        SHORTCUT_GROUPS.map((group) => (
          <SettingsGroup key={group.id} title={t(GROUP_LABEL[group.id])}>
            {group.actions.map((action) => (
              <SettingsRow
                key={action}
                id={rowId(action)}
                label={t(ACTION_LABEL[action])}
                control={
                  <KeyBindingField
                    label={t(ACTION_LABEL[action])}
                    binding={bindings[action]}
                    takenBy={takenBy(action)}
                    onChange={(binding) => remap(action, binding)}
                  />
                }
              />
            ))}
            {group.id === "voice" && (
              // Push-to-talk is set in Voz e vídeo only (spec J3); this row
              // shows the key and jumps there.
              <SettingsLinkRow
                id="push-to-talk"
                label={t(ACTION_LABEL.pushToTalk)}
                description={t("settings.keyboard.pttLink", {
                  binding: formatBinding(draftLocal.pushToTalkKey),
                })}
                onClick={() => openSection("voice", "ptt")}
              />
            )}
          </SettingsGroup>
        ))
      ) : (
        <SettingsNotice tone="info">
          {t("settings.voice.pttNoKeyboard")}
        </SettingsNotice>
      )}

      <SettingsGroup title={t("settings.keyboard.group.defaults.title")}>
        <SettingsRow
          id="reset-all"
          label={t("settings.keyboard.resetAll.label")}
          description={t("settings.keyboard.resetAll.description")}
          control={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConfirmingReset(true)}
            >
              {t("settings.keyboard.reset")}
            </Button>
          }
        />
      </SettingsGroup>

      <ConfirmDialog
        open={confirmingReset}
        title={t("settings.keyboard.resetConfirm.title")}
        description={t("settings.keyboard.resetAll.description")}
        confirmLabel={t("settings.keyboard.resetConfirm.confirm")}
        cancelLabel={t("settings.keyboard.resetConfirm.cancel")}
        destructive={false}
        onConfirm={resetAll}
        onClose={() => setConfirmingReset(false)}
      />
    </div>
  );
}
