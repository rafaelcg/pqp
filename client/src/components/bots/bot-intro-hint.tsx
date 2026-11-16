import { parseBotFaceAvatar } from "@pqp/shared";
import { useMemo, useState } from "react";
import { BotFace } from "@/components/bots/bot-face";
import { CornerCard } from "@/components/layout/corner-card";
import { BOT_BETA_TAG_REDESIGN } from "@/components/bots/server-bot-tags";
import { BetaTag } from "@/components/ui/beta-tag";
import { Button } from "@/components/ui/button";
import type { ChatMessage } from "@/hooks/use-chat";
import { isHintSeen, rememberHint } from "@/lib/hints";
import { useTranslation } from "@/lib/i18n";

/**
 * "Conheça o Tico": the first time a member is in a channel where the server's
 * bot has spoken, a card above the composer says what it is, how to call it,
 * that it is in beta, and what it reads. Once per server per device. "Dizer
 * oi" puts its @handle in the composer; nothing is sent for them.
 */
export function BotIntroHint({
  serverId,
  messages,
  members,
  onSayHi,
}: {
  serverId: string;
  messages: readonly ChatMessage[];
  /** The roster, to know the bot is still here and its handle. */
  members: ReadonlyArray<{ id: string; avatarUrl?: string | null; username?: string | null; isCharacter?: boolean }>;
  onSayHi: (username: string) => void;
}) {
  const { t } = useTranslation();
  const key = `pqp:bot-intro-${serverId}`;
  const [closed, setClosed] = useState(() => isHintSeen(key));

  const bot = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      const face = parseBotFaceAvatar(message.authorAvatarUrl);
      if (!face) continue;
      const member = members.find((person) => person.id === message.authorId);
      if (!member?.username) continue;
      return { name: message.authorName, username: member.username, ...face };
    }
    return null;
  }, [messages, members]);

  if (closed || !bot) return null;

  const close = () => {
    rememberHint(key);
    setClosed(true);
  };

  return (
    // Out of the flow: the card floats over the conversation, never pushing
    // the composer it sits on down the screen.
    <div className="pointer-events-none relative h-0 [&>*]:pointer-events-auto">
      <div className="absolute bottom-2 left-4 right-4 flex justify-center">
        <CornerCard
          open
          onClose={close}
          layout="inline"
          label={t("bots.introHint.label", { name: bot.name })}
          dismissLabel={t("bots.introHint.later")}
          dataAttribute="bot-intro"
          title={
            <span className="flex items-center gap-2">
              <BotFace color={bot.color} face="oi" className="h-7 w-7" />
              {t("bots.introHint.title", { name: bot.name })}
              <BetaTag className={BOT_BETA_TAG_REDESIGN} />
            </span>
          }
          body={t("bots.introHint.body", { handle: `@${bot.username}` })}
          footer={
            <div className="flex w-full flex-wrap justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={close}>
                {t("bots.introHint.later")}
              </Button>
              <Button
                type="button"
                size="sm"
                data-cta
                onClick={() => {
                  onSayHi(bot.username);
                  close();
                }}
              >
                {t("bots.introHint.sayHi")}
              </Button>
            </div>
          }
        />
      </div>
    </div>
  );
}
