import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ACTION_LABEL, GROUP_LABEL } from "@/components/layout/shortcut-overlay";
import { KeyBindingField } from "@/components/voice/key-binding-field";
import { isApplePlatform } from "@/lib/composer-formatting";
import { findBindingConflict, resolveShortcutBindings, SHORTCUT_GROUPS, type BindableId, type ShortcutAction } from "@/lib/keyboard-shortcuts";
import { defaultPttBinding, supportsKeyBinding, type KeyBinding, type PttBinding } from "@/components/voice/push-to-talk";
import { DEFAULT_RELEASE_DELAY_MS } from "@/lib/ptt-release-delay";
import { PttBindingField } from "@/components/voice/key-binding-field";
import { isDesktopApp } from "@/lib/desktop";
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
  const isDesktop = isDesktopApp();
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

  /** Same conflict rule as `takenBy`, widened for a `PttBinding` that might be a mouse button, which can never collide with a keyboard-only app shortcut. */
  function pttTakenBy(binding: PttBinding) {
    if (binding.device === "mouse") {
      return null;
    }
    return takenBy("pushToTalk")(binding);
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-paper-muted">{t("settings.keyboard.hint")}</p>
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="secondary"
          className="w-full whitespace-normal"
          onClick={onShowOverlay}
        >
          {t("settings.keyboard.showMap")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="w-full whitespace-normal"
          onClick={() =>
            patchLocal({
              shortcuts: {},
              pushToTalkKey: defaultPttBinding(),
              pttReleaseDelayMs: DEFAULT_RELEASE_DELAY_MS,
            })
          }
        >
          {t("settings.keyboard.reset")}
        </Button>
      </div>
      {canBindKey ? (
        <div className="space-y-6">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.id}>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-paper-muted">
                {t(GROUP_LABEL[group.id])}
              </h4>
              <ul className="divide-y divide-ink-4/70">
                {group.actions.map((action) => (
                  <li key={action} className="py-3">
                    <KeyBindingField
                      label={t(ACTION_LABEL[action])}
                      binding={bindings[action]}
                      takenBy={takenBy(action)}
                      onChange={(binding) => remap(action, binding)}
                    />
                  </li>
                ))}
                {group.id === "voice" && (
                  <li className="py-3">
                    <PttBindingField
                      label={t(
                        isDesktop
                          ? "settings.voice.pttKeyOrMouse"
                          : ACTION_LABEL.pushToTalk,
                      )}
                      binding={draftLocal.pushToTalkKey}
                      allowMouse={isDesktop}
                      takenBy={pttTakenBy}
                      onChange={(binding) =>
                        patchLocal({ pushToTalkKey: binding })
                      }
                    />
                  </li>
                )}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <p className="text-xs text-paper-muted">
          {t("settings.voice.pttNoKeyboard")}
        </p>
      )}
      <p className="text-xs text-paper-muted">{t("settings.keyboard.pttNote")}</p>
    </div>
  );
}
