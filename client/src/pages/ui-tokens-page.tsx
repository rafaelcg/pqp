import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CheckRow } from "@/components/ui/check-row";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { useAppearance } from "@/hooks/use-appearance";
import { useContrast } from "@/hooks/use-contrast";
import { useTheme } from "@/hooks/use-theme";
import { APPEARANCES, type AppearancePreference } from "@/lib/appearance";
import {
  COLOR_TOKEN_GROUPS,
  CONTROL_TOKENS,
  contrastRatio,
  DURATION_TOKENS,
  EASE_TOKENS,
  ELEVATION_LEVELS,
  RADIUS_TOKENS,
  readToken,
  roundRatio,
  SOFT_PAIRS,
  TYPE_ROLES,
} from "@/lib/design-tokens";
import { isDesktopApp } from "@/lib/desktop";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { useTranslation, type MessageKey } from "@/lib/i18n";

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

  const presetKey = (preset: AppearancePreference): MessageKey =>
    `settings.appearance.preset.${preset}` as MessageKey;

  return (
    <div className="flex flex-col gap-4">
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
              variant={appearance.appearance === preset ? "default" : "secondary"}
              onClick={() => appearance.setAppearance(preset)}
            >
              {t(presetKey(preset))}
            </Button>
          ))}
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
  const [swatches, setSwatches] = useState<Swatch[]>([]);

  // The attributes are already on the document when these values change, but
  // the ratios have to be read after the browser has recomputed them, so this
  // re-runs on every axis of the theme rather than only on mount.
  useEffect(() => {
    setSwatches(measure());
  }, [theme.resolved, appearance.appearance, contrast.resolved]);

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
            className={role === "display" ? "font-display font-bold" : undefined}
            style={{
              fontSize: `var(--type-${role}-size)`,
              lineHeight: `var(--type-${role}-leading)`,
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

const BUTTON_VARIANTS = ["default", "secondary", "ghost", "danger"] as const;
const BUTTON_SIZES = ["default", "sm", "icon"] as const;

function PrimitiveSheet() {
  const { t } = useTranslation();
  const [switchOn, setSwitchOn] = useState(true);
  const [checked, setChecked] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <div>
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
                <Button key={size} variant={variant} size={size}>
                  {size === "icon" ? "@" : `${variant} ${size}`}
                </Button>
              ))}
              <Button variant={variant} disabled>
                {t("qaUi.state.disabled")}
              </Button>
            </div>
          ))}
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
      </main>
    </TooltipProvider>
  );
}
