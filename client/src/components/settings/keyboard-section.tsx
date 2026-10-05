import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Info, Keyboard, Map as MapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ACTION_LABEL, GROUP_LABEL } from "@/components/layout/shortcut-overlay";
import {
  SettingsGroup,
  SettingsHeaderActions,
  SettingsKeyCombo,
  SettingsLinkRow,
  SettingsNotice,
  SettingsRow,
  useSettingsShell,
} from "@/components/settings/kit";
import {
  KeyBindingField,
  KeyBindingRefusalStatus,
  bindingKeycaps,
  type KeyBindingRefusal,
} from "@/components/voice/key-binding-field";
import { isApplePlatform } from "@/lib/composer-formatting";
import { findBindingConflict, resolveShortcutBindings, SHORTCUT_GROUPS, type BindableId, type ShortcutAction } from "@/lib/keyboard-shortcuts";
import { defaultPttBinding, supportsKeyBinding, type KeyBinding } from "@/components/voice/push-to-talk";
import { isDesktopApp } from "@/lib/desktop";
import { DEFAULT_RELEASE_DELAY_MS } from "@/lib/ptt-release-delay";
import { useTranslation } from "@/lib/i18n";
import { LocalSettings } from "@/components/settings/local-settings";

/**
 * Every key that is in use, to check a new binding against. Push-to-talk owns
 * its key only while the input mode is push-to-talk: on voice activity that
 * key does nothing, so a shortcut may take it.
 */
export function bindableMap(
  settings: LocalSettings,
): Partial<Record<BindableId, KeyBinding>> {
  const shortcuts = resolveShortcutBindings(settings.shortcuts, isApplePlatform());
  return settings.inputMode === "push-to-talk"
    ? { ...shortcuts, pushToTalk: settings.pushToTalkKey }
    : shortcuts;
}

/**
 * Chords a browser keeps for itself: the page never sees them, so a shortcut
 * bound to one can never fire. Only the ones that are reserved in every
 * mainstream browser, with the app's own modifier (Cmd on Apple, Ctrl
 * elsewhere): close tab, new tab, new window, jump to tab 1 to 9, and quit on
 * a Mac. Reload, print and save are not here, because a page may take those.
 *
 * Cmd/Ctrl + Shift + N (a private window) is deliberately not here either.
 * It is reserved in Chromium, but that is not yet checked in the other
 * browsers, and it is the default for a new direct message, so listing it
 * would put a warning on a key nobody changed. Test the defaults in real
 * Chrome, Edge and Firefox first.
 */
export function isBrowserReservedChord(
  binding: KeyBinding,
  apple: boolean,
): boolean {
  const primary = apple ? binding.meta : binding.ctrl;
  const other = apple ? binding.ctrl : binding.meta;
  if (!primary || other || binding.alt) {
    return false;
  }
  if (binding.shift) {
    return binding.code === "KeyT" || binding.code === "KeyW";
  }
  if (/^Digit[1-9]$/.test(binding.code)) {
    return true;
  }
  if (binding.code === "KeyW" || binding.code === "KeyT" || binding.code === "KeyN") {
    return true;
  }
  return apple && binding.code === "KeyQ";
}

/**
 * Whether a physical key has been pressed here. `supportsKeyBinding` asks the
 * primary pointer, which a tablet with a keyboard case gets wrong; a real
 * keydown is better evidence than any media query.
 */
function useSawKeyboard(enabled: boolean): boolean {
  const [saw, setSaw] = useState(false);
  useEffect(() => {
    if (!enabled || saw) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // A soft keyboard sends keydowns with no `code`.
      if (event.code && event.code !== "Unidentified") {
        setSaw(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled, saw]);
  return saw;
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
  // Each field hands its refusal up, so the row draws it under its label
  // (spec G: "inline under the row") rather than under the keycaps.
  const [refusals, setRefusals] = useState<
    Partial<Record<ShortcutAction, KeyBindingRefusal>>
  >({});
  const reportRefusal = useCallback(
    (action: ShortcutAction) => (refusal: KeyBindingRefusal | null) => {
      setRefusals((current) => {
        const prev = current[action];
        if (
          prev?.message === refusal?.message &&
          prev?.id === refusal?.id &&
          prev?.attempted === refusal?.attempted
        ) {
          return current;
        }
        const next = { ...current };
        if (refusal) {
          next[action] = refusal;
        } else {
          delete next[action];
        }
        return next;
      });
    },
    [],
  );
  const supported = useMemo(() => supportsKeyBinding(), []);
  const sawKeyboard = useSawKeyboard(!supported);
  const canBindKey = supported || sawKeyboard;
  const apple = isApplePlatform();
  const desktop = isDesktopApp();
  const bindings = useMemo(
    () => resolveShortcutBindings(draftLocal.shortcuts, isApplePlatform()),
    [draftLocal.shortcuts],
  );
  const owned = bindableMap(draftLocal);
  const pttCombo = bindingKeycaps(draftLocal.pushToTalkKey, apple);
  const pttOn = draftLocal.inputMode === "push-to-talk";

  function remap(action: ShortcutAction, binding: KeyBinding) {
    if (findBindingConflict(owned, action, binding)) {
      return;
    }
    patchLocal({
      shortcuts: { ...draftLocal.shortcuts, [action]: binding },
    });
  }

  // "Trocar com X": this action takes the chord and the other one takes this
  // action's old chord, so neither is left without a key. Push-to-talk is a
  // different kind of binding, set in Voz e vídeo, so it is never swapped.
  function swap(action: ShortcutAction, binding: KeyBinding) {
    const other = findBindingConflict(owned, action, binding);
    if (!other || other === "pushToTalk") {
      return;
    }
    patchLocal({
      shortcuts: {
        ...draftLocal.shortcuts,
        [action]: binding,
        [other]: bindings[action],
      },
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

  if (!canBindKey) {
    return (
      <div className="space-y-6">
        <SettingsNotice tone="info" icon={Keyboard} role="note">
          {t("settings.keyboard.noKeyboard")}
        </SettingsNotice>
      </div>
    );
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

      {SHORTCUT_GROUPS.map((group) => {
        // A behaviour fact, not how-to: a key with neither Ctrl nor Cmd
        // stands down in a text field (`matchShortcut`), so Alt + arrows
        // move the caret. Said once for a group where it holds for every key
        // as bound now (by default that is Canais alone); in any other group
        // the row that breaks the rule says it itself.
        const typingNote = group.actions.every(
          (action) => !bindings[action].ctrl && !bindings[action].meta,
        );
        return (
          <SettingsGroup
            key={group.id}
            title={t(GROUP_LABEL[group.id])}
            description={
              typingNote ? t("settings.keyboard.group.typingNote") : undefined
            }
          >
            {group.actions.map((action) => {
              const refusal = refusals[action];
              const binding = bindings[action];
              const label = t(ACTION_LABEL[action]);
              const owner = refusal?.attempted
                ? findBindingConflict(owned, action, refusal.attempted)
                : null;
              const swappable =
                owner && owner !== "pushToTalk" ? owner : null;
              const loose = !binding.ctrl && !binding.meta && !typingNote;
              const reserved = !desktop && isBrowserReservedChord(binding, apple);
              return (
                <Fragment key={action}>
                  <SettingsRow
                    id={rowId(action)}
                    label={label}
                    status={
                      refusal ? (
                        <div id={refusal.id}>
                          <KeyBindingRefusalStatus message={refusal.message} />
                          {swappable && refusal.attempted ? (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              className="mt-2"
                              aria-keyshortcuts="Enter"
                              // Keeps focus on the field, which would end the
                              // capture and take this button away before the
                              // click lands.
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => swap(action, refusal.attempted!)}
                            >
                              {t("settings.keyboard.swap", {
                                action: t(ACTION_LABEL[swappable]),
                              })}
                            </Button>
                          ) : null}
                        </div>
                      ) : loose ? (
                        <p
                          role="note"
                          className="mt-1.5 flex items-start gap-1.5 text-xs text-text-tertiary"
                        >
                          <Info
                            aria-hidden
                            className="mt-px h-3.5 w-3.5 shrink-0"
                          />
                          <span className="min-w-0 text-pretty">
                            {t("settings.keyboard.looseKeyHint")}
                          </span>
                        </p>
                      ) : undefined
                    }
                    control={
                      <KeyBindingField
                        label={label}
                        hideLabel
                        binding={binding}
                        takenBy={takenBy(action)}
                        onChange={(next) => remap(action, next)}
                        onSwap={(next) => swap(action, next)}
                        // Push-to-talk is set in Voz e vídeo, never swapped.
                        canSwap={(next) =>
                          findBindingConflict(owned, action, next) !== "pushToTalk"
                        }
                        onRefusedChange={reportRefusal(action)}
                      />
                    }
                  />
                  {reserved ? (
                    <SettingsNotice tone="warning" inGroup role="note">
                      {t("settings.keyboard.browserReserved")}
                    </SettingsNotice>
                  ) : null}
                </Fragment>
              );
            })}
            {group.id === "voice" && (
              // Push-to-talk is set in Voz e vídeo only (spec J3); this row
              // shows the key and jumps there. With the mode on Por voz the
              // key does nothing, so it says so instead of showing one.
              <SettingsLinkRow
                id="push-to-talk"
                label={t(ACTION_LABEL.pushToTalk)}
                description={t(
                  pttOn
                    ? "settings.keyboard.pttLink"
                    : "settings.keyboard.pttOffHint",
                )}
                value={
                  pttOn ? (
                    <SettingsKeyCombo
                      keys={pttCombo.keys}
                      label={pttCombo.label}
                    />
                  ) : (
                    <span className="inline-flex h-6 items-center rounded-full border border-border px-2.5 text-xs text-text-tertiary">
                      {t("settings.keyboard.pttOff")}
                    </span>
                  )
                }
                onClick={() => openSection("voice", "ptt")}
              />
            )}
          </SettingsGroup>
        );
      })}

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
        description={t("settings.keyboard.resetConfirm.body")}
        confirmLabel={t("settings.keyboard.resetConfirm.confirm")}
        cancelLabel={t("settings.keyboard.resetConfirm.cancel")}
        destructive={false}
        // It cannot be undone and it also clears push-to-talk, set in Voz:
        // a reflex second Enter must land on Cancel.
        initialFocus="cancel"
        onConfirm={resetAll}
        onClose={() => setConfirmingReset(false)}
      />
    </div>
  );
}
