import { useRef, type DragEvent } from "react";
import type { VoiceParticipant } from "@pqp/shared";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { VoiceAvatar } from "@/components/voice/voice-avatar";
import { useTranslation } from "@/lib/i18n";
import { VOICE_OCCUPANT_DRAG_MIME } from "@/lib/voice-occupant-dnd";
import { cn } from "@/lib/utils";
import { VoiceOccupantBadges } from "./voice-occupant-badges";

/**
 * One seated person under a voice channel. Draggable when Discord would allow
 * it (yourself, or someone else if you have Move Members). Right-click and
 * the context-menu key / Shift+F10 open the same menu.
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
  onDragStart,
  onDragEnd,
}: {
  person: VoiceParticipant;
  channelId: string;
  isSpeaking: boolean;
  canDrag: boolean;
  isDragging?: boolean;
  items: ContextMenuItemDef[];
  onDragStart: (person: VoiceParticipant, channelId: string) => void;
  onDragEnd: () => void;
}) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLElement | null>(null);

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
    <li>
      <ContextMenu items={items}>
        <div
          ref={rowRef}
          role="button"
          tabIndex={0}
          draggable={canDrag}
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
            "flex min-h-8 w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-paper-muted",
            "hover:bg-ink-3 hover:text-paper",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
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
        </div>
      </ContextMenu>
    </li>
  );
}
