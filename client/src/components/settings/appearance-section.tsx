import { Lock } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { RadioGroup, useRovingRadio } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import { UserAvatar } from "@/components/user/user-avatar";
import { useAccentHue } from "@/hooks/use-accent-hue";
import { useAppearance } from "@/hooks/use-appearance";
import { useChatDisplay } from "@/hooks/use-chat-display";
import { useContrast } from "@/hooks/use-contrast";
import { useTheme } from "@/hooks/use-theme";
import { DEFAULT_CHAT_DISPLAY, type ChatDensity } from "@/lib/chat-display";
import { getDesktop } from "@/lib/desktop";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { SUPPORTED_LOCALES, setLocalePreference, type Locale } from "@/lib/locale";
import { ACCENT_SWATCHES, effectiveAccentHue, type AccentHuePreference } from "@/lib/accent";
import type { AppearancePreference } from "@/lib/appearance";
import type { ContrastPreference } from "@/lib/contrast";
import type { ThemePreference } from "@/lib/theme";
import { queuePreferenceSync, usePreferenceSyncFailed } from "@/lib/preferences";
import { cn } from "@/lib/utils";
import {
  SETTINGS_FOCUS,
  SETTINGS_TRANSITION,
  SettingsChoiceGrid,
  SettingsGroup,
  SettingsInlineStatus,
  SettingsNotice,
  SettingsRow,
  SettingsSwitchRow,
  useSettingsShell,
} from "@/components/settings/kit";

/** The account preferences this tab writes: the notice reads their sync. */
const SYNCED_KEYS = [
  "theme",
  "appearance",
  "accentHue",
  "contrast",
  "chatDisplay",
  "showLinkEmbeds",
] as const;

/**
 * Aparência e idioma. Every control here applies and persists on the spot:
 * theme, look, accent and contrast through their own stores (the boot script
 * reads them before first paint), the chat display through its store, link
 * previews through `patchLocal`, the language through a reload. Nothing is
 * staged, so nothing here ever shows a Save button.
 */
export function AppearanceSection({
  showLinkEmbeds,
  onShowLinkEmbeds,
}: {
  showLinkEmbeds: boolean;
  onShowLinkEmbeds: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const syncFailed = usePreferenceSyncFailed(SYNCED_KEYS);
  return (
    <div className="space-y-6">
      {syncFailed ? (
        // Sticky: the choice that failed is usually further down the tab,
        // and a line above the fold would never be seen.
        <div className="sticky top-2 z-10">
          <SettingsNotice tone="warning" role="alert">
            {t("settings.syncFailed")}
          </SettingsNotice>
        </div>
      ) : null}
      <ThemeGroup />
      <ChatGroup
        showLinkEmbeds={showLinkEmbeds}
        onShowLinkEmbeds={onShowLinkEmbeds}
      />
      <LanguageGroup />
      <DesktopGroup />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------------

function ThemeGroup() {
  const { t } = useTranslation();
  return (
    <SettingsGroup title={t("settings.appearance.group.theme.title")}>
      <BrightnessRow />
      <LookRow />
      <AccentRow />
      <ContrastRow />
    </SettingsGroup>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: MessageKey }[] = [
  { value: "light", label: "settings.appearance.theme.light" },
  { value: "dark", label: "settings.appearance.theme.dark" },
  { value: "system", label: "settings.appearance.theme.system" },
];

/**
 * On a phone every option is at least 44px tall. The shared `RadioGroup` draws
 * 36 to 40px there, and takes no per-option class, so the target comes from the
 * group: this selector wins over the button's own height by specificity.
 */
const PHONE_TARGETS = "max-sm:[&>[role=radio]]:h-11";

/**
 * Where "the mode before Night" is remembered. Night pins the mode to dark and
 * the theme store writes that over the account's choice, so without this note
 * leaving Night would leave a person who used Light (or Automático) on Dark.
 * Local to this browser on purpose: another device has its own history.
 */
export const MODE_BEFORE_NIGHT_KEY = "pqp:mode-before-night";

export function rememberModeBeforeNight(mode: ThemePreference): void {
  try {
    localStorage.setItem(MODE_BEFORE_NIGHT_KEY, mode);
  } catch {
    // Remembering is a convenience; leaving Night then stays on Dark.
  }
}

/** The remembered mode, once. Reading it forgets it. */
export function takeModeBeforeNight(): ThemePreference | null {
  try {
    const raw = localStorage.getItem(MODE_BEFORE_NIGHT_KEY);
    localStorage.removeItem(MODE_BEFORE_NIGHT_KEY);
    return raw === "light" || raw === "dark" || raw === "system" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Mode (claro, escuro, automático). Not part of `LocalSettings`: it applies on
 * click and persists under its own key so the boot script can read it without
 * parsing the audio blob. Night is a dark-only look, so it shows dark and locks
 * the other two. A locked option stays focusable by pointer and explains
 * itself, instead of being a dead button.
 */
function BrightnessRow() {
  const { t } = useTranslation();
  const { appearance } = useAppearance();
  const { preference, resolved, setPreference } = useTheme();
  const nightLocked = appearance === "night";
  const shown = nightLocked ? "dark" : preference;

  const description = nightLocked
    ? t("settings.appearance.themeNightLocked")
    : preference === "system"
      ? t("settings.appearance.themeFollowing", {
          theme: t(
            resolved === "light"
              ? "settings.appearance.resolved.light"
              : "settings.appearance.resolved.dark",
          ),
        })
      : t("settings.appearance.themeHint");

  return (
    <SettingsRow
      id="brightness"
      label={t("settings.appearance.theme")}
      description={description}
      control={
        <LockableSegmented
          label={t("settings.appearance.theme")}
          value={shown}
          onValueChange={(next) => {
            if (!nightLocked) {
              setPreference(next);
            }
          }}
          lockedHint={t("settings.appearance.themeNightTip")}
          options={THEME_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
            locked: nightLocked && option.value !== "dark",
          }))}
        />
      }
    />
  );
}

/**
 * A segmented control whose locked options say why. Same roles and keyboard
 * model as `RadioGroup` (the group and each radio keep their names, the arrows
 * skip locked options), but a locked option is `aria-disabled` rather than
 * `disabled`: it still takes the pointer, wears a lock, and shows a tip on
 * hover, focus or tap. `RadioGroup` has no slot for any of that, so it lives
 * here.
 */
function LockableSegmented<T extends string>({
  label,
  value,
  onValueChange,
  options,
  lockedHint,
}: {
  label: string;
  value: T;
  onValueChange: (next: T) => void;
  options: { value: T; label: string; locked: boolean }[];
  lockedHint: string;
}) {
  const baseId = useId();
  const [tipFor, setTipFor] = useState<T | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { onKeyDown, tabIndexFor } = useRovingRadio(
    options.map((option) => option.value),
    value,
    onValueChange,
    (v) => Boolean(options.find((option) => option.value === v)?.locked),
  );

  useEffect(
    () => () => {
      if (tipTimer.current) {
        clearTimeout(tipTimer.current);
      }
    },
    [],
  );

  function showTip(option: T) {
    // Touch has no hover, so a tap on a locked option shows the tip for a moment.
    setTipFor(option);
    if (tipTimer.current) {
      clearTimeout(tipTimer.current);
    }
    tipTimer.current = setTimeout(() => setTipFor(null), 2500);
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      // Each cell is as wide as its label plus the lock, never cut: the equal
      // cells of `RadioGroup` would shorten "Automático" once it wears a lock.
      className="inline-flex max-w-full flex-wrap gap-0.5 rounded-[var(--radius-control)] border border-border bg-surface-0 p-0.5"
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        const tipId = `${baseId}-${index}-tip`;
        return (
          <span key={option.value} className="group/option relative flex shrink-0">
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              aria-disabled={option.locked || undefined}
              aria-describedby={option.locked ? tipId : undefined}
              tabIndex={tabIndexFor(option.value)}
              onClick={() => {
                if (option.locked) {
                  showTip(option.value);
                } else if (!checked) {
                  onValueChange(option.value);
                }
              }}
              className={cn(
                "inline-flex h-11 items-center justify-center gap-1.5 rounded-[var(--radius-control)] px-3 text-sm whitespace-nowrap sm:h-8",
                SETTINGS_TRANSITION,
                SETTINGS_FOCUS,
                checked ? "bg-surface-2 font-medium text-text" : "text-text-tertiary",
                !checked && !option.locked && "hover:text-text",
                option.locked && "cursor-not-allowed opacity-45",
              )}
            >
              {option.locked ? (
                <Lock aria-hidden className="h-3 w-3 shrink-0" strokeWidth={2} />
              ) : null}
              {option.label}
            </button>
            {option.locked ? (
              <span
                id={tipId}
                role="tooltip"
                className={cn(
                  "elevation-3 pointer-events-none absolute top-full z-10 mt-2 rounded-[var(--radius-control)] px-2.5 py-1.5 text-xs whitespace-nowrap text-text",
                  index === 0 ? "left-0" : "right-0",
                  tipFor === option.value
                    ? "block"
                    : "hidden group-hover/option:block group-focus-within/option:block",
                )}
              >
                {lockedHint}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

const LOOK_OPTIONS: {
  value: AppearancePreference;
  label: MessageKey;
  badge?: MessageKey;
}[] = [
  {
    value: "signal",
    label: "settings.appearance.preset.signal",
    badge: "settings.appearance.preset.signalDefault",
  },
  { value: "harmony", label: "settings.appearance.preset.harmony" },
  { value: "hearth", label: "settings.appearance.preset.hearth" },
  {
    value: "night",
    label: "settings.appearance.preset.night",
    badge: "settings.appearance.preset.nightOnly",
  },
];

function LookRow() {
  const { t } = useTranslation();
  const { appearance, setAppearance } = useAppearance();
  const { preference, resolved, setPreference } = useTheme();
  const { preference: accentPreference } = useAccentHue();
  // The miniatures are drawn the way the app would look after the pick: in the
  // current mode and, when there is one, in the person's own accent. Night is
  // dark whatever the mode is.
  const mode = appearance === "night" ? "dark" : resolved;
  const customAccent = accentPreference !== "default";

  function choose(next: AppearancePreference) {
    if (next === appearance) {
      return;
    }
    if (next === "night") {
      // Choosing Night pins the mode to dark. Note what it was first.
      rememberModeBeforeNight(preference);
      setAppearance(next);
      return;
    }
    setAppearance(next);
    if (appearance === "night") {
      const before = takeModeBeforeNight();
      if (before && before !== "dark") {
        setPreference(before);
      }
    }
  }

  return (
    <SettingsRow
      id="look"
      label={t("settings.appearance.preset")}
      description={t("settings.appearance.presetHint")}
      stacked
      control={
        <SettingsChoiceGrid
          label={t("settings.appearance.preset")}
          value={appearance}
          onValueChange={choose}
          columns={4}
          options={LOOK_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
            badge: option.badge ? t(option.badge) : undefined,
            preview: (
              <LookMiniature
                look={option.value}
                mode={mode}
                customAccent={customAccent}
              />
            ),
          }))}
        />
      }
    />
  );
}

/**
 * A look's own accent, as the stylesheet would paint it in a mode: the dark
 * swatch, or that swatch mixed toward black for light. For the places that
 * must show it while a custom accent is overriding `--color-accent`.
 */
function lookAccent(look: AppearancePreference, mode: "light" | "dark"): string {
  const swatch = `var(--swatch-${look}-accent)`;
  return mode === "light" && look !== "night"
    ? `color-mix(in oklch, ${swatch} 62%, black)`
    : swatch;
}

/**
 * Miniature app chrome in the look's own swatches. The drawing is the
 * `appearance-preview*` recipe in `index.css`; only the colours vary.
 *
 * The swatches are dark. A light miniature is the same swatch mixed toward
 * white (and its ink flipped to the near-black rail), so nothing here is a new
 * colour, only a mix of ones the stylesheet already defines. A custom accent
 * wears the live accent token, which already follows the mode.
 */
function LookMiniature({
  look,
  mode,
  customAccent,
}: {
  look: AppearancePreference;
  mode: "light" | "dark";
  customAccent: boolean;
}) {
  const light = mode === "light" && look !== "night";
  const swatch = (part: string) => `var(--swatch-${look}-${part})`;
  const toward = (part: string, share: number) =>
    `color-mix(in oklch, ${swatch(part)} ${share}%, white)`;
  // The live accent token follows the page's mode, so it only suits a card
  // drawn in that same mode (Night stays dark on a light page).
  const accent =
    customAccent && (light ? "light" : "dark") === mode
      ? "var(--color-accent)"
      : lookAccent(look, mode);
  const style = (
    light
      ? ({
          "--preview-rail": toward("rail", 18),
          "--preview-list": toward("list", 12),
          "--preview-surface": toward("surface", 5),
          "--preview-accent": accent,
          "--swatch-ink": "var(--swatch-signal-rail)",
        } as CSSProperties)
      : ({
          "--preview-rail": swatch("rail"),
          "--preview-list": swatch("list"),
          "--preview-surface": swatch("surface"),
          "--preview-accent": accent,
        } as CSSProperties)
  );
  return (
    <span className="appearance-preview" style={style}>
      <span className="appearance-preview-rail" />
      <span className="appearance-preview-list">
        <span className="appearance-preview-channel" />
        <span className="appearance-preview-channel" />
        <span className="appearance-preview-channel" />
      </span>
      <span className="appearance-preview-chat">
        <span className="appearance-preview-message" />
        <span className="appearance-preview-message" />
        <span className="appearance-preview-message" />
        <span className="appearance-preview-composer" />
      </span>
    </span>
  );
}

/** The eight suggested hues, by the name a person would give the colour. */
const SWATCH_NAMES: Record<(typeof ACCENT_SWATCHES)[number], MessageKey> = {
  15: "settings.appearance.swatch.red",
  80: "settings.appearance.swatch.orange",
  125: "settings.appearance.swatch.green",
  180: "settings.appearance.swatch.teal",
  210: "settings.appearance.swatch.cyan",
  255: "settings.appearance.swatch.blue",
  300: "settings.appearance.swatch.purple",
  340: "settings.appearance.swatch.pink",
};

/** Hue 360 is hue 0, so the slider stops one short of the wrap. */
const ACCENT_SLIDER_MAX = 359;

/** The accent radios: "Do visual" first, then the eight named hues. */
const ACCENT_CHOICES: readonly (AccentHuePreference)[] = [
  "default",
  ...ACCENT_SWATCHES,
];

/**
 * The accent. A hue slider for any colour, with its value spelled out beside
 * it, then one radio group: "Do visual" (no custom accent) and the eight named
 * hues. "Voltar à cor do visual" only shows while a custom accent is set. The
 * reset sits outside the radiogroup's key handler, so an arrow pressed on it
 * never picks a swatch.
 */
function AccentRow() {
  const { t } = useTranslation();
  const { appearance } = useAppearance();
  const { resolved } = useTheme();
  const { preference, setPreference } = useAccentHue();
  const sliderHue = Math.min(
    ACCENT_SLIDER_MAX,
    effectiveAccentHue(preference, appearance),
  );
  const isCustom = preference !== "default";
  const sliderRef = useRef<HTMLDivElement>(null);
  const { onKeyDown, tabIndexFor } = useRovingRadio<AccentHuePreference>(
    ACCENT_CHOICES,
    preference,
    (choice) => setPreference(choice, { immediate: true }),
  );

  const swatchName = (hue: number): string | null =>
    hue in SWATCH_NAMES
      ? t(SWATCH_NAMES[hue as keyof typeof SWATCH_NAMES])
      : null;
  const valueText = isCustom
    ? (swatchName(preference) ?? t("settings.appearance.accentHue", { hue: preference }))
    : t("settings.appearance.accentFromLook");

  function reset() {
    setPreference("default", { immediate: true });
    // The button hides itself, so focus would drop to the page. The slider
    // shows what the reset did, so focus lands there.
    requestAnimationFrame(() => {
      sliderRef.current?.querySelector<HTMLElement>('[role="slider"]')?.focus();
    });
  }

  return (
    <SettingsRow
      id="accent"
      label={t("settings.appearance.accent")}
      description={
        isCustom
          ? t("settings.appearance.accentCustomHint")
          : t("settings.appearance.accentDefaultHint")
      }
      stacked
      control={
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div ref={sliderRef} className="min-w-0 flex-1">
              <Slider
                variant="hue"
                min={0}
                max={ACCENT_SLIDER_MAX}
                value={sliderHue}
                aria-label={t("settings.appearance.accent")}
                aria-valuetext={
                  isCustom
                    ? valueText
                    : `${valueText}, ${t("settings.appearance.accentHue", { hue: sliderHue })}`
                }
                onValueChange={(hue) => setPreference(hue as AccentHuePreference)}
              />
            </div>
            <span
              aria-hidden
              className="w-20 shrink-0 truncate text-right text-xs text-text-secondary"
            >
              {valueText}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 max-sm:gap-3">
            <div
              role="radiogroup"
              aria-label={t("settings.appearance.accent")}
              onKeyDown={onKeyDown}
              className="flex flex-wrap items-center gap-2 max-sm:gap-3"
            >
              <button
                type="button"
                role="radio"
                aria-checked={!isCustom}
                tabIndex={tabIndexFor("default")}
                onClick={() => setPreference("default", { immediate: true })}
                className={cn(
                  "relative inline-flex h-7 items-center gap-1.5 rounded-full border py-0 pr-2.5 pl-1.5 text-xs max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']",
                  SETTINGS_TRANSITION,
                  SETTINGS_FOCUS,
                  !isCustom
                    ? "border-accent bg-accent-soft font-medium text-on-accent-soft"
                    : "border-border text-text-secondary hover:bg-surface-2 hover:text-text",
                )}
              >
                {/* The look's own accent, whatever custom one is set: the chip
                    names the option, and the option is "the look's colour". */}
                <span
                  aria-hidden
                  className={cn("h-4 w-4 rounded-full", !isCustom && "bg-accent")}
                  style={
                    isCustom
                      ? { backgroundColor: lookAccent(appearance, resolved) }
                      : undefined
                  }
                />
                {t("settings.appearance.accentFromLook")}
              </button>
              {ACCENT_SWATCHES.map((hue) => {
                const name = t(SWATCH_NAMES[hue]);
                return (
                  <button
                    key={hue}
                    type="button"
                    role="radio"
                    aria-label={name}
                    title={name}
                    aria-checked={preference === hue}
                    tabIndex={tabIndexFor(hue)}
                    onClick={() => setPreference(hue, { immediate: true })}
                    className={cn(
                      "accent-hue-dot relative h-7 w-7 rounded-full border-2 transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']",
                      SETTINGS_FOCUS,
                      preference === hue
                        ? "border-text"
                        : "border-transparent hover:border-border-strong",
                    )}
                    style={{ "--swatch-hue": String(hue) } as CSSProperties}
                  />
                );
              })}
            </div>
            {isCustom ? (
              <Button
                variant="secondary"
                size="sm"
                className="ml-auto max-sm:h-11"
                onClick={reset}
              >
                {t("settings.appearance.accentReset")}
              </Button>
            ) : null}
          </div>
        </div>
      }
    />
  );
}

const CONTRAST_OPTIONS: { value: ContrastPreference; label: MessageKey }[] = [
  { value: "default", label: "settings.appearance.contrast.default" },
  { value: "more", label: "settings.appearance.contrast.more" },
  { value: "system", label: "settings.appearance.contrast.system" },
];

function ContrastRow() {
  const { t } = useTranslation();
  const { preference, resolved, setPreference } = useContrast();
  // The hint describes the option that is on, so "Padrão" never reads as if it
  // were the line about "Alto".
  const description =
    preference === "system"
      ? t("settings.appearance.contrastFollowing", {
          contrast: t(
            resolved === "more"
              ? "settings.appearance.resolved.more"
              : "settings.appearance.resolved.default",
          ),
        })
      : preference === "more"
        ? t("settings.appearance.contrastHint")
        : t("settings.appearance.contrastDefaultHint");
  return (
    <SettingsRow
      id="contrast"
      label={t("settings.appearance.contrast")}
      description={description}
      control={
        <RadioGroup
          label={t("settings.appearance.contrast")}
          fit="content"
          value={preference}
          onValueChange={setPreference}
          className={PHONE_TARGETS}
          options={CONTRAST_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * Preset ladders for the two numeric axes. The store is numeric (a synced
 * value from an older client may sit between rungs), so a rung is "selected"
 * when it is the nearest one.
 */
const FONT_SIZE_PRESETS: { value: number; label: MessageKey }[] = [
  { value: 13, label: "settings.appearance.textSize.small" },
  { value: 15, label: "settings.appearance.textSize.default" },
  { value: 17, label: "settings.appearance.textSize.large" },
  { value: 20, label: "settings.appearance.textSize.larger" },
];

const GROUP_SPACING_PRESETS: { value: number; label: MessageKey }[] = [
  { value: 0, label: "settings.appearance.spacing.tight" },
  { value: 8, label: "settings.appearance.spacing.default" },
  { value: 16, label: "settings.appearance.spacing.roomy" },
];

const DENSITY_OPTIONS: { value: ChatDensity; label: MessageKey }[] = [
  { value: "cozy", label: "settings.appearance.density.cozy" },
  { value: "compact", label: "settings.appearance.density.compact" },
];

function nearest(presets: { value: number }[], value: number): number {
  let best = presets[0].value;
  for (const preset of presets) {
    if (Math.abs(preset.value - value) < Math.abs(best - value)) {
      best = preset.value;
    }
  }
  return best;
}

/** A chat display row: its label, and a small segmented control. */
function ChatOptionRow<T extends string | number>({
  id,
  label,
  options,
  value,
  onChange,
  between = false,
}: {
  id: string;
  label: string;
  options: { value: T; label: MessageKey }[];
  value: T;
  onChange: (next: T) => void;
  /** The stored value is not exactly `value` (it sits between presets). */
  between?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SettingsRow
      id={id}
      label={label}
      control={
        <RadioGroup
          label={label}
          size="sm"
          // Cells as wide as their labels: Spanish "Predeterminado" and
          // "Más grande" are longer than an equal share of the track.
          fit="content"
          value={value}
          onValueChange={onChange}
          reselect={between}
          className={PHONE_TARGETS}
          options={options.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
        />
      }
    />
  );
}

function ChatGroup({
  showLinkEmbeds,
  onShowLinkEmbeds,
}: {
  showLinkEmbeds: boolean;
  onShowLinkEmbeds: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const { display, setDisplay } = useChatDisplay();
  const isDefault =
    display.density === DEFAULT_CHAT_DISPLAY.density &&
    display.fontSize === DEFAULT_CHAT_DISPLAY.fontSize &&
    display.groupSpacing === DEFAULT_CHAT_DISPLAY.groupSpacing;

  return (
    <SettingsGroup
      title={t("settings.appearance.chat")}
      surface="plain"
      action={
        // Always there so it can be found; dim and inert while there is
        // nothing to restore. It names what it restores: the link-preview
        // switch below is a different kind of choice and is left alone.
        <Button
          variant="ghost"
          size="sm"
          disabled={isDefault}
          className="max-sm:h-11"
          onClick={() => {
            setDisplay(DEFAULT_CHAT_DISPLAY, { immediate: true });
            // The button goes inert at the default, so focus would drop to
            // the page. The first control it reset takes it.
            requestAnimationFrame(() => {
              document
                .querySelector<HTMLElement>(
                  '[data-settings-row="density"] [role="radio"][tabindex="0"]',
                )
                ?.focus();
            });
          }}
        >
          {t("settings.appearance.chatReset")}
        </Button>
      }
    >
      <StickyPreview
        controls={
          <>
            <ChatOptionRow
              id="density"
              label={t("settings.appearance.density")}
              options={DENSITY_OPTIONS}
              value={display.density}
              onChange={(density) => setDisplay({ density }, { immediate: true })}
            />
            <ChatOptionRow
              id="text-size"
              label={t("settings.appearance.textSize")}
              options={FONT_SIZE_PRESETS}
              value={nearest(FONT_SIZE_PRESETS, display.fontSize)}
              between={nearest(FONT_SIZE_PRESETS, display.fontSize) !== display.fontSize}
              onChange={(fontSize) => setDisplay({ fontSize }, { immediate: true })}
            />
            <ChatOptionRow
              id="group-spacing"
              label={t("settings.appearance.spacing")}
              options={GROUP_SPACING_PRESETS}
              value={nearest(GROUP_SPACING_PRESETS, display.groupSpacing)}
              between={
                nearest(GROUP_SPACING_PRESETS, display.groupSpacing) !== display.groupSpacing
              }
              onChange={(groupSpacing) =>
                setDisplay({ groupSpacing }, { immediate: true })
              }
            />
            <SettingsSwitchRow
              id="link-previews"
              label={t("settings.appearance.linkPreviews")}
              description={t("settings.appearance.linkPreviewsHint")}
              checked={showLinkEmbeds}
              onCheckedChange={onShowLinkEmbeds}
            />
          </>
        }
      >
        <ChatDisplayPreview compact={display.density === "compact"} />
      </StickyPreview>
    </SettingsGroup>
  );
}

/**
 * `SettingsPreview`'s box, with one difference: on a phone the drawing sticks
 * to the top of the pane while the controls under it scroll past, so the person
 * sees what each tap does. The kit's box clips (`overflow-hidden`), and a
 * clipping ancestor stops `position: sticky` from reaching the pane, so the
 * clip is moved onto the two halves instead.
 */
function StickyPreview({
  children,
  controls,
}: {
  children: ReactNode;
  controls: ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border">
      <div
        aria-hidden
        className="overflow-hidden rounded-t-[var(--radius-card)] bg-surface-0 max-sm:sticky max-sm:top-0 max-sm:z-10 max-sm:border-b max-sm:border-border"
      >
        {children}
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-b-[var(--radius-card)] border-t border-border bg-surface-card max-sm:border-t-0">
        {controls}
      </div>
    </div>
  );
}

/**
 * Three messages drawn with the message list's own recipe: the same CSS
 * variables for size, line height and group gap, the same avatar column, the
 * same timestamp gutter. It reads the variables off the root, so it follows
 * the controls live. Keep the class recipe in step with `MessageRow` in
 * `message-list.tsx`.
 */
function ChatDisplayPreview({ compact }: { compact: boolean }) {
  const { t } = useTranslation();
  const rows = [
    {
      author: t("settings.appearance.preview.author1"),
      body: t("settings.appearance.preview.message1"),
      time: t("settings.appearance.preview.time1"),
      startsGroup: true,
      mine: false,
    },
    {
      author: t("settings.appearance.preview.author1"),
      body: t("settings.appearance.preview.message2"),
      time: t("settings.appearance.preview.time2"),
      startsGroup: false,
      mine: false,
    },
    {
      author: t("settings.appearance.preview.author2"),
      body: t("settings.appearance.preview.message3"),
      time: t("settings.appearance.preview.time3"),
      startsGroup: true,
      mine: true,
    },
  ];
  return (
    <div className="py-3">
      {rows.map((row, index) => (
        <div
          key={index}
          className={cn(
            "flex items-start gap-0 px-5",
            row.startsGroup ? "mt-[var(--chat-group-gap)] pt-1 pb-1" : "pt-px pb-px",
            index === 0 && "mt-0",
          )}
        >
          {row.startsGroup && !compact ? (
            <div className="flex w-14 shrink-0 items-start justify-end pr-2">
              <UserAvatar
                name={row.author}
                avatarUrl={null}
                rounded="lg"
                className="h-9 w-9"
                fallbackClassName="bg-surface-2 text-sm"
              />
            </div>
          ) : (
            <span
              className={cn(
                "w-14 shrink-0 pr-2 text-right text-[12px] leading-[var(--chat-line-height)] whitespace-nowrap tabular-nums text-text-tertiary",
                compact ? "opacity-70" : "opacity-40",
              )}
            >
              {row.time}
            </span>
          )}
          <div className="min-w-0 flex-1">
            {row.startsGroup && (
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span
                  className={cn(
                    "text-[length:var(--chat-font-size)] font-bold leading-[var(--chat-line-height)]",
                    row.mine ? "text-accent" : "text-text",
                  )}
                >
                  {row.author}
                </span>
                {!compact && (
                  <span className="text-[12px] leading-[var(--chat-line-height)] text-text-tertiary">
                    {row.time}
                  </span>
                )}
              </div>
            )}
            <div className="text-[length:var(--chat-font-size)] leading-[var(--chat-line-height)] text-text">
              {row.body}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Idioma
// ---------------------------------------------------------------------------

/** Portuguese first: it is the product's language and most readers'. */
const LOCALE_ORDER: readonly Locale[] = [
  "pt-BR",
  ...SUPPORTED_LOCALES.filter((option) => option !== "pt-BR"),
];

const LOCALE_LABELS: Record<Locale, MessageKey> = {
  en: "settings.appearance.language.en",
  "pt-BR": "settings.appearance.language.ptBR",
  es: "settings.appearance.language.es",
};

/**
 * The language switch `lib/locale.ts` has always been written for: it exposes
 * `setLocalePreference` with a comment saying "once there is UI to set one",
 * and this is that UI.
 *
 * Switching reloads rather than swapping strings under the mounted tree.
 * `I18nProvider` reads the locale once at boot on purpose, and Clerk's own
 * catalogue is wired at the provider in `main.tsx`; changing it in place would
 * leave the sign-in and account modals speaking the old language, which is a
 * worse answer than a reload. It is also what the legal pages already do.
 *
 * `?lang=` is dropped from the URL on the way out: it outranks the stored
 * preference, so a visitor who arrived on a `?lang=pt` link would otherwise
 * click "English" and get Portuguese back.
 */
function LanguageGroup() {
  const { t, locale } = useTranslation();
  // Switching reloads the page, which would throw away staged profile edits
  // without a word. Locked until they are saved or discarded.
  const { profileDirty } = useSettingsShell();

  async function choose(next: Locale) {
    if (next === locale || profileDirty) {
      return;
    }
    setLocalePreference(next);
    // Server-side too, not just this browser's localStorage: it is the one
    // signal `server/src/services/push-copy.ts` has for which language a
    // closed phone's push should read in, and there is no i18next there to
    // ask instead. Immediate, not debounced: the reload below would otherwise
    // race the request and drop it.
    //
    // The server's enum is still `pt-BR | en` (push copy has no Spanish yet),
    // so a Spanish reader is stored as English: an English push beats a
    // Portuguese one, which is what an absent value defaults to.
    queuePreferenceSync(
      { locale: next === "es" ? "en" : next },
      { immediate: true },
    );
    try {
      await getDesktop()?.setLocale?.(next);
    } catch {
      // The desktop menus keep their old language until the next launch;
      // the page itself must still switch, so the reload below goes ahead.
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("lang");
      window.location.replace(url.toString());
    } catch {
      window.location.reload();
    }
  }

  return (
    <SettingsGroup title={t("settings.appearance.language")}>
      <SettingsRow
        id="language"
        label={t("settings.appearance.appLanguage")}
        description={
          profileDirty
            ? t("settings.unsaved.languageLocked")
            : t("settings.appearance.languageHint")
        }
        // Inline beside the label where it fits, under it where it does not.
        // Each cell is as wide as its name, so "Português (Brasil)" is never
        // cut, which is the one label a reader of another language needs whole.
        wideControl
        control={
          <RadioGroup
            label={t("settings.appearance.appLanguage")}
            // Arrows only move focus: selecting reloads the app, so a keyboard
            // or screen-reader user walking the options must not trigger it.
            activation="manual"
            fit="content"
            className={PHONE_TARGETS}
            value={locale}
            disabled={profileDirty}
            onValueChange={(next) => void choose(next)}
            options={LOCALE_ORDER.map((option) => ({
              value: option,
              label: t(LOCALE_LABELS[option]),
            }))}
          />
        }
      />
    </SettingsGroup>
  );
}

// ---------------------------------------------------------------------------
// App para computador
// ---------------------------------------------------------------------------

/**
 * Launch pqp when the computer starts.
 *
 * Desktop-only, and only where the shell can keep the promise: `getDesktop()
 * ?.platform` is a fact about the installed binary, and `loginItemSupported`
 * in the main process already refuses Linux, so this mirrors that refusal
 * here rather than showing a toggle that reports success and does nothing.
 * Absent entirely on the web and in a shell built before the bridge existed,
 * and so is its group.
 */
function DesktopGroup() {
  const { t } = useTranslation();
  const desktop = getDesktop();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const read = desktop?.getStartAtLogin;
    if (typeof read !== "function") {
      return;
    }
    let cancelled = false;
    void read()
      .then((value) => {
        if (!cancelled) {
          setEnabled(value === true);
        }
      })
      // IPC can reject (main process gone, a handler missing on an older
      // shell, mid-shutdown). `enabled` stays null, which hides the group:
      // a switch with an unknown state would be a guess.
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn("[pqp] read start-at-login failed:", err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  if (!desktop || desktop.platform === "linux" || enabled === null) {
    return null;
  }

  function toggle(next: boolean) {
    const write = desktop?.setStartAtLogin;
    // A second tap while the first write runs is dropped here, not by
    // disabling the switch, which would drop keyboard focus on the page.
    if (typeof write !== "function" || pending) {
      return;
    }
    setPending(true);
    setFailed(false);
    void write(next)
      .then((applied) => setEnabled(applied === true))
      // `enabled` is left untouched on failure, so the switch goes back to
      // what it showed before the tap, and the row says the write failed.
      .catch((err: unknown) => {
        console.warn("[pqp] set start-at-login failed:", err);
        setFailed(true);
      })
      .finally(() => setPending(false));
  }

  return (
    <SettingsGroup title={t("settings.appearance.group.desktop.title")}>
      <SettingsSwitchRow
        id="start-at-login"
        label={t("settings.appearance.startAtLogin")}
        description={t("settings.appearance.startAtLoginHint")}
        checked={enabled}
        onCheckedChange={toggle}
        busy={pending}
        status={
          failed ? (
            <SettingsInlineStatus
              state={{
                kind: "error",
                message: t("settings.appearance.startAtLoginFailed"),
              }}
            />
          ) : undefined
        }
      />
    </SettingsGroup>
  );
}
