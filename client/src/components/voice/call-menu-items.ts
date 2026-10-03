/**
 * The rows of every "⋯" and "Mais" menu on a call and on the watch party
 * player, as plain data.
 *
 * Built here rather than inline in the components so a test can read what a
 * menu offers without opening a Radix menu, which never renders its rows in
 * static markup. A component passes its state in and hands the result to
 * `Menu`; nothing in this file reads React state of its own.
 */
import {
  Bell,
  ChevronDown,
  ChevronUp,
  Crop,
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
  MonitorPlay,
  MousePointer2,
  MousePointerBan,
  PictureInPicture2,
  Pin,
  Scan,
} from "lucide-react";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import type { VideoFitControls } from "@/hooks/use-video-fit";
import type { MessageKey, MessageVars } from "@/lib/i18n";

type Translate = (key: MessageKey, vars?: MessageVars) => string;

/**
 * Fill and whole picture as two choices with a tick on the current one, so
 * the row says both what is set and what the other option is. The scope (every
 * picture of this kind, on this computer) is the second line of the last row,
 * because the choice is remembered for all of them, not for this one tile.
 */
export function fitItems(
  t: Translate,
  fit: VideoFitControls,
  scopeKey: MessageKey,
): ContextMenuItemDef[] {
  return [
    {
      id: "fit-cover",
      label: t("call.fit.fill"),
      icon: Crop,
      checked: fit.fit === "cover",
      onSelect: () => {
        if (fit.fit !== "cover") fit.toggle();
      },
    },
    {
      id: "fit-contain",
      label: t("call.fit.whole"),
      icon: Scan,
      checked: fit.fit === "contain",
      detail: t(scopeKey),
      onSelect: () => {
        if (fit.fit !== "contain") fit.toggle();
      },
    },
  ];
}

function separator(id: string): ContextMenuItemDef {
  return { id, label: "", separator: true };
}

/** The "⋯" on a camera tile in a call. */
export function cameraTileMoreItems(
  t: Translate,
  input: {
    name: string;
    fit?: VideoFitControls;
    pin?: { pinned: boolean; onToggle: () => void };
    /** Not offered on our own tile: hiding yourself is the camera button. */
    hide?: { onHide: () => void };
  },
): ContextMenuItemDef[] {
  const items: ContextMenuItemDef[] = [];
  if (input.fit) {
    items.push(...fitItems(t, input.fit, "call.fit.hintCamera"));
  }
  if (input.pin) {
    items.push({
      id: "pin",
      label: input.pin.pinned
        ? t("call.stage.unpin")
        : t("call.stage.pin", { name: input.name }),
      icon: Pin,
      onSelect: input.pin.onToggle,
    });
  }
  if (input.hide) {
    if (items.length > 0) items.push(separator("hide-separator"));
    items.push({
      id: "hide-camera",
      label: t("call.camera.hide", { name: input.name }),
      icon: EyeOff,
      onSelect: input.hide.onHide,
    });
  }
  return items;
}

/** The "⋯" on a screen share tile in a call. */
export function shareTileMoreItems(
  t: Translate,
  input: {
    name: string;
    isSelf: boolean;
    fit?: VideoFitControls;
    selfPreview?: { hidden: boolean; onToggle: () => void };
    pin?: { pinned: boolean; onToggle: () => void };
    /** Only a peer's share can be declined. */
    dismiss?: { onDismiss: () => void };
  },
): ContextMenuItemDef[] {
  const items: ContextMenuItemDef[] = [];
  if (input.selfPreview) {
    items.push({
      id: "self-preview",
      label: input.selfPreview.hidden
        ? t("voice.share.showPreview")
        : t("voice.share.hidePreview"),
      icon: input.selfPreview.hidden ? Eye : EyeOff,
      onSelect: input.selfPreview.onToggle,
    });
  }
  if (input.fit) {
    items.push(...fitItems(t, input.fit, "call.fit.hintScreen"));
  }
  if (input.pin) {
    items.push({
      id: "pin",
      label: input.pin.pinned
        ? t("call.stage.unpin")
        : t("call.stage.pin", { name: input.name }),
      icon: Pin,
      onSelect: input.pin.onToggle,
    });
  }
  if (input.dismiss && !input.isSelf) {
    if (items.length > 0) items.push(separator("dismiss-separator"));
    items.push({
      id: "dismiss",
      label: t("voice.share.dismiss", { name: input.name }),
      icon: EyeOff,
      onSelect: input.dismiss.onDismiss,
    });
  }
  return items;
}

/** The "⋯" on the watch party player's bar. */
export function watchPlayerMoreItems(
  t: Translate,
  input: {
    fit?: VideoFitControls;
    pip?: { active: boolean; onToggle: () => void };
  },
): ContextMenuItemDef[] {
  const items: ContextMenuItemDef[] = [];
  if (input.fit) {
    items.push(...fitItems(t, input.fit, "voice.hls.fitHint"));
  }
  if (input.pip) {
    items.push({
      id: "pip",
      label: t("voice.hls.pip"),
      icon: PictureInPicture2,
      checked: input.pip.active,
      onSelect: input.pip.onToggle,
    });
  }
  return items;
}

/**
 * The stage bar's "Mais": what a person sets once, starts once, or reaches
 * for rarely. Watch party and the cursor stay listed while sharing, disabled
 * with the reason, so the menu does not change shape under somebody's hand.
 */
export function stageMoreItems(
  t: Translate,
  input: {
    watchParty?: {
      disabledReason: "sharing" | "cap" | null;
      onStart: () => void;
    };
    cursor?: {
      hidden: boolean;
      /** False while sharing on an engine that cannot change a live track. */
      liveChangeable: boolean;
      sharing: boolean;
      onToggle: () => void;
    };
    joinLeaveAutoMute: { on: boolean; onToggle: () => void };
    fullscreen?: { active: boolean; onToggle: () => void };
    collapse?: { collapsed: boolean; onToggle: () => void };
  },
): ContextMenuItemDef[] {
  const items: ContextMenuItemDef[] = [];
  if (input.watchParty) {
    const reason = input.watchParty.disabledReason;
    items.push({
      id: "watch-party",
      label: t("voice.control.watchParty"),
      icon: MonitorPlay,
      disabled: reason !== null,
      detail:
        reason === "sharing" ? t("voice.control.alreadySharing") : undefined,
      onSelect: input.watchParty.onStart,
    });
  }
  if (input.cursor) {
    const locked = input.cursor.sharing && !input.cursor.liveChangeable;
    items.push({
      id: "share-cursor",
      label: input.cursor.hidden
        ? t("voice.control.showCursor")
        : t("voice.control.hideCursor"),
      icon: input.cursor.hidden ? MousePointerBan : MousePointer2,
      disabled: locked,
      detail: locked ? t("voice.control.cursorNextShare") : undefined,
      onSelect: input.cursor.onToggle,
    });
  }
  if (items.length > 0) items.push(separator("share-separator"));
  items.push({
    id: "join-leave-sounds",
    label: t("voice.control.disableJoinLeaveSounds"),
    icon: Bell,
    checked: input.joinLeaveAutoMute.on,
    detail: t("voice.control.joinLeaveAutoMuteDetail"),
    onSelect: input.joinLeaveAutoMute.onToggle,
  });
  if (input.fullscreen) {
    items.push({
      id: "stage-fullscreen",
      label: input.fullscreen.active
        ? t("voice.share.exitFullscreen")
        : t("voice.share.fullscreen"),
      icon: input.fullscreen.active ? Minimize2 : Maximize2,
      onSelect: input.fullscreen.onToggle,
    });
  }
  if (input.collapse) {
    items.push({
      id: "stage-collapse",
      label: input.collapse.collapsed
        ? t("call.stage.expand")
        : t("call.stage.collapse"),
      icon: input.collapse.collapsed ? ChevronDown : ChevronUp,
      onSelect: input.collapse.onToggle,
    });
  }
  return items;
}
