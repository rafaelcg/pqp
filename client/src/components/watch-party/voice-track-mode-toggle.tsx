import { useTranslation } from "@/lib/i18n";
import type { VoiceTrackMode } from "@/lib/voice-track-mode";
import { cn } from "@/lib/utils";

/**
 * "Voz: junto com o filme / separada".
 *
 * `LIVE_HLS_VOICE_TRACK`'s host-facing control. Its own component, not a
 * block inside `watch-party-panel.tsx`, so PR 538's rewrite of that file
 * never has to carry this logic through a merge — see
 * `docs/plans/WATCH_PARTY_SEPARATE_TRACKS.md`.
 *
 * ONLY EVER MOUNTED BEHIND THE SERVER'S OWN FLAG. The caller decides that
 * (`useLiveHlsConfig(serverId)?.voiceTrack`, the same rule `micArchive`
 * already follows): a build must never publish a client-side default for
 * whether THIS deployment's camera slot can carry a second track, and this
 * component takes no opinion on it — it just draws the two options once
 * mounted.
 */
export function VoiceTrackModeToggle({
  mode,
  onChange,
  className,
}: {
  mode: VoiceTrackMode;
  onChange: (mode: VoiceTrackMode) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const options: { value: VoiceTrackMode; label: string }[] = [
    { value: "junto", label: t("watchParty.voiceTrack.junto") },
    { value: "separada", label: t("watchParty.voiceTrack.separada") },
  ];

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
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
    const current = options.findIndex((option) => option.value === mode);
    const next = options[(current + step + options.length) % options.length]!;
    onChange(next.value);
    const radios =
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios[(current + step + options.length) % options.length]?.focus();
  }

  return (
    <div className={cn("px-1 py-0.5", className)} data-watch-party-voice-track-mode>
      <p className="mb-1 text-xs font-medium text-text">
        {t("watchParty.voiceTrack.label")}
      </p>
      <div
        role="radiogroup"
        aria-label={t("watchParty.voiceTrack.label")}
        data-testid="voice-track-mode-toggle"
        className="grid grid-cols-2 gap-1"
        onKeyDown={handleKeyDown}
      >
        {options.map((option) => {
          const selected = option.value === mode;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              data-testid={`voice-track-mode-${option.value}`}
              onClick={() => onChange(option.value)}
              className={cn(
                "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                selected
                  ? "border-accent bg-surface-2 text-text"
                  : "border-border text-text-muted hover:border-border-strong hover:text-text",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[11px] text-text-tertiary">
        {t("watchParty.voiceTrack.hint")}
      </p>
    </div>
  );
}
