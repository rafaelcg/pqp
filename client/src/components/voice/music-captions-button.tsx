import { Captions, CaptionsOff } from "lucide-react";
import { useMemo } from "react";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { Menu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import {
  captionLanguageName,
  musicCaptionsChoices,
  setMusicCaptions,
  useMusicCaptions,
} from "@/lib/music-captions";
import { cn } from "@/lib/utils";

/**
 * YouTube's CC button and Settings > Subtitles, which `controls: 0` hides.
 *
 * One button that opens the choices, the way YouTube's own gear does: a
 * plain toggle would leave the language to YouTube, which is the bug.
 * Personal, like volume. A video with no tracks dims the button in place
 * with a tooltip that says why, rather than removing it.
 */
export function MusicCaptionsButton({ className }: { className?: string }) {
  const { t, locale } = useTranslation();
  const captions = useMusicCaptions();
  const tracks = captions.tracks;
  const none = tracks !== null && tracks.length === 0;
  const unknown = tracks === null;

  const items = useMemo<ContextMenuItemDef[]>(() => {
    if (!tracks || tracks.length === 0) {
      return [];
    }
    const choices = musicCaptionsChoices({
      state: captions,
      uiLocale: locale,
      offLabel: t("music.captions.off"),
      autoTranslatedLabel: (language) => t("music.captions.autoTranslated", { language }),
      generatedLabel: (language) => t("music.captions.generated", { language }),
      languageName: (code, fallback) => captionLanguageName(locale, code, fallback),
    });
    return [
      { id: "captions-heading", label: t("music.captions.title"), heading: true },
      ...choices.flatMap<ContextMenuItemDef>((choice) => [
        ...(choice.startsRest
          ? [{ id: "captions-rest", label: "", separator: true }]
          : []),
        {
          id: choice.id,
          label: choice.label,
          checked: choice.checked,
          onSelect: () => setMusicCaptions(choice.lang),
        },
      ]),
    ];
  }, [captions, locale, t, tracks]);

  const label = captions.on ? t("music.captions.on") : t("music.captions.title");
  const detail = none
    ? t("music.captions.none")
    : unknown
      ? t("music.captions.loading")
      : undefined;
  const Icon = captions.on && !none ? Captions : CaptionsOff;
  const className_ = cn(
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-0/80 text-text hover:bg-surface-2",
    captions.on && !none && "text-signal",
    className,
  );

  if (items.length === 0) {
    // Dimmed in place, never missing, and the tooltip says why.
    return (
      <Tooltip label={t("music.captions.title")} detail={detail} side="top">
        <button
          type="button"
          data-music-captions="unavailable"
          aria-disabled="true"
          className={cn(className_, "cursor-default opacity-50 hover:bg-surface-0/80")}
        >
          <CaptionsOff className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </Tooltip>
    );
  }

  // A `Menu` trigger, like the watch player's layout picker: `Tooltip` and
  // `Menu` both want to own the trigger's ref, so the hint is the title.
  return (
    <Menu items={items} align="end" side="top">
      <button
        type="button"
        data-music-captions={captions.on ? "on" : "off"}
        aria-label={label}
        title={label}
        className={className_}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </Menu>
  );
}
