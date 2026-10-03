import { useEffect, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Switch } from "@/components/ui/switch";
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
import { queuePreferenceSync } from "@/lib/preferences";
import { cn } from "@/lib/utils";
import { SettingBlock, segmentClass } from "@/components/settings/ui";
import { useSettingsShell } from "@/components/settings/kit";

const APPEARANCE_OPTIONS: {
  value: AppearancePreference;
  label: MessageKey;
}[] = [
  { value: "signal", label: "settings.appearance.preset.signal" },
  { value: "harmony", label: "settings.appearance.preset.harmony" },
  { value: "hearth", label: "settings.appearance.preset.hearth" },
  { value: "night", label: "settings.appearance.preset.night" },
];

function AppearancePicker() {
  const { t } = useTranslation();
  const { appearance, setAppearance } = useAppearance();

  function choose(next: AppearancePreference) {
    setAppearance(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const current = APPEARANCE_OPTIONS.findIndex(
      (option) => option.value === appearance,
    );
    const nextIndex =
      (current + step + APPEARANCE_OPTIONS.length) % APPEARANCE_OPTIONS.length;
    choose(APPEARANCE_OPTIONS[nextIndex].value);
    const radios =
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios[nextIndex]?.focus();
  }

  return (
    <SettingBlock label={t("settings.appearance.preset")}>
      <div
        role="radiogroup"
        aria-label={t("settings.appearance.preset")}
        className="grid grid-cols-2 gap-2"
        onKeyDown={handleKeyDown}
      >
        {APPEARANCE_OPTIONS.map((option) => {
          const selected = option.value === appearance;
          const darkOnly = option.value === "night";
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => choose(option.value)}
              className={cn(
                "flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                selected
                  ? "border-accent bg-surface-2 text-text"
                  : "border-border text-text-muted hover:border-border-strong hover:text-text",
              )}
            >
              <span
                aria-hidden
                className="appearance-preview"
                style={
                  {
                    "--preview-rail": `var(--swatch-${option.value}-rail)`,
                    "--preview-list": `var(--swatch-${option.value}-list)`,
                    "--preview-surface": `var(--swatch-${option.value}-surface)`,
                    "--preview-accent": `var(--swatch-${option.value}-accent)`,
                  } as CSSProperties
                }
              >
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
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{t(option.label)}</span>
                {option.value === "signal" ? (
                  <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                    {t("settings.appearance.preset.signalDefault")}
                  </span>
                ) : darkOnly ? (
                  <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                    {t("settings.appearance.preset.nightOnly")}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </SettingBlock>
  );
}

function AccentHuePicker() {
  const { t } = useTranslation();
  const { appearance } = useAppearance();
  const { preference, setPreference } = useAccentHue();
  const sliderHue = effectiveAccentHue(preference, appearance);
  const isCustom = preference !== "default";

  return (
    <SettingBlock
      label={t("settings.appearance.accent")}
      hint={
        isCustom
          ? t("settings.appearance.accentCustomHint")
          : t("settings.appearance.accentDefaultHint")
      }
    >
      <div className="flex flex-col gap-2.5">
        <input
          type="range"
          min={0}
          max={360}
          value={sliderHue}
          aria-label={t("settings.appearance.accent")}
          onChange={(event) =>
            setPreference(Number(event.target.value) as AccentHuePreference)
          }
          className="accent-hue-slider"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          {ACCENT_SWATCHES.map((hue) => (
            <button
              key={hue}
              type="button"
              aria-label={t("settings.appearance.accentHue", { hue })}
              aria-pressed={preference === hue}
              onClick={() => setPreference(hue, { immediate: true })}
              className={cn(
                "accent-hue-dot h-7 w-7 rounded-full border-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                preference === hue
                  ? "border-text"
                  : "border-transparent hover:border-border-strong",
              )}
              style={{ "--swatch-hue": String(hue) } as CSSProperties}
            />
          ))}
          <button
            type="button"
            onClick={() => setPreference("default")}
            disabled={!isCustom}
            className="ml-1 text-xs text-text-muted underline-offset-2 hover:text-text hover:underline disabled:cursor-default disabled:no-underline disabled:opacity-40"
          >
            {t("settings.appearance.accentReset")}
          </button>
        </div>
      </div>
    </SettingBlock>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: MessageKey }[] = [
  { value: "light", label: "settings.appearance.theme.light" },
  { value: "dark", label: "settings.appearance.theme.dark" },
  { value: "system", label: "settings.appearance.theme.system" },
];

/**
 * Theme is not part of `LocalSettings`: it applies on click rather than on
 * Save, and it persists under its own key so the boot script can read it
 * without parsing the audio blob.
 */
function ThemePicker() {
  const { t } = useTranslation();
  const { appearance } = useAppearance();
  const { preference, resolved, setPreference } = useTheme();
  const nightLocked = appearance === "night";
  const shown = nightLocked ? "dark" : preference;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const enabled = THEME_OPTIONS.filter(
      (option) => !nightLocked || option.value === "dark",
    );
    const current = enabled.findIndex((option) => option.value === shown);
    const nextIndex = (current + step + enabled.length) % enabled.length;
    setPreference(enabled[nextIndex].value);
    const radios =
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    const visualIndex = THEME_OPTIONS.findIndex(
      (option) => option.value === enabled[nextIndex].value,
    );
    radios[visualIndex]?.focus();
  }

  return (
    <SettingBlock
      label={t("settings.appearance.theme")}
      hint={
        nightLocked
          ? t("settings.appearance.themeNightLocked")
          : preference === "system"
            ? t("settings.appearance.themeFollowing", {
                theme: t(
                  resolved === "light"
                    ? "settings.appearance.resolved.light"
                    : "settings.appearance.resolved.dark",
                ),
              })
            : t(
                preference === "light"
                  ? "settings.appearance.themeAlwaysLight"
                  : "settings.appearance.themeAlwaysDark",
              )
      }
    >
      <div
        role="radiogroup"
        aria-label={t("settings.appearance.theme")}
        className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5"
        onKeyDown={handleKeyDown}
      >
        {THEME_OPTIONS.map((option) => {
          const selected = option.value === shown;
          const disabled = nightLocked && option.value !== "dark";
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={disabled}
              disabled={disabled}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                if (!disabled) {
                  setPreference(option.value);
                }
              }}
              className={segmentClass(selected, disabled)}
            >
              {t(option.label)}
            </button>
          );
        })}
      </div>
    </SettingBlock>
  );
}

const CONTRAST_OPTIONS: { value: ContrastPreference; label: MessageKey }[] = [
  { value: "default", label: "settings.appearance.contrast.default" },
  { value: "more", label: "settings.appearance.contrast.more" },
  { value: "system", label: "settings.appearance.contrast.system" },
];

function ContrastPicker() {
  const { t } = useTranslation();
  const { preference, resolved, setPreference } = useContrast();

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const current = CONTRAST_OPTIONS.findIndex(
      (option) => option.value === preference,
    );
    const nextIndex =
      (current + step + CONTRAST_OPTIONS.length) % CONTRAST_OPTIONS.length;
    setPreference(CONTRAST_OPTIONS[nextIndex].value);
    const radios =
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios[nextIndex]?.focus();
  }

  return (
    <SettingBlock
      label={t("settings.appearance.contrast")}
      hint={
        preference === "system"
          ? t("settings.appearance.contrastFollowing", {
              contrast: t(
                resolved === "more"
                  ? "settings.appearance.resolved.more"
                  : "settings.appearance.resolved.default",
              ),
            })
          : t("settings.appearance.contrastHint")
      }
    >
      <div
        role="radiogroup"
        aria-label={t("settings.appearance.contrast")}
        className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5"
        onKeyDown={handleKeyDown}
      >
        {CONTRAST_OPTIONS.map((option) => {
          const selected = option.value === preference;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => setPreference(option.value)}
              className={segmentClass(selected)}
            >
              {t(option.label)}
            </button>
          );
        })}
      </div>
    </SettingBlock>
  );
}

const LOCALE_LABELS: Record<Locale, MessageKey> = {
  en: "settings.appearance.language.en",
  "pt-BR": "settings.appearance.language.ptBR",
  es: "settings.appearance.language.es",
};

/**
 * The language switch `lib/locale.ts` has always been written for — it exposes
 * `setLocalePreference` with a comment saying "once there is UI to set one",
 * and this is that UI.
 *
 * Switching reloads rather than swapping strings under the mounted tree.
 * `I18nProvider` reads the locale once at boot on purpose, and Clerk's own
 * catalogue is wired at the provider in `main.tsx` — changing it in place would
 * leave the sign-in and account modals speaking the old language, which is a
 * worse answer than a reload. It is also what the legal pages already do.
 *
 * `?lang=` is dropped from the URL on the way out: it outranks the stored
 * preference, so a visitor who arrived on a `?lang=pt` link would otherwise
 * click "English" and get Portuguese back.
 */
function LanguagePicker() {
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
    // ask instead. Immediate, not debounced — the reload two lines down
    // would otherwise race the request and drop it.
    //
    // The server's enum is still `pt-BR | en` (push copy has no Spanish yet),
    // so a Spanish reader is stored as English: an English push beats a
    // Portuguese one, which is what an absent value defaults to.
    queuePreferenceSync(
      { locale: next === "es" ? "en" : next },
      { immediate: true },
    );
    await getDesktop()?.setLocale?.(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("lang");
      window.location.replace(url.toString());
    } catch {
      window.location.reload();
    }
  }

  return (
    <SettingBlock
      label={t("settings.appearance.language")}
      hint={
        profileDirty
          ? t("settings.unsaved.languageLocked")
          : t("settings.appearance.languageHint")
      }
    >
      <div
        role="radiogroup"
        aria-label={t("settings.appearance.language")}
        className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5"
      >
        {SUPPORTED_LOCALES.map((option) => {
          const selected = option === locale;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={profileDirty}
              onClick={() => void choose(option)}
              className={segmentClass(selected, profileDirty)}
            >
              {t(LOCALE_LABELS[option])}
            </button>
          );
        })}
      </div>
    </SettingBlock>
  );
}

/**
 * Launch pqp when the desktop app's platform starts.
 *
 * Desktop-only, and only where the shell can keep the promise: `getDesktop()
 * ?.platform` is a fact about the installed binary, and `loginItemSupported`
 * in the main process already refuses Linux, so this mirrors that refusal
 * here rather than showing a toggle that reports success and does nothing.
 * Absent entirely on the web and in a shell built before the bridge existed.
 */
function DesktopStartupPicker() {
  const { t } = useTranslation();
  const desktop = getDesktop();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);

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
      // shell, mid-shutdown); left uncaught this was an unhandled promise
      // rejection with the control silently never appearing (Farol review,
      // PR 675). `enabled` stays null either way, which already hides the
      // toggle below -- the catch only stops the rejection from going
      // unhandled.
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
    if (typeof write !== "function") {
      return;
    }
    setPending(true);
    void write(next)
      .then((applied) => setEnabled(applied === true))
      // A rejected write left the toggle spinning until `finally` cleared
      // `pending`, but the rejection itself went unhandled with no
      // user-visible failure state (Farol review, PR 675). `enabled` is
      // left untouched on failure, so the Switch reverts to whatever it
      // showed before the tap.
      .catch((err: unknown) => {
        console.warn("[pqp] set start-at-login failed:", err);
      })
      .finally(() => setPending(false));
  }

  return (
    <div className="border-t border-border pt-6">
      <Switch
        checked={enabled}
        onCheckedChange={toggle}
        disabled={pending}
        label={t("settings.appearance.startAtLogin")}
        description={t("settings.appearance.startAtLoginHint")}
        className="px-0"
      />
    </div>
  );
}

export function AppearanceSection({
  showLinkEmbeds,
  onShowLinkEmbeds,
}: {
  showLinkEmbeds: boolean;
  onShowLinkEmbeds: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <p className="text-xs text-text-muted">
        {t("settings.appearance.syncHint")}
      </p>
      <ThemePicker />
      <AppearancePicker />
      <AccentHuePicker />
      <ContrastPicker />
      <div className="space-y-6 border-t border-border pt-6">
        <LanguagePicker />
        <ChatDisplayPicker
          showLinkEmbeds={showLinkEmbeds}
          onShowLinkEmbeds={onShowLinkEmbeds}
        />
      </div>
      <DesktopStartupPicker />
    </div>
  );
}

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

/**
 * One labelled row: the name on the left, a segmented control on the right,
 * stacked on a narrow dialog. Arrow keys move within the group.
 */
function ChatOptionRow<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: MessageKey }[];
  value: T;
  onChange: (next: T) => void;
}) {
  const { t } = useTranslation();

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const current = options.findIndex((option) => option.value === value);
    const nextIndex = (current + step + options.length) % options.length;
    onChange(options[nextIndex].value);
    const radios =
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios[nextIndex]?.focus();
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-sm text-text">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5 sm:w-auto sm:min-w-[16rem]"
        onKeyDown={handleKeyDown}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={String(option.value)}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(option.value)}
              className={cn(segmentClass(selected), "h-8 px-2.5 text-xs")}
            >
              {t(option.label)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChatDisplayPicker({
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
    <SettingBlock
      label={t("settings.appearance.chat")}
      hint={t("settings.appearance.chatHint")}
    >
      <div className="overflow-hidden rounded-lg border border-border">
        <ChatDisplayPreview compact={display.density === "compact"} />
        <div className="space-y-4 border-t border-border bg-surface-1 p-4">
          <ChatOptionRow
            label={t("settings.appearance.density")}
            options={DENSITY_OPTIONS}
            value={display.density}
            onChange={(density) => setDisplay({ density }, { immediate: true })}
          />
          <ChatOptionRow
            label={t("settings.appearance.textSize")}
            options={FONT_SIZE_PRESETS}
            value={nearest(FONT_SIZE_PRESETS, display.fontSize)}
            onChange={(fontSize) => setDisplay({ fontSize }, { immediate: true })}
          />
          <ChatOptionRow
            label={t("settings.appearance.spacing")}
            options={GROUP_SPACING_PRESETS}
            value={nearest(GROUP_SPACING_PRESETS, display.groupSpacing)}
            onChange={(groupSpacing) =>
              setDisplay({ groupSpacing }, { immediate: true })
            }
          />
          <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex cursor-pointer items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={showLinkEmbeds}
                onChange={(e) => onShowLinkEmbeds(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              <span>{t("settings.appearance.linkPreviews")}</span>
            </label>
            {!isDefault && (
              <button
                type="button"
                onClick={() =>
                  setDisplay(DEFAULT_CHAT_DISPLAY, { immediate: true })
                }
                className="-my-1 py-1 text-left text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
              >
                {t("settings.appearance.chatReset")}
              </button>
            )}
          </div>
        </div>
      </div>
    </SettingBlock>
  );
}

/**
 * Three messages drawn with the message list's own recipe: the same CSS
 * variables for size, line height and group gap, the same avatar column, the
 * same timestamp gutter. It reads the variables off the root, so it follows
 * the sliders live without a save. Keep the class recipe in step with
 * `MessageRow` in `message-list.tsx`.
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
    <div
      aria-hidden
      className="bg-channel py-3"
    >
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
                fallbackClassName="bg-ink-3 text-sm"
              />
            </div>
          ) : (
            <span
              className={cn(
                "w-14 shrink-0 pr-2 text-right text-[12px] leading-[var(--chat-line-height)] whitespace-nowrap tabular-nums text-paper-muted",
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
                    row.mine ? "text-signal" : "text-paper",
                  )}
                >
                  {row.author}
                </span>
                {!compact && (
                  <span className="text-[12px] leading-[var(--chat-line-height)] text-paper-muted">
                    {row.time}
                  </span>
                )}
              </div>
            )}
            <div className="text-[length:var(--chat-font-size)] leading-[var(--chat-line-height)] text-paper/90">
              {row.body}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
