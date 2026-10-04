import { useEffect, useRef, useState, type CSSProperties } from "react";
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
import { queuePreferenceSync } from "@/lib/preferences";
import { cn } from "@/lib/utils";
import {
  SETTINGS_FOCUS,
  SettingsChoiceGrid,
  SettingsGroup,
  SettingsInlineStatus,
  SettingsPreview,
  SettingsRow,
  SettingsSwitchRow,
  useSettingsShell,
} from "@/components/settings/kit";

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
  return (
    <div className="space-y-6">
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
 * Theme is not part of `LocalSettings`: it applies on click and persists under
 * its own key so the boot script can read it without parsing the audio blob.
 * Night is a dark-only look, so it shows dark and disables the other two; the
 * description says why.
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
      : t(
          preference === "light"
            ? "settings.appearance.themeAlwaysLight"
            : "settings.appearance.themeAlwaysDark",
        );

  return (
    <SettingsRow
      id="brightness"
      label={t("settings.appearance.theme")}
      description={description}
      control={
        <RadioGroup
          label={t("settings.appearance.theme")}
          value={shown}
          onValueChange={(next) => {
            if (!nightLocked) {
              setPreference(next);
            }
          }}
          options={THEME_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
            disabled: nightLocked && option.value !== "dark",
          }))}
        />
      }
    />
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
  return (
    <SettingsRow
      id="look"
      label={t("settings.appearance.preset")}
      stacked
      control={
        <SettingsChoiceGrid
          label={t("settings.appearance.preset")}
          value={appearance}
          onValueChange={setAppearance}
          columns={4}
          options={LOOK_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
            badge: option.badge ? t(option.badge) : undefined,
            preview: <LookMiniature look={option.value} />,
          }))}
        />
      }
    />
  );
}

/**
 * Miniature app chrome in the look's own static swatches. The drawing is the
 * `appearance-preview*` recipe in `index.css`; only the four colours vary.
 */
function LookMiniature({ look }: { look: AppearancePreference }) {
  return (
    <span
      className="appearance-preview"
      style={
        {
          "--preview-rail": `var(--swatch-${look}-rail)`,
          "--preview-list": `var(--swatch-${look}-list)`,
          "--preview-surface": `var(--swatch-${look}-surface)`,
          "--preview-accent": `var(--swatch-${look}-accent)`,
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
  );
}

/**
 * The accent. A hue slider for any colour, then the eight suggested hues as one
 * radio group, then "Usar a do visual", which only shows while a custom accent
 * is set (the same rule as the chat reset). The reset sits outside the
 * radiogroup's key handler, so an arrow pressed on it never picks a swatch.
 */
function AccentRow() {
  const { t } = useTranslation();
  const { appearance } = useAppearance();
  const { preference, setPreference } = useAccentHue();
  const sliderHue = effectiveAccentHue(preference, appearance);
  const isCustom = preference !== "default";
  const sliderRef = useRef<HTMLDivElement>(null);
  const checkedSwatch = typeof preference === "number" ? preference : -1;
  const { onKeyDown, tabIndexFor } = useRovingRadio<number>(
    ACCENT_SWATCHES,
    checkedSwatch,
    (hue) => setPreference(hue as AccentHuePreference, { immediate: true }),
  );

  function reset() {
    setPreference("default");
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
          <div ref={sliderRef}>
            <Slider
              variant="hue"
              min={0}
              max={360}
              value={sliderHue}
              aria-label={t("settings.appearance.accent")}
              aria-valuetext={t("settings.appearance.accentHue", { hue: sliderHue })}
              onValueChange={(hue) => setPreference(hue as AccentHuePreference)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="radiogroup"
              aria-label={t("settings.appearance.accent")}
              onKeyDown={onKeyDown}
              className="flex flex-wrap items-center gap-2"
            >
              {ACCENT_SWATCHES.map((hue) => (
                <button
                  key={hue}
                  type="button"
                  role="radio"
                  aria-label={t("settings.appearance.accentHue", { hue })}
                  aria-checked={preference === hue}
                  tabIndex={tabIndexFor(hue)}
                  onClick={() => setPreference(hue, { immediate: true })}
                  className={cn(
                    "accent-hue-dot h-7 w-7 rounded-full border-2 transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                    SETTINGS_FOCUS,
                    preference === hue
                      ? "border-text"
                      : "border-transparent hover:border-border-strong",
                  )}
                  style={{ "--swatch-hue": String(hue) } as CSSProperties}
                />
              ))}
            </div>
            {isCustom ? (
              <Button variant="ghost" size="sm" className="ml-auto" onClick={reset}>
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
  return (
    <SettingsRow
      id="contrast"
      label={t("settings.appearance.contrast")}
      description={
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
      control={
        <RadioGroup
          label={t("settings.appearance.contrast")}
          value={preference}
          onValueChange={setPreference}
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
          value={value}
          onValueChange={onChange}
          reselect={between}
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
        isDefault ? undefined : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDisplay(DEFAULT_CHAT_DISPLAY, { immediate: true });
              // The button hides itself at the default, so focus would drop to
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
        )
      }
    >
      <SettingsPreview
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
              checked={showLinkEmbeds}
              onCheckedChange={onShowLinkEmbeds}
            />
          </>
        }
      >
        <ChatDisplayPreview compact={display.density === "compact"} />
      </SettingsPreview>
    </SettingsGroup>
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
    if (typeof write !== "function") {
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
        disabled={pending}
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
