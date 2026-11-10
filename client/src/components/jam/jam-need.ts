import { useCallback } from "react";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import type { JamNeed } from "@/lib/jam-wall";

/** What a tile or a song header says a song needs, in words ("falta voz"). */
export function useNeedLabel(): (need: JamNeed) => string {
  const { t, locale } = useTranslation();
  return useCallback(
    (need: JamNeed) => {
      switch (need.kind) {
        case "empty":
          return t("jam.needs.empty");
        case "open":
          return t("jam.needs.open");
        case "ready":
          return t("jam.needs.ready");
        case "missing": {
          if (need.instruments.length === 1) {
            return t(JAM_INSTRUMENT_LOOK[need.instruments[0]!].missingKey as MessageKey);
          }
          const names = need.instruments.map((instrument) =>
            t(JAM_INSTRUMENT_LOOK[instrument].nameKey as MessageKey).toLowerCase(),
          );
          return t("jam.needs.missingMany", { list: formatList(names, locale) });
        }
      }
    },
    [t, locale],
  );
}

export function formatList(items: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}
