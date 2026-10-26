import { useState } from "react";
import { parseBotFaceAvatar, type BotFace as BotFaceName } from "@pqp/shared";
import { BotFace } from "@/components/bots/bot-face";
import { resolveAvatarUrl } from "@/lib/avatar";
import { cn } from "@/lib/utils";

interface UserAvatarProps {
  /** Drawn as an initial when there is no usable picture. */
  name: string;
  /** Whatever the API sent. A null, a junk value or a dead link all fall back. */
  avatarUrl?: string | null;
  /** Sizing and shape. Callers pass the classes their layout already used. */
  className?: string;
  /**
   * Colour and text size of the monogram.
   *
   * A prop rather than one house style because the fallback has to sit on
   * whatever surface the caller drew — the sidebar's `bg-ink-3`, the search
   * menu's `bg-surface-2`, the panel's `bg-signal`. Unifying the *behaviour*
   * was the point of this component; unifying the palette would have been a
   * redesign smuggled in behind a refactor.
   */
  fallbackClassName?: string;
  /** Circle for voice and profile surfaces, rounded square for lists. */
  rounded?: "md" | "lg" | "full";
  /** Muted people are drawn dimmer in the voice roster. */
  dimmed?: boolean;
  /**
   * A server bot's face for this moment (focused while it works, asleep while
   * it is off), drawn over the face its avatar URL names. Ignored for people.
   */
  botFace?: BotFaceName;
  /**
   * Keep the caller's monogram colours under the redesign too. For an avatar
   * drawn inside a story, which paints in the story's own palette, not the
   * app's.
   */
  ownPalette?: boolean;
}

/**
 * One person's picture, with the monogram as its fallback.
 *
 * There used to be seven of these — the member list, the mention autocomplete,
 * the DM stack, the message row, user search, the user panel, the voice
 * roster — each an inline `<img>` with its own idea of what to do when the URL
 * is missing, and none of them with any idea what to do when it is *bad*. That
 * is the whole reason this exists: an avatar is a URL an account holder chose,
 * rendered on everybody else's screen, so "what happens when it fails" is a
 * question every call site was answering differently or not at all.
 *
 * The rules, all in one place:
 *
 *  - the URL is resolved and scheme-checked by `resolveAvatarUrl` — https, or
 *    this API's own path, and nothing else;
 *  - a load failure falls back to the monogram permanently for that URL, rather
 *    than leaving a broken-image icon in a 16rem sidebar. Same treatment
 *    `ChannelIcon` gives a channel image, and for the same reason;
 *  - `referrerPolicy="no-referrer"`, because a typed avatar URL is a credible
 *    tracking pixel aimed at everybody who can see this person, and it should
 *    at least not also learn which page they were on;
 *  - `loading="lazy"`, since a member list is a hundred of these;
 *  - a server bot's avatar is its Breu PNG (`/api/bot-faces/...`), which is
 *    drawn here inline instead, alive, in its own shape rather than cropped.
 */
export function UserAvatar({
  name,
  avatarUrl,
  className = "h-8 w-8",
  fallbackClassName = "bg-signal text-xs text-ink",
  rounded = "md",
  dimmed = false,
  botFace,
  ownPalette = false,
}: UserAvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const bot = parseBotFaceAvatar(avatarUrl);
  if (bot) {
    return (
      <BotFace
        color={bot.color}
        face={botFace ?? bot.face}
        className={cn(className, dimmed && "opacity-50")}
      />
    );
  }
  const resolved = resolveAvatarUrl(avatarUrl);
  const shape =
    rounded === "full"
      ? "rounded-full"
      : rounded === "lg"
        ? "rounded-lg"
        : "rounded-md";
  const dim = dimmed ? "opacity-50" : "";
  // Under the redesign a person is always a circle, whatever the list asked
  // for, and the monogram sits on the same neutral disc everywhere: the
  // caller still sets its size, not its colour. A look that draws its own
  // monogram (Modo 2005's) keeps it, since that rule is plain CSS.
  const circle = "redesign:rounded-full";

  if (resolved && resolved !== failedUrl) {
    return (
      <img
        src={resolved}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(resolved)}
        className={cn("shrink-0 object-cover", shape, className, dim, circle)}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center font-display font-bold",
        shape,
        className,
        fallbackClassName,
        dim,
        circle,
        !ownPalette && "redesign:bg-surface-3 redesign:font-semibold redesign:text-text",
      )}
    >
      {(name.trim().slice(0, 1) || "?").toUpperCase()}
    </span>
  );
}
