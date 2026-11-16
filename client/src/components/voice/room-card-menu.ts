import {
  Copy,
  Hand,
  Mic,
  MicOff,
  PhoneOff,
  UserMinus,
  UserRound,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import type { MessageKey } from "@/lib/i18n";
import { voiceOccupantMenuActions } from "@/lib/voice-occupant-dnd";

/**
 * THE RIGHT-CLICK MENU OF A PERSON ON THE CALL STAGE (a room card).
 *
 * The sidebar row under a voice channel has had this menu for a long time
 * (`menuForOccupant` in `channel-list.tsx`) and the stage, where the room is
 * actually looked at, had none: a moderator who saw somebody misbehaving on a
 * card had to find the same person in the small sidebar list to mute or
 * disconnect them. This builds the same items for a card.
 *
 * It asks the same question of the same function, `voiceOccupantMenuActions`,
 * so who is offered what cannot drift from the sidebar, and it reuses the
 * sidebar's ids and copy keys. The permission answers come from the app
 * (`StageOccupantModeration`, filled with the callbacks the channel list
 * already gets), never from a second permission fetch here.
 */
export interface StageOccupantModeration {
  /** `MUTE_MEMBERS` in this channel. Also gates "Abaixar a mão". */
  canServerMute: boolean;
  /** `MOVE_MEMBERS` in this channel. */
  canDisconnect: boolean;
  /** The kick ladder: may this account remove that person? */
  canKick: (userId: string) => boolean;
  onServerMute: (userId: string, muted: boolean) => void;
  onDisconnect: (userId: string) => void;
  onKick: (userId: string, name: string) => void;
}

export interface RoomCardMenuInput {
  t: (key: MessageKey) => string;
  userId?: string;
  name: string;
  isSelf: boolean;
  serverMuted: boolean;
  /** Their place in the queue of raised hands. Set while the hand is up. */
  handRaised: boolean;
  /**
   * Their voice volume, 0 to 1, and the setter. Absent where nothing is being
   * received from them, which also leaves "Mutar pra você" off the menu.
   */
  volume?: number;
  onSetVolume?: (volume: number) => void;
  moderation?: StageOccupantModeration;
  onLowerHand?: (userId: string) => void;
  /**
   * Audience mode, only for somebody who runs the stage: `allow` for a person
   * in the audience, `silence` for one the host already let in.
   */
  audience?: {
    action: "allow" | "silence" | null;
    onSet: (userId: string, allowed: boolean) => void;
  };
  openProfile: () => void;
}

export function roomCardMenuItems(input: RoomCardMenuInput): ContextMenuItemDef[] {
  const { t } = input;
  const { userId, moderation } = input;
  // Everything that acts on an account needs the account's id.
  const actions = voiceOccupantMenuActions({
    isSelf: input.isSelf,
    inSameCall: input.onSetVolume !== undefined,
    mutedForMe: input.volume === 0,
    canServerMute: Boolean(userId && moderation?.canServerMute),
    serverMuted: input.serverMuted,
    handRaised: input.handRaised,
    audience: userId ? (input.audience?.action ?? null) : null,
    canDisconnect: Boolean(userId && moderation?.canDisconnect),
    canKick: Boolean(userId && moderation?.canKick(userId)),
  }).filter((action) => action !== "profile" || userId !== undefined);

  const profile: ContextMenuItemDef[] = [];
  const personal: ContextMenuItemDef[] = [];
  const mod: ContextMenuItemDef[] = [];
  const copy: ContextMenuItemDef[] = [];
  for (const action of actions) {
    if (action === "profile") {
      profile.push({
        id: "profile",
        label: t("voice.occupant.profile"),
        icon: UserRound,
        onSelect: input.openProfile,
      });
    } else if (action === "muteForMe") {
      personal.push({
        id: "mute-for-me",
        label: t("voice.occupant.muteForMe"),
        icon: VolumeX,
        onSelect: () => input.onSetVolume?.(0),
      });
    } else if (action === "unmuteForMe") {
      personal.push({
        id: "unmute-for-me",
        label: t("voice.occupant.unmuteForMe"),
        icon: Volume2,
        onSelect: () => input.onSetVolume?.(1),
      });
    } else if (action === "lowerHand" && userId) {
      personal.push({
        id: "lower-hand",
        label: t("voice.occupant.lowerHand"),
        icon: Hand,
        onSelect: () => input.onLowerHand?.(userId),
      });
    } else if (action === "audienceAllow" && userId) {
      personal.push({
        id: "audience-allow",
        label: t("voice.audience.allow"),
        icon: Mic,
        onSelect: () => input.audience?.onSet(userId, true),
      });
    } else if (action === "audienceSilence" && userId) {
      personal.push({
        id: "audience-silence",
        label: t("voice.audience.silence"),
        icon: MicOff,
        onSelect: () => input.audience?.onSet(userId, false),
      });
    } else if (action === "serverMute" && userId) {
      personal.push({
        id: "server-mute",
        label: t("voice.occupant.serverMute"),
        icon: MicOff,
        onSelect: () => moderation?.onServerMute(userId, true),
      });
    } else if (action === "serverUnmute" && userId) {
      personal.push({
        id: "server-unmute",
        label: t("voice.occupant.serverUnmute"),
        icon: Mic,
        onSelect: () => moderation?.onServerMute(userId, false),
      });
    } else if (action === "disconnect" && userId) {
      mod.push({
        id: "disconnect",
        label: t("voice.occupant.disconnect"),
        icon: PhoneOff,
        danger: true,
        onSelect: () => moderation?.onDisconnect(userId),
      });
    } else if (action === "kick" && userId) {
      mod.push({
        id: "kick",
        label: t("voice.occupant.kick"),
        icon: UserMinus,
        danger: true,
        onSelect: () => moderation?.onKick(userId, input.name),
      });
    } else if (action === "copyName") {
      copy.push({
        id: "copy-name",
        label: t("voice.occupant.copyName"),
        icon: Copy,
        onSelect: () => void navigator.clipboard?.writeText(input.name),
      });
    }
  }
  const items: ContextMenuItemDef[] = [];
  const groups = [profile, personal, mod, copy].filter(
    (group) => group.length > 0,
  );
  for (const [index, group] of groups.entries()) {
    if (index > 0) {
      items.push({ id: `sep-${index}`, label: "", separator: true });
    }
    items.push(...group);
  }
  return items;
}
