import { useEffect, useState, type ReactNode } from "react";
import {
  Bell,
  CaretDown,
  ChatCircle,
  GearSix,
  Hash,
  MagnifyingGlass,
  Microphone,
  PaperPlaneRight,
  Plus,
  SpeakerHigh,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import { Check as CheckIcon, Hash as LineHash } from "lucide-react";
import { Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { CheckRow } from "@/components/ui/check-row";
import { Icon } from "@/components/ui/icon";
import { IconButton, type IconButtonSize } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { useAppearance } from "@/hooks/use-appearance";
import { useContrast } from "@/hooks/use-contrast";
import { useTheme } from "@/hooks/use-theme";
import { APPEARANCES, setRetroLook, type AppearancePreference } from "@/lib/appearance";
import {
  COLOR_TOKEN_GROUPS,
  CONTROL_TOKENS,
  contrastRatio,
  DURATION_TOKENS,
  EASE_TOKENS,
  ELEVATION_LEVELS,
  ICON_SIZE_TOKENS,
  ICON_STROKE_TOKEN,
  RADIUS_TOKENS,
  readToken,
  roundRatio,
  SHADOW_TOKENS,
  SOFT_PAIRS,
  SPACE_TOKENS,
  TYPE_ROLES,
} from "@/lib/design-tokens";
import { isDesktopApp } from "@/lib/desktop";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { setRedesignChoice, useRedesign } from "@/lib/redesign";
import { SettingsKitSheet } from "@/pages/ui-settings-kit-sheet";

/**
 * The token sheet: every role token and every ui/ primitive on one page, in
 * whatever theme the viewer has on.
 *
 * WHY IT IS ITS OWN ROUTE AND NOT A PANEL IN SETTINGS. It is a reference for
 * whoever is building the next component, not a feature. It also has to be
 * reachable without a server, a socket or an account, which a panel inside the
 * app shell is not.
 *
 * WHY IT IS GATED. It ships in the production bundle as a lazy chunk, and a
 * page that lists the internals of the design system is not a page a visitor
 * has any use for. `VITE_DEV_AUTH_BYPASS` is the only client-side signal the
 * app has for "this build is a workbench"; there is no client-side instance
 * moderator flag to check instead. Off the bypass, this behaves exactly like
 * an unknown path.
 *
 * EVERY VALUE ON THIS PAGE IS READ FROM THE DOCUMENT. Nothing here writes a
 * colour, a radius or a duration of its own. That is what makes it a reference
 * rather than a second, drifting copy of the palette, and it is what keeps the
 * bench's colour-literal gate at zero.
 */

interface Swatch {
  token: string;
  value: string;
  onSurface0: number | null;
  onSurface1: number | null;
}

/** Score every colour role against the two backgrounds it usually sits on. */
function measure(): Swatch[] {
  const surface0 = readToken("--color-surface-0");
  const surface1 = readToken("--color-surface-1");
  return COLOR_TOKEN_GROUPS.flatMap((group) =>
    group.tokens.map((token) => {
      const value = readToken(token);
      return {
        token,
        value,
        onSurface0: contrastRatio(value, surface0),
        onSurface1: contrastRatio(value, surface1),
      };
    }),
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-6">
      <h2
        className="font-display font-semibold"
        style={{
          fontSize: "var(--type-title-size)",
          lineHeight: "var(--type-title-leading)",
        }}
      >
        {title}
      </h2>
      {note ? (
        <p
          className="mt-1 text-text-tertiary"
          style={{ fontSize: "var(--type-label-size)" }}
        >
          {note}
        </p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function TokenName({ name }: { name: string }) {
  return (
    <code className="rounded-[var(--radius-tick)] bg-code-bg px-1 py-0.5 text-code-text">
      {name}
    </code>
  );
}

function ThemeControls() {
  const { t } = useTranslation();
  const theme = useTheme();
  const appearance = useAppearance();
  const contrast = useContrast();
  const redesign = useRedesign();

  const presetKey = (preset: AppearancePreference): MessageKey =>
    `settings.appearance.preset.${preset}` as MessageKey;

  return (
    <div className="flex flex-col gap-4">
      {/* The redesign toggle, so the sheet can be read both ways. Same switch
          as Settings > Beta: it writes the person's choice on this device. */}
      <div className="max-w-md rounded-[var(--radius-card)] border border-border bg-surface-1 p-2">
        <Switch
          checked={redesign}
          onCheckedChange={setRedesignChoice}
          label={t("settings.beta.redesign.label")}
          description={t("settings.beta.redesign.description")}
        />
      </div>
      <div>
        <p className="mb-2 text-text-tertiary" style={{ fontSize: "var(--type-label-size)" }}>
          {t("settings.appearance.theme")}
        </p>
        <div className="flex flex-wrap gap-2">
          {(["light", "dark", "system"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={theme.preference === option ? "default" : "secondary"}
              onClick={() => theme.setPreference(option)}
            >
              {t(`settings.appearance.theme.${option}` as MessageKey)}
            </Button>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-2 text-text-tertiary" style={{ fontSize: "var(--type-label-size)" }}>
          {t("settings.appearance.preset")}
        </p>
        <div className="flex flex-wrap gap-2">
          {APPEARANCES.map((preset) => (
            <Button
              key={preset}
              size="sm"
              variant={appearance.look === preset ? "default" : "secondary"}
              onClick={() => appearance.setAppearance(preset)}
            >
              {t(presetKey(preset))}
            </Button>
          ))}
          {/* The hidden look, so the sheet can score it like the others. */}
          <Button
            size="sm"
            variant={appearance.look === "retro" ? "default" : "secondary"}
            onClick={() => setRetroLook(true)}
          >
            {t("settings.appearance.preset.retro")}
          </Button>
        </div>
      </div>
      <div>
        <p className="mb-2 text-text-tertiary" style={{ fontSize: "var(--type-label-size)" }}>
          {t("settings.appearance.contrast")}
        </p>
        <div className="flex flex-wrap gap-2">
          {(["default", "more", "system"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={contrast.preference === option ? "default" : "secondary"}
              onClick={() => contrast.setPreference(option)}
            >
              {t(`settings.appearance.contrast.${option}` as MessageKey)}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ColourSheet() {
  const { t } = useTranslation();
  const theme = useTheme();
  const appearance = useAppearance();
  const contrast = useContrast();
  const redesign = useRedesign();
  const [swatches, setSwatches] = useState<Swatch[]>([]);

  // The attributes are already on the document when these values change, but
  // the ratios have to be read after the browser has recomputed them, so this
  // re-runs on every axis of the theme rather than only on mount.
  useEffect(() => {
    setSwatches(measure());
  }, [theme.resolved, appearance.appearance, contrast.resolved, redesign]);

  const byToken = new Map(swatches.map((swatch) => [swatch.token, swatch]));

  return (
    <div className="flex flex-col gap-6">
      {COLOR_TOKEN_GROUPS.map((group) => (
        <div key={group.id}>
          <p
            className="mb-2 uppercase tracking-[0.14em] text-text-tertiary"
            style={{ fontSize: "var(--type-caption-size)" }}
          >
            {t(`qaUi.group.${group.id}` as MessageKey)}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.tokens.map((token) => {
              const swatch = byToken.get(token);
              return (
                <div
                  key={token}
                  className="flex items-center gap-3 rounded-[var(--radius-card)] border border-border bg-surface-1 p-3"
                >
                  <span
                    aria-hidden
                    className="h-10 w-10 shrink-0 rounded-[var(--radius-control)] border border-border"
                    style={{ backgroundColor: `var(${token})` }}
                  />
                  <span className="min-w-0">
                    <span
                      className="block truncate"
                      style={{ fontSize: "var(--type-label-size)" }}
                    >
                      <TokenName name={token} />
                    </span>
                    <span
                      className="mt-1 block text-text-tertiary"
                      style={{ fontSize: "var(--type-caption-size)" }}
                    >
                      {swatch?.onSurface0 == null || swatch.onSurface1 == null
                        ? t("qaUi.colour.unmeasured")
                        : t("qaUi.colour.ratios", {
                            zero: roundRatio(swatch.onSurface0),
                            one: roundRatio(swatch.onSurface1),
                          })}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div>
        <p
          className="mb-2 uppercase tracking-[0.14em] text-text-tertiary"
          style={{ fontSize: "var(--type-caption-size)" }}
        >
          {t("qaUi.group.soft")}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {SOFT_PAIRS.map((pair) => {
            const ratio = contrastRatio(readToken(pair.on), readToken(pair.fill));
            const hoverRatio =
              pair.hover === undefined
                ? null
                : contrastRatio(readToken(pair.on), readToken(pair.hover));
            return (
              <div
                key={pair.id}
                className="flex flex-col gap-2 rounded-[var(--radius-card)] p-3"
                style={{
                  backgroundColor: `var(${pair.fill})`,
                  color: `var(${pair.on})`,
                }}
              >
                <span style={{ fontSize: "var(--type-label-size)" }}>
                  {t("qaUi.soft.sample")}
                </span>
                <span style={{ fontSize: "var(--type-caption-size)" }}>
                  <TokenName name={pair.on} /> <TokenName name={pair.fill} />
                  {ratio === null ? null : ` · ${roundRatio(ratio)}`}
                </span>
                {pair.hover === undefined ? null : (
                  <span
                    className="rounded-[var(--radius-control)] px-2 py-1"
                    style={{
                      backgroundColor: `var(${pair.hover})`,
                      fontSize: "var(--type-caption-size)",
                    }}
                  >
                    <TokenName name={pair.hover} />
                    {hoverRatio === null ? null : ` · ${roundRatio(hoverRatio)}`}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TypeRamp() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      {TYPE_ROLES.map((role) => (
        <div key={role} className="flex flex-col gap-1">
          <span
            className="text-text-tertiary"
            style={{ fontSize: "var(--type-caption-size)" }}
          >
            <TokenName name={`--type-${role}-size`} />
          </span>
          <span
            className={
              role === "display"
                ? "font-display font-bold"
                : role === "title"
                  ? "font-semibold"
                  : undefined
            }
            style={{
              fontSize: `var(--type-${role}-size)`,
              lineHeight: `var(--type-${role}-leading)`,
              // The title role names its face (`--type-title-font`): the
              // workhorse today, the display face under the redesign.
              ...(role === "title" ? { fontFamily: "var(--type-title-font)" } : null),
            }}
          >
            {t("qaUi.type.sample")}
          </span>
        </div>
      ))}
    </div>
  );
}

const SPACING_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;

function ScaleSheet() {
  return (
    <div className="flex flex-col gap-2">
      {SPACING_STEPS.map((step) => (
        <div key={step} className="flex items-center gap-3">
          <span
            className="w-16 shrink-0 text-text-tertiary"
            style={{ fontSize: "var(--type-caption-size)" }}
          >
            {step}
          </span>
          <span
            aria-hidden
            className="h-3 rounded-[var(--radius-tick)] bg-accent"
            style={{ width: `calc(var(--spacing) * ${step})` }}
          />
        </div>
      ))}
      {SPACE_TOKENS.map((token) => (
        <div key={token} className="flex items-center gap-3">
          <span
            className="w-16 shrink-0 text-text-tertiary"
            style={{ fontSize: "var(--type-caption-size)" }}
          >
            <TokenName name={token} />
          </span>
          <span
            aria-hidden
            className="h-3 min-w-px rounded-[var(--radius-tick)] bg-accent"
            style={{ width: `var(${token})` }}
          />
        </div>
      ))}
    </div>
  );
}

const OBJECT_ICONS = [ChatCircle, SpeakerHigh, Microphone, Bell, UsersThree, GearSix] as const;
const SYMBOL_ICONS = [Hash, Plus, MagnifyingGlass, X, CaretDown] as const;
const ICON_SIZES = ["sm", "md", "lg"] as const;

/**
 * The icon set at each size token, one row per kind. The stroke token is drawn
 * on a Lucide glyph, the only kind of icon that has a stroke to set.
 */
function IconSheet() {
  const { t } = useTranslation();
  const row = (label: string, icons: typeof OBJECT_ICONS | typeof SYMBOL_ICONS, kind: "object" | "symbol") => (
    <div className="flex flex-col gap-2">
      <p className="text-text-tertiary" style={{ fontSize: "var(--type-label-size)" }}>
        {label}
      </p>
      {ICON_SIZES.map((size, index) => (
        <div key={size} className="flex items-center gap-4">
          <span className="w-28 shrink-0" style={{ fontSize: "var(--type-caption-size)" }}>
            <TokenName name={ICON_SIZE_TOKENS[index]!} />
          </span>
          {icons.map((glyph, i) => (
            <Icon key={i} icon={glyph} kind={kind} size={size} className="text-text-secondary" />
          ))}
        </div>
      ))}
    </div>
  );
  return (
    <div className="flex flex-col gap-6">
      {row(t("qaUi.icons.objects"), OBJECT_ICONS, "object")}
      {row(t("qaUi.icons.symbols"), SYMBOL_ICONS, "symbol")}
      <div className="flex items-center gap-4">
        <span className="w-28 shrink-0" style={{ fontSize: "var(--type-caption-size)" }}>
          <TokenName name={ICON_STROKE_TOKEN} />
        </span>
        <LineHash
          aria-hidden
          className="h-[var(--icon-md)] w-[var(--icon-md)] text-text-secondary"
          style={{ strokeWidth: `var(${ICON_STROKE_TOKEN})` }}
        />
        <span className="text-text-tertiary" style={{ fontSize: "var(--type-caption-size)" }}>
          {t("qaUi.icons.stroke")}
        </span>
      </div>
    </div>
  );
}

/** One list row of the specimen. `tone` is the row's state. */
function SpecimenRow({
  name,
  tone,
}: {
  name: string;
  tone: "selected" | "unread" | "hover" | "read";
}) {
  return (
    <div
      className={
        "flex h-[var(--control-row)] items-center gap-2 rounded-[var(--radius-row)] px-3 " +
        (tone === "selected"
          ? "bg-row-selected text-on-row-selected"
          : tone === "hover"
            ? "bg-row-hover text-text"
            : tone === "unread"
              ? "font-semibold text-text"
              : "text-text-secondary")
      }
      style={{ fontSize: "var(--type-body-size)" }}
    >
      <Icon icon={Hash} kind="symbol" size="sm" className={tone === "read" ? "text-text-tertiary" : undefined} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {tone === "unread" ? (
        <span aria-hidden className="h-2 w-2 rounded-full bg-indicator" />
      ) : null}
    </div>
  );
}

/**
 * The shell, drawn with nothing but tokens: the canvas, a rail, the side pane
 * with every row state, the conversation with a mention, and the composer.
 * It is what the design council scores for the token phase, before any real
 * component moves. With the redesign off it shows the same roles resolved for
 * today's look, which is how a reviewer sees what the toggle changes.
 */
function ShellSpecimen() {
  const { t } = useTranslation();
  const titleStyle = {
    fontFamily: "var(--type-title-font)",
    fontSize: "var(--type-title-size)",
    lineHeight: "var(--type-title-leading)",
  } as const;
  const sectionLabel = "px-3 pb-1 pt-3 font-medium";
  return (
    <div className="flex flex-col gap-2">
      <div
        data-testid="qa-shell-specimen"
        className="flex h-[26rem] overflow-hidden rounded-[var(--radius-panel)] border border-border bg-canvas"
        style={{ gap: "var(--space-gutter)", padding: "var(--space-gutter)" }}
      >
        <div className="flex w-14 shrink-0 flex-col items-center gap-2 py-2">
          <span className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-card)] bg-accent text-on-accent">
            <Icon icon={ChatCircle} />
          </span>
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-pane-side font-display font-bold text-text-secondary">
            M
          </span>
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-pane-side text-text-secondary">
            <Icon icon={Plus} kind="symbol" />
          </span>
        </div>

        <div className="flex w-56 shrink-0 flex-col rounded-[var(--radius-pane)] bg-pane-side py-3" style={{ paddingInline: "calc(var(--space-pane) / 2)" }}>
          <div className="flex items-center gap-1 px-3 pb-2 font-bold text-text" style={titleStyle}>
            <span className="min-w-0 flex-1 truncate">Turma do Fliperama</span>
            <Icon icon={CaretDown} kind="symbol" size="sm" className="text-text-tertiary" />
          </div>
          <p className={`${sectionLabel} text-text-tertiary`} style={{ fontSize: "var(--type-label-size)" }}>
            {t("qaUi.shell.textChannels")}
          </p>
          <div className="flex flex-col gap-0.5">
            <SpecimenRow name="papo" tone="selected" />
            <SpecimenRow name="avisos" tone="unread" />
            <SpecimenRow name="clipes" tone="hover" />
            <SpecimenRow name="geral" tone="read" />
          </div>
          <p className={`${sectionLabel} text-accent-text`} style={{ fontSize: "var(--type-label-size)" }}>
            {t("qaUi.shell.inCall")}
          </p>
          <div className="flex items-center gap-2 px-3 text-text" style={{ fontSize: "var(--type-body-size)" }}>
            <Icon icon={SpeakerHigh} size="sm" className="text-success-text" />
            Rafa
          </div>
          <p className={`${sectionLabel} text-text-tertiary`} style={{ fontSize: "var(--type-label-size)" }}>
            {t("qaUi.shell.offline")}
          </p>
          <div className="px-3 text-text-tertiary" style={{ fontSize: "var(--type-body-size)" }}>
            Teo
          </div>
          <div className="mt-auto flex items-center gap-2 rounded-[var(--radius-card)] bg-surface-2 p-2 shadow-[var(--shadow-1)]">
            <span className="h-8 w-8 rounded-full bg-surface-3" />
            <span className="min-w-0 flex-1 truncate font-medium text-text" style={{ fontSize: "var(--type-label-size)" }}>
              Lia
            </span>
            <Icon icon={Microphone} size="sm" className="text-text-secondary" />
            <Icon icon={GearSix} size="sm" className="text-text-secondary" />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col rounded-[var(--radius-pane)] bg-pane-main">
          <div className="flex items-center gap-2 border-b border-border py-3 text-text" style={{ ...titleStyle, paddingInline: "var(--space-pane)" }}>
            <Icon icon={Hash} kind="symbol" className="text-text-tertiary" />
            <span className="font-bold">papo</span>
          </div>
          <div className="flex flex-1 flex-col justify-end gap-1 py-2">
            <div className="flex gap-3 py-1" style={{ paddingInline: "var(--space-pane)" }}>
              <span className="h-10 w-10 shrink-0 rounded-full bg-surface-3" />
              <div className="min-w-0">
                <p className="flex items-baseline gap-2">
                  <span className="font-semibold text-text">Bia</span>
                  <span className="tabular-nums text-text-tertiary" style={{ fontSize: "var(--type-caption-size)" }}>
                    21:04
                  </span>
                </p>
                <p className="text-text" style={{ fontSize: "var(--chat-font-size)" }}>
                  {t("qaUi.shell.messageOne")}
                </p>
              </div>
            </div>
            <div
              className="flex gap-3 border-l-[3px] border-mention-bar bg-mention-row py-1"
              style={{ paddingInline: "calc(var(--space-pane) - 3px) var(--space-pane)" }}
            >
              <span className="h-10 w-10 shrink-0 rounded-full bg-surface-3" />
              <div className="min-w-0">
                <p className="flex items-baseline gap-2">
                  <span className="font-semibold text-text">Rafa</span>
                  <span className="tabular-nums text-text-tertiary" style={{ fontSize: "var(--type-caption-size)" }}>
                    21:06
                  </span>
                </p>
                <p className="text-text" style={{ fontSize: "var(--chat-font-size)" }}>
                  <span className="rounded-[var(--radius-tick)] bg-mention-chip px-1 font-medium text-on-mention-chip">
                    @lia
                  </span>{" "}
                  {t("qaUi.shell.messageTwo")}
                </p>
              </div>
            </div>
          </div>
          <div className="pb-3" style={{ paddingInline: "var(--space-pane)" }}>
            <div className="flex h-14 items-center gap-2 rounded-full border border-border bg-surface-2 pl-5 pr-2 shadow-[var(--shadow-2)]">
              <span className="min-w-0 flex-1 truncate text-text-tertiary">
                {t("qaUi.shell.composer", { channel: "papo" })}
              </span>
              <span
                role="img"
                aria-label={t("qaUi.shell.send")}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-on-accent"
              >
                <Icon icon={PaperPlaneRight} />
              </span>
            </div>
          </div>
        </div>
      </div>
      <p className="text-text-tertiary" style={{ fontSize: "var(--type-caption-size)" }}>
        {t("qaUi.shell.legend")}
      </p>
    </div>
  );
}

function RadiusSheet() {
  return (
    <div className="flex flex-wrap gap-4">
      {RADIUS_TOKENS.map((token) => (
        <div key={token} className="flex flex-col items-center gap-2">
          <span
            aria-hidden
            className="h-16 w-16 border border-border bg-surface-2"
            style={{ borderRadius: `var(${token})` }}
          />
          <span style={{ fontSize: "var(--type-caption-size)" }}>
            <TokenName name={token} />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The three levels, drawn on the app background so the surface step is visible.
 * Each sample writes the level's own utility class, not a copy of its parts —
 * if a level ever stops differing from its neighbour, it stops differing here.
 *
 * The raw shadow ladder follows the levels. Levels 2 and 3 both draw
 * `--shadow-2`, so without these three swatches `--shadow-1` and `--shadow-3`
 * would be tokens a theme can set and nobody can see.
 */
function ElevationSheet() {
  return (
    <div className="flex flex-wrap gap-4">
      {ELEVATION_LEVELS.map((level) => (
        <div key={level.utility} className="flex flex-col gap-2">
          <span
            aria-hidden
            className={`block h-16 w-40 rounded-[var(--radius-card)] ${level.utility}`}
          />
          <span
            className="flex flex-col gap-0.5"
            style={{ fontSize: "var(--type-caption-size)" }}
          >
            <TokenName name={level.utility} />
            {level.tokens.map((token) => (
              <span key={token} className="text-text-tertiary">
                <TokenName name={token} />
              </span>
            ))}
          </span>
        </div>
      ))}
      {SHADOW_TOKENS.map((token) => (
        <div key={token} className="flex flex-col gap-2">
          <span
            aria-hidden
            className="block h-16 w-40 rounded-[var(--radius-card)] bg-surface-1"
            style={{ boxShadow: `var(${token})` }}
          />
          <span
            className="flex flex-col gap-0.5 text-text-tertiary"
            style={{ fontSize: "var(--type-caption-size)" }}
          >
            <TokenName name={token} />
          </span>
        </div>
      ))}
    </div>
  );
}

function MotionSheet() {
  return (
    <div className="flex flex-col gap-4">
      {DURATION_TOKENS.map((duration) =>
        EASE_TOKENS.map((ease) => (
          <div key={`${duration}${ease}`} className="flex items-center gap-3">
            <span
              className="w-72 shrink-0 text-text-tertiary"
              style={{ fontSize: "var(--type-caption-size)" }}
            >
              <TokenName name={duration} /> <TokenName name={ease} />
            </span>
            <span className="group relative block h-5 flex-1 rounded-[var(--radius-pill)] bg-surface-2 p-1">
              <span
                aria-hidden
                className="absolute left-1 top-1/2 h-3 w-3 -translate-y-1/2 rounded-[var(--radius-pill)] bg-accent transition-[left] group-hover:left-[calc(100%-1rem)]"
                style={{
                  transitionDuration: `var(${duration})`,
                  transitionTimingFunction: `var(${ease})`,
                }}
              />
            </span>
          </div>
        )),
      )}
    </div>
  );
}

function ControlSheet() {
  return (
    <div className="flex flex-wrap items-end gap-4">
      {CONTROL_TOKENS.map((token) => (
        <div key={token} className="flex flex-col items-center gap-2">
          <span
            aria-hidden
            className="w-24 rounded-[var(--radius-control)] border border-border bg-surface-2"
            style={{ height: `var(${token})` }}
          />
          <span style={{ fontSize: "var(--type-caption-size)" }}>
            <TokenName name={token} />
          </span>
        </div>
      ))}
    </div>
  );
}

const BUTTON_VARIANTS = ["default", "secondary", "ghost", "danger", "danger-ghost"] as const;
const BADGE_VARIANTS: BadgeVariant[] = [
  "new",
  "accent",
  "success",
  "warning",
  "danger",
  "neutral",
];
const ICON_BUTTON_SIZES: IconButtonSize[] = ["xs", "sm", "md", "lg"];
const BUTTON_SIZES = ["lg", "default", "sm", "icon-lg", "icon", "icon-sm"] as const;

function PrimitiveSheet() {
  const { t } = useTranslation();
  const [switchOn, setSwitchOn] = useState(true);
  const [checked, setChecked] = useState(false);
  const [scrub, setScrub] = useState(42);
  const [volume, setVolume] = useState(70);
  const [pressed, setPressed] = useState(true);

  return (
    <div className="flex flex-col gap-6">
      {/* `data-testid`: the design council's focused shot of this primitive
          (e2e/design-council-shots.spec.ts, "primitives"). */}
      <div data-testid="qa-primitive-button">
        <p
          className="mb-2 text-text-tertiary"
          style={{ fontSize: "var(--type-label-size)" }}
        >
          Button
        </p>
        <div className="flex flex-col gap-2">
          {BUTTON_VARIANTS.map((variant) => (
            <div key={variant} className="flex flex-wrap items-center gap-2">
              {BUTTON_SIZES.map((size) => (
                <Button
                  key={size}
                  variant={variant}
                  size={size}
                  aria-label={size.startsWith("icon") ? `${variant} ${size}` : undefined}
                >
                  {size.startsWith("icon") ? (
                    <Icon
                      icon={Plus}
                      kind="symbol"
                      size={size === "icon-sm" ? "sm" : size === "icon-lg" ? "lg" : "md"}
                    />
                  ) : (
                    `${variant} ${size}`
                  )}
                </Button>
              ))}
              <Button variant={variant} disabled>
                {t("qaUi.state.disabled")}
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div data-testid="qa-primitive-icon-button">
        <p
          className="mb-2 text-text-tertiary"
          style={{ fontSize: "var(--type-label-size)" }}
        >
          IconButton
        </p>
        <div className="flex flex-col gap-2">
          {ICON_BUTTON_SIZES.map((size) => {
            const glyph = size === "xs" || size === "sm" ? "sm" : "md";
            return (
              <div key={size} className="flex flex-wrap items-center gap-3">
                <span
                  className="w-8 text-text-tertiary"
                  style={{ fontSize: "var(--type-caption-size)" }}
                >
                  {size}
                </span>
                <IconButton size={size} touch={false} side="right" label={`${t("qaUi.iconButton.settings")} ${size}`}>
                  <Icon icon={GearSix} size={glyph} />
                </IconButton>
                <IconButton
                  size={size}
                  touch={false}
                  side="right"
                  pressed={pressed}
                  onClick={() => setPressed((value) => !value)}
                  label={`${t("qaUi.iconButton.mute")} ${size}`}
                >
                  <Icon icon={Microphone} size={glyph} />
                </IconButton>
                <IconButton
                  size={size}
                  touch={false}
                  side="right"
                  tone="danger"
                  label={`${t("qaUi.iconButton.remove")} ${size}`}
                >
                  <Icon icon={X} kind="symbol" size={glyph} />
                </IconButton>
                <IconButton size={size} touch={false} side="right" disabled label={t("qaUi.state.disabled")}>
                  <Icon icon={Bell} size={glyph} />
                </IconButton>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span style={{ fontSize: "var(--type-label-size)" }}>
            {t("qaUi.state.default")}
          </span>
          <Input placeholder={t("qaUi.input.placeholder")} />
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ fontSize: "var(--type-label-size)" }}>
            {t("qaUi.state.disabled")}
          </span>
          <Input placeholder={t("qaUi.input.placeholder")} disabled />
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ fontSize: "var(--type-label-size)" }}>
            {t("qaUi.state.invalid")}
          </span>
          <Input
            aria-invalid
            className="border-danger"
            defaultValue={t("qaUi.input.invalidValue")}
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-[var(--radius-card)] border border-border bg-surface-1 p-2">
          <Switch
            checked={switchOn}
            onCheckedChange={setSwitchOn}
            label={t("qaUi.switch.label")}
            description={t("qaUi.switch.description")}
          />
          <Switch
            checked={false}
            onCheckedChange={() => undefined}
            disabled
            label={t("qaUi.state.disabled")}
          />
        </div>
        <div className="rounded-[var(--radius-card)] border border-border bg-surface-1 p-2">
          <CheckRow
            checked={checked}
            onCheckedChange={setChecked}
            label={t("qaUi.check.label")}
          />
          <CheckRow
            checked
            onCheckedChange={() => undefined}
            disabled
            label={t("qaUi.state.disabled")}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-6">
        <div className="flex w-48 flex-col gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <Tooltip label={t("qaUi.tooltip.label")} detail={t("qaUi.tooltip.detail")}>
          <Button variant="secondary">{t("qaUi.tooltip.trigger")}</Button>
        </Tooltip>
        <Tooltip label={t("qaUi.tooltip.railLabel")} tone="rail" side="right">
          <Button variant="secondary">{t("qaUi.tooltip.railTrigger")}</Button>
        </Tooltip>
      </div>

      <div>
        <p
          className="mb-2 text-text-tertiary"
          style={{ fontSize: "var(--type-label-size)" }}
        >
          Badge
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {BADGE_VARIANTS.map((variant) => (
            <Badge key={variant} variant={variant}>
              {variant}
            </Badge>
          ))}
          <Badge variant="success" icon={CheckIcon}>
            success + icon
          </Badge>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-2">
          <span style={{ fontSize: "var(--type-label-size)" }}>
            {t("qaUi.slider.scrub")}
          </span>
          <Slider
            variant="scrub"
            value={scrub}
            max={100}
            aria-label={t("qaUi.slider.scrub")}
            onValueChange={setScrub}
          />
        </label>
        <label className="flex flex-col gap-2">
          <span style={{ fontSize: "var(--type-label-size)" }}>
            {t("qaUi.slider.volume")}
          </span>
          <Slider
            variant="volume"
            value={volume}
            max={100}
            aria-label={t("qaUi.slider.volume")}
            onValueChange={setVolume}
          />
        </label>
        <label className="flex flex-col gap-2 sm:col-span-2">
          <span style={{ fontSize: "var(--type-label-size)" }}>
            {t("qaUi.slider.readOnly")}
          </span>
          <Slider
            variant="scrub"
            readOnly
            value={scrub}
            max={100}
            aria-label={t("qaUi.slider.readOnly")}
          />
        </label>
      </div>
    </div>
  );
}

export function UiTokensPage() {
  const { t } = useTranslation();

  if (!isDevAuthBypassEnabled()) {
    return <Navigate to={isDesktopApp() ? "/app" : "/"} replace />;
  }

  return (
    <TooltipProvider>
      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-5 py-10">
        <header>
          <h1
            className="font-display font-bold"
            style={{
              fontSize: "var(--type-display-size)",
              lineHeight: "var(--type-display-leading)",
            }}
          >
            {t("qaUi.title")}
          </h1>
          <p className="mt-2 text-text-tertiary">{t("qaUi.lede")}</p>
        </header>

        <Section title={t("qaUi.section.theme")}>
          <ThemeControls />
        </Section>
        <Section title={t("qaUi.section.shell")} note={t("qaUi.shell.note")}>
          <ShellSpecimen />
        </Section>
        <Section title={t("qaUi.section.colour")} note={t("qaUi.colour.note")}>
          <ColourSheet />
        </Section>
        <Section title={t("qaUi.section.type")}>
          <TypeRamp />
        </Section>
        <Section title={t("qaUi.section.spacing")} note={t("qaUi.spacing.note")}>
          <ScaleSheet />
        </Section>
        <Section title={t("qaUi.section.radius")}>
          <RadiusSheet />
        </Section>
        <Section title={t("qaUi.section.icons")} note={t("qaUi.icons.note")}>
          <IconSheet />
        </Section>
        <Section
          title={t("qaUi.section.elevation")}
          note={t("qaUi.elevation.note")}
        >
          <ElevationSheet />
        </Section>
        <Section title={t("qaUi.section.motion")} note={t("qaUi.motion.note")}>
          <MotionSheet />
        </Section>
        <Section title={t("qaUi.section.controls")}>
          <ControlSheet />
        </Section>
        <Section title={t("qaUi.section.primitives")}>
          <PrimitiveSheet />
        </Section>
        <Section title={t("qaUi.section.kit")} note={t("qaUi.kit.note")}>
          <SettingsKitSheet />
        </Section>
      </main>
    </TooltipProvider>
  );
}
