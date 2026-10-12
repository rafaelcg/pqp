import { Ghost, TreePine } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CornerCard } from "@/components/layout/corner-card";
import { LookMiniature } from "@/components/settings/look-miniature";
import { Button } from "@/components/ui/button";
import { useAccentHue } from "@/hooks/use-accent-hue";
import { useAppearance } from "@/hooks/use-appearance";
import { useTheme } from "@/hooks/use-theme";
import {
  appearanceForcesDark,
  getAppearance,
  isRetroLookOn,
  setRetroLook,
  type AppearancePreference,
} from "@/lib/appearance";
import { chooseLook } from "@/lib/choose-look";
import { isAutomatedBrowser, isHintSeen, rememberHint } from "@/lib/hints";
import { useTranslation } from "@/lib/i18n";
import {
  currentSeason,
  seasonalHintKey,
  type SeasonalLook,
} from "@/lib/seasonal-looks";

/**
 * Whether the seasonal card wants the corner: it is a look's season, this
 * browser has not been invited to it this season, and that look is not
 * already on. Read once per load by `App`, same as the cargos card.
 */
export function seasonalLookToOffer(): SeasonalLook | null {
  if (isAutomatedBrowser()) {
    return null;
  }
  const season = currentSeason();
  if (!season || getAppearance() === season) {
    return null;
  }
  return isHintSeen(seasonalHintKey(season)) ? null : season;
}

const ICONS = { halloween: Ghost, christmas: TreePine } as const;

/**
 * One corner card per season: "the Halloween look is here, try it".
 *
 * "Experimentar" switches the look on the spot through the same door as the
 * picker (`chooseLook`), so a dark-only look still remembers the mode to go
 * back to. The card then stays up with an Undo, because the person just
 * repainted the whole app from a popup and should be able to take it back from
 * the same place.
 */
export function SeasonalLookHint({
  look: offered,
  enabled,
  onDismiss,
}: {
  look: SeasonalLook | null;
  enabled: boolean;
  /** Hands the corner on; see `CargosHint`. */
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  // `App` drops the offer on dismiss; keep drawing the last one so the card
  // can play its exit instead of vanishing.
  const lastOffered = useRef(offered);
  if (offered) {
    lastOffered.current = offered;
  }
  const look = lastOffered.current;
  const { resolved } = useTheme();
  const { preference: accentPreference } = useAccentHue();
  const [open, setOpen] = useState(true);
  // The look before Try it, and whether Modo 2005 was painted over it, so Undo
  // gives back exactly what was on screen.
  const [previous, setPrevious] = useState<{
    look: AppearancePreference;
    retro: boolean;
  } | null>(null);
  const remembered = useRef(false);
  const { appearance } = useAppearance();
  // The account can carry the look from another device, adopted after this
  // card was queued. Nothing to invite to then: hand the corner on unseen.
  const alreadyOn = look !== null && appearance === look && previous === null;

  useEffect(() => {
    if (look && enabled && !alreadyOn && !remembered.current) {
      remembered.current = true;
      rememberHint(seasonalHintKey(look));
    }
  }, [look, enabled, alreadyOn]);

  useEffect(() => {
    if (alreadyOn) {
      onDismiss?.();
    }
  }, [alreadyOn, onDismiss]);

  if (!look) {
    return null;
  }

  const close = () => {
    setOpen(false);
    onDismiss?.();
  };
  const Icon = ICONS[look];
  const applied = previous !== null;
  const mode = appearanceForcesDark(look) ? "dark" : resolved;

  return (
    <CornerCard
      open={enabled && offered !== null && open && !alreadyOn}
      onClose={close}
      label={t(`seasonalLookHint.${look}.title`)}
      dismissLabel={t("seasonalLookHint.dismiss")}
      dataAttribute="seasonal-look"
      title={
        <span className="inline-flex items-center gap-2">
          <Icon aria-hidden className="h-4 w-4 shrink-0 text-accent" strokeWidth={2} />
          {applied
            ? t("seasonalLookHint.applied.title")
            : t(`seasonalLookHint.${look}.title`)}
        </span>
      }
      body={
        applied
          ? t("seasonalLookHint.applied.body")
          : t(`seasonalLookHint.${look}.body`)
      }
      footer={
        applied ? (
          <div className="flex items-center gap-2">
            <Button size="sm" className="cta-lift rounded-full px-4" onClick={close}>
              {t("seasonalLookHint.keep")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full px-3"
              onClick={() => {
                chooseLook(previous.look);
                if (previous.retro) {
                  setRetroLook(true);
                }
                close();
              }}
            >
              {t("seasonalLookHint.undo")}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="cta-lift rounded-full px-4"
              onClick={() => {
                setPrevious({ look: getAppearance(), retro: isRetroLookOn() });
                chooseLook(look);
              }}
            >
              {t("seasonalLookHint.cta")}
            </Button>
            <Button size="sm" variant="ghost" className="rounded-full px-3" onClick={close}>
              {t("seasonalLookHint.later")}
            </Button>
          </div>
        )
      }
    >
      {applied ? null : (
        <div aria-hidden className="pointer-events-none mt-3">
          <LookMiniature
            look={look}
            mode={mode}
            customAccent={accentPreference !== "default"}
          />
        </div>
      )}
    </CornerCard>
  );
}
