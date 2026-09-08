import { useRef, type DragEvent } from "react";
import { Volume2, VolumeX } from "lucide-react";
import type { VoiceParticipant } from "@pqp/shared";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import {
  PeerAudioMenu,
  usePeerAudioMenu,
  type PeerAudioTrack,
} from "@/components/voice/peer-audio-menu";
import { VoiceAvatar } from "@/components/voice/voice-avatar";
import { useTranslation } from "@/lib/i18n";
import { VOICE_OCCUPANT_DRAG_MIME } from "@/lib/voice-occupant-dnd";
import {
  voiceOccupantAudioAffordance,
  voiceOccupantAudioInMenu,
  voiceOccupantAudioSilenced,
} from "@/lib/voice-occupant-audio";
import { cn } from "@/lib/utils";
import { VoiceOccupantBadges } from "./voice-occupant-badges";

/**
 * One seated person under a voice channel. Draggable when Discord would allow
 * it (yourself, or someone else if you have Move Members). Right-click and
 * the context-menu key / Shift+F10 open the same menu.
 *
 * LEFT-CLICK OPENS THEIR SOUND. This row has been a `role="button"` with no
 * `onClick` since it was written: it announced itself as pressable and did
 * nothing when pressed. A moderator running a 510-member community went
 * looking for per-person volume by clicking the person under the voice
 * channel, which is where Discord puts it and the first thing anybody tries,
 * and concluded the feature did not exist. It did; it was hover-only, on the
 * call stage, on the other side of the window. Now the press does what the
 * role promised.
 *
 * AND NOW THE ROW SAYS SO. Making the press work was not enough: the same
 * community asked again for per-person volume with "acho que deve ter porém
 * não achei". A speaker glyph in the trailing slot is the affordance, on hover
 * and focus for everybody and permanently for anyone you have turned down
 * (`voiceOccupantAudioAffordance`), which is the deal the pin on a channel row
 * already offers. It is `aria-hidden` decoration, not a nested button: the row
 * itself is the control, and a second focus stop that does the identical thing
 * is noise on a screen reader.
 *
 * RIGHT CLICK REACHES IT TOO, as the row's first context-menu item, because
 * that is the gesture people bring from Discord. It is prepended here rather
 * than built with the rest in `channel-list.tsx` for the same reason the panel
 * cannot own its trigger: the open state is this row's. The moderation items
 * keep the menu they have always had.
 *
 * The speaking ring lives on `VoiceAvatar`. The drag ghost is a clone of this
 * row, taken at dragstart, so the ring is still on the preview after the
 * source fades.
 */
export function VoiceOccupantRow({
  person,
  channelId,
  isSpeaking,
  canDrag,
  isDragging = false,
  items,
  audio,
  onDragStart,
  onDragEnd,
}: {
  person: VoiceParticipant;
  channelId: string;
  isSpeaking: boolean;
  canDrag: boolean;
  isDragging?: boolean;
  items: ContextMenuItemDef[];
  /**
   * This person's voice and their share's sound, for whoever is in the call
   * with them. Absent for ourselves, and for anyone we are not listening to
   * (a channel we have not joined), where a volume knob would govern nothing.
   */
  audio?: { voice?: PeerAudioTrack; share?: PeerAudioTrack };
  onDragStart: (person: VoiceParticipant, channelId: string) => void;
  onDragEnd: () => void;
}) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLElement | null>(null);
  const menu = usePeerAudioMenu<HTMLLIElement>();
  const hasAudio = Boolean(audio?.voice || audio?.share);
  const volumes = {
    voiceVolume: audio?.voice?.volume,
    shareVolume: audio?.share?.volume,
  };
  const affordance = voiceOccupantAudioAffordance({
    ...volumes,
    menuOpen: menu.open,
  });
  const silenced = voiceOccupantAudioSilenced(volumes);
  const audioLabel = t("voice.audio.title", { name: person.displayName });
  const menuItems = voiceOccupantAudioInMenu(affordance)
    ? ([
        {
          id: "peer-audio",
          label: audioLabel,
          icon: silenced ? VolumeX : Volume2,
          onSelect: () => menu.setOpen(true),
        },
        { id: "sep-peer-audio", label: "", separator: true },
        ...items,
      ] satisfies ContextMenuItemDef[])
    : items;

  function clearGhost() {
    ghostRef.current?.remove();
    ghostRef.current = null;
  }

  function handleDragStart(event: DragEvent<HTMLDivElement>) {
    if (!canDrag) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      VOICE_OCCUPANT_DRAG_MIME,
      JSON.stringify({
        userId: person.userId,
        fromChannelId: channelId,
        displayName: person.displayName,
      }),
    );
    event.dataTransfer.setData("text/plain", person.displayName);
    const source = rowRef.current;
    if (source) {
      clearGhost();
      const ghost = source.cloneNode(true) as HTMLElement;
      ghost.setAttribute("aria-hidden", "true");
      ghost.style.position = "absolute";
      ghost.style.left = "-9999px";
      ghost.style.top = "0";
      ghost.style.width = `${Math.max(source.offsetWidth, 140)}px`;
      ghost.style.opacity = "1";
      ghost.style.pointerEvents = "none";
      document.body.appendChild(ghost);
      ghostRef.current = ghost;
      event.dataTransfer.setDragImage(ghost, 16, 16);
    }
    onDragStart(person, channelId);
  }

  return (
    <li ref={menu.rootRef} className="relative">
      <ContextMenu items={menuItems}>
        <div
          ref={rowRef}
          role="button"
          tabIndex={0}
          aria-haspopup={hasAudio ? "dialog" : undefined}
          aria-expanded={hasAudio ? menu.open : undefined}
          draggable={canDrag}
          onClick={hasAudio ? menu.toggle : undefined}
          onKeyDown={
            hasAudio
              ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    menu.toggle();
                  }
                }
              : undefined
          }
          data-voice-occupant={person.userId}
          data-voice-occupant-channel={channelId}
          data-voice-occupant-draggable={canDrag ? "true" : "false"}
          aria-label={t("voice.occupant.row", { name: person.displayName })}
          onDragStart={handleDragStart}
          onDragEnd={() => {
            clearGhost();
            onDragEnd();
          }}
          className={cn(
            "group flex min-h-8 w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-paper-muted",
            "hover:bg-ink-3 hover:text-paper",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
            hasAudio && "cursor-pointer",
            canDrag && "cursor-grab active:cursor-grabbing",
            isDragging && "opacity-40",
          )}
        >
          <VoiceAvatar
            name={person.displayName}
            avatarUrl={person.avatarUrl}
            isSpeaking={isSpeaking}
            muted={person.muted || person.deafened}
            size="sm"
          />
          <span className="min-w-0 flex-1 truncate">{person.displayName}</span>
          <VoiceOccupantBadges person={person} />
          {affordance !== "hidden" && (
            <span
              aria-hidden="true"
              data-voice-occupant-audio={affordance}
              title={audioLabel}
              className={cn(
                "shrink-0 transition-opacity duration-150 ease-out motion-reduce:transition-none",
                silenced ? "text-danger" : "text-paper-muted",
                affordance === "always"
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
              )}
            >
              {silenced ? (
                <VolumeX className="h-3 w-3" />
              ) : (
                <Volume2 className="h-3 w-3" />
              )}
            </span>
          )}
        </div>
      </ContextMenu>
      <PeerAudioMenu
        name={person.displayName}
        open={menu.open}
        voice={audio?.voice}
        share={audio?.share}
        side="bottom"
        align="start"
        className="w-[13.5rem]"
      />
    </li>
  );
}
