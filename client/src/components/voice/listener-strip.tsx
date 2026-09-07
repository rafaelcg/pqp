import { ChevronDown, ChevronUp, MicOff, ShieldBan } from "lucide-react";
import { useEffect, useState, type HTMLAttributes } from "react";
import {
  PeerAudioMenu,
  usePeerAudioMenu,
} from "@/components/voice/peer-audio-menu";
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
  const menu = usePeerAudioMenu<HTMLSpanElement>();
  const name = person.isSelf ? `${person.name} ${youLabel}` : person.name;
  // A chip you can act on is a button. One with no knob behind it (ourselves,
  // or a caller that wired no setter) stays a label, because a button that
  // opens nothing is worse than no button at all.
  const actionable = Boolean(person.onSetVolume || person.onRetry);
  const trigger: HTMLAttributes<HTMLSpanElement> & { tabIndex?: number } =
    actionable
      ? {
          role: "button",
          tabIndex: 0,
          "aria-haspopup": "dialog",
          "aria-expanded": menu.open,
          "aria-label": t("voice.audio.title", { name: person.name }),
          onClick: menu.toggle,
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              menu.toggle();
            }
          },
        }
      : {};
  return (
    <span
      ref={menu.rootRef}
      data-call-listener={person.name}
      {...trigger}
      className={cn(
        "relative flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-ink-3/70 py-0.5 pl-0.5 pr-2 ring-1 ring-ink-4/60",
        person.speaking && "ring-2 ring-success",
        actionable &&
          "cursor-pointer hover:bg-ink-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal",
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
      {/* Above the chip, because the row itself is one line tall. Opened by a
          click on the chip rather than by hovering it: the row is the surface
          a phone has, and a phone has no hover. */}
      <PeerAudioMenu
        name={person.name}
        open={menu.open}
        voice={
          person.onSetVolume
            ? {
                volume: person.volume ?? 1,
                onSetVolume: person.onSetVolume,
              }
            : undefined
        }
        failed={person.failed}
        onRetry={person.onRetry}
        side="top"
      />
    </span>
  );
}
