import { ChevronDown, ChevronUp, MicOff, ShieldBan } from "lucide-react";
import { useEffect, useState } from "react";
import { PeerTileControls } from "@/components/voice/peer-tile-controls";
import { VoiceAvatar } from "@/components/voice/voice-avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { listenerStripSlots } from "@/components/voice/stage-layout";

/**
 * The row under the stage: everybody who is not publishing a picture.
 *
 * NOT TILES. A listener has no video, so a 16:9 box for them is a box of
 * background colour with a face in the middle, and two hundred of those are
 * the scrolling rail that hid the streamer's camera in the first place. What a
 * listener has is a face, a name, whether they are talking and whether they
 * are muted, and all four fit in a chip the height of a line of text.
 *
 * THE ROOM CANNOT GROW THIS ROW. Past the limit the tail becomes one "+43"
 * chip that opens the rest in place, so a lobby of 200 costs the same
 * vertical space as a lobby of 3. Which faces survive the cut is
 * `listenerStripSlots` (us, then whoever is speaking); this file only draws
 * the answer.
 */

export interface StripListener {
  key: string;
  name: string;
  avatarUrl: string | null;
  speaking: boolean;
  muted: boolean;
  serverMuted: boolean;
  isSelf: boolean;
  volume?: number;
  onSetVolume?: (volume: number) => void;
  failed?: boolean;
  onRetry?: () => void;
}

export function ListenerStrip({
  people,
  limit,
  open,
  onToggle,
  youLabel,
  compact = false,
  className,
}: {
  people: StripListener[];
  /** How many chips before the overflow chip. */
  limit: number;
  /** The row is showing. Closed leaves only the toggle and a headcount. */
  open: boolean;
  onToggle: () => void;
  youLabel: string;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  // "Show everyone" is a look, not a setting: a room this person is scanning
  // now. It folds back the moment the row can hold everybody again.
  const [expanded, setExpanded] = useState(false);
  const slots = listenerStripSlots(people, limit);
  const overflow = expanded ? 0 : slots.overflow;
  const shown = expanded ? people : slots.shown;
  useEffect(() => {
    if (slots.overflow === 0) {
      setExpanded(false);
    }
  }, [slots.overflow]);

  if (people.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="listener-strip"
      data-open={open ? "true" : "false"}
      role="group"
      aria-label={t("voice.strip.label")}
      className={cn(
        "z-10 flex shrink-0 items-start gap-2 border-t border-ink-4/40 bg-ink-2/70 px-2 py-1.5",
        className,
      )}
    >
      <Tooltip label={open ? t("voice.rail.hide") : t("voice.rail.show")}>
        <button
          type="button"
          aria-label={open ? t("voice.rail.hide") : t("voice.rail.show")}
          aria-expanded={open}
          aria-controls="listener-strip-people"
          onClick={onToggle}
          className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-ink-3/80 px-2 text-[11px] tabular-nums text-paper-muted hover:bg-ink-4 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {people.length}
        </button>
      </Tooltip>
      {open && (
        <div
          id="listener-strip-people"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5",
            expanded
              ? "max-h-24 flex-wrap overflow-y-auto overscroll-contain [scrollbar-width:thin]"
              : "overflow-x-auto [scrollbar-width:thin]",
          )}
        >
          {shown.map((person) => (
            <ListenerChip
              key={person.key}
              person={person}
              youLabel={youLabel}
              compact={compact}
            />
          ))}
          {overflow > 0 && (
            <Tooltip label={t("voice.strip.showAll")}>
              <button
                type="button"
                data-testid="listener-overflow"
                aria-label={t("voice.strip.moreListeners", { count: overflow })}
                className="h-7 shrink-0 rounded-full bg-ink-3/80 px-2.5 text-[11px] font-semibold tabular-nums text-paper-muted hover:bg-ink-4 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                onClick={() => setExpanded(true)}
              >
                +{overflow}
              </button>
            </Tooltip>
          )}
          {expanded && (
            <button
              type="button"
              data-testid="listener-collapse"
              className="h-7 shrink-0 rounded-full bg-ink-3/80 px-2.5 text-[11px] text-paper-muted hover:bg-ink-4 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
              onClick={() => setExpanded(false)}
            >
              {t("voice.strip.showFewer")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ListenerChip({
  person,
  youLabel,
  compact,
}: {
  person: StripListener;
  youLabel: string;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const name = person.isSelf ? `${person.name} ${youLabel}` : person.name;
  return (
    <span
      data-call-listener={person.name}
      className={cn(
        "group relative flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-ink-3/70 py-0.5 pl-0.5 pr-2 ring-1 ring-ink-4/60",
        person.speaking && "ring-2 ring-success",
      )}
    >
      <VoiceAvatar
        name={person.name}
        avatarUrl={person.avatarUrl}
        isSpeaking={person.speaking}
        muted={person.muted}
        size="sm"
      />
      <span
        className={cn(
          "truncate text-[11px]",
          compact ? "max-w-[5rem]" : "max-w-[8rem]",
          person.speaking ? "text-paper" : "text-paper-muted",
        )}
      >
        {name}
      </span>
      {person.serverMuted ? (
        <ShieldBan
          className="h-3 w-3 shrink-0 text-warning"
          role="img"
          aria-label={t("voice.tile.serverMuted", { name: person.name })}
        />
      ) : (
        person.muted && (
          <MicOff
            className="h-3 w-3 shrink-0 text-danger"
            role="img"
            aria-label={t("voice.tile.mutedTitle")}
          />
        )
      )}
      {/* The volume slider and the Retry the rail thumbnails used to carry.
          Above the chip, on hover or focus, because the row itself is one line
          tall and a slider inside it would leave room for nothing else. */}
      {(person.onSetVolume || person.onRetry) && (
        <PeerTileControls
          name={person.name}
          volume={person.volume}
          onSetVolume={person.onSetVolume}
          failed={person.failed}
          onRetry={person.onRetry}
          alwaysOpen
          className="absolute bottom-full left-0 z-30 mb-1 hidden min-w-[8rem] rounded-md bg-ink-2 p-1 shadow-lg ring-1 ring-ink-4/80 group-hover:block group-focus-within:block"
        />
      )}
    </span>
  );
}
