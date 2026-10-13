import type { ServerEmoji } from "@pqp/shared";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { serverEmojiImageUrl, useServerEmoji } from "@/lib/server-emoji";
import { cn } from "@/lib/utils";

interface CustomEmojiScope {
  serverId: string | null;
  byId: ReadonlyMap<string, ServerEmoji>;
  list: readonly ServerEmoji[];
}

const EMPTY: CustomEmojiScope = { serverId: null, byId: new Map(), list: [] };

const CustomEmojiContext = createContext<CustomEmojiScope>(EMPTY);

/**
 * The server whose emoji a subtree may render. A conversation passes null, and
 * every token in it reads as `:name:`: an emoji belongs to its server.
 */
export function CustomEmojiProvider({
  serverId,
  children,
}: {
  serverId: string | null | undefined;
  children: ReactNode;
}) {
  const list = useServerEmoji(serverId ?? null);
  const value = useMemo<CustomEmojiScope>(() => {
    if (!serverId) {
      return EMPTY;
    }
    const emoji = list?.emoji ?? [];
    return { serverId, list: emoji, byId: new Map(emoji.map((e) => [e.id, e])) };
  }, [serverId, list]);
  return <CustomEmojiContext.Provider value={value}>{children}</CustomEmojiContext.Provider>;
}

export function useCustomEmojiScope(): CustomEmojiScope {
  return useContext(CustomEmojiContext);
}

/**
 * One custom emoji, sized to the line it sits in unless told otherwise. When
 * the picture fails to load (the emoji was deleted since the list was read) it
 * reads as `:name:` text and calls `onBroken` once.
 */
export function CustomEmojiImage({
  emoji,
  className,
  onBroken,
}: {
  emoji: Pick<ServerEmoji, "name" | "url">;
  className?: string;
  onBroken?: () => void;
}) {
  const src = serverEmojiImageUrl(emoji);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) {
    return <>{`:${emoji.name}:`}</>;
  }
  return (
    <img
      src={src}
      alt={`:${emoji.name}:`}
      title={`:${emoji.name}:`}
      draggable={false}
      loading="lazy"
      decoding="async"
      onError={() => {
        setFailedSrc(src);
        onBroken?.();
      }}
      referrerPolicy="no-referrer"
      className={cn(
        "inline-block h-[1.375em] w-[1.375em] object-contain align-[-0.3em]",
        className,
      )}
    />
  );
}
