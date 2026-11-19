import { useEffect, useRef, useState } from "react";
import { Check, Hash, PencilSimple, UserPlus } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useTranslation } from "@/lib/i18n";

/** What the start of a server text channel needs to say about itself. */
export interface ChannelIntroInfo {
  name: string;
  topic: string | null;
  /** Copies an invite link; absent without CREATE_INVITE. */
  onCopyInvite?: () => Promise<void>;
  /** Opens the channel's settings; absent without MANAGE_CHANNELS. */
  onEdit?: () => void;
}

/**
 * The top of a server text channel under the redesign (the text channels
 * canvas, "Canal de texto" and "Canal novo"). Above the first message once
 * there is no older page, it greets with the topic and two small buttons.
 * In an empty channel it takes the whole log, with starter cards. With the
 * toggle off the list never renders this.
 */
export function ChannelIntro({ info, empty }: { info: ChannelIntroInfo; empty: boolean }) {
  const { t } = useTranslation();
  const invite = useCopyState(info.onCopyInvite);
  const inviteLabel = invite.state === "copied" ? t("chat.intro.copied") : t("chat.intro.invite");
  const InviteIcon = invite.state === "copied" ? Check : UserPlus;

  return (
    <section
      data-channel-intro={empty ? "empty" : "start"}
      aria-label={t("chat.intro.title", { name: info.name })}
      className={
        empty
          ? "mt-auto flex max-w-[49.5rem] flex-col gap-2 pb-8 pl-[4.5rem] pr-4 pt-6 max-sm:pl-4"
          : "flex max-w-[49.5rem] flex-col gap-2 pb-4 pl-[4.5rem] pr-4 pt-6 max-sm:pl-4"
      }
    >
      <h2 className="m-0 font-display text-[28px] font-extrabold leading-8 text-text">
        {t("chat.intro.title", { name: info.name })}
      </h2>
      <p className="text-[15px] leading-[22px] text-text-secondary">
        {empty
          ? t("chat.intro.empty")
          : info.topic
            ? t("chat.intro.startTopic", { topic: info.topic })
            : t("chat.intro.start")}
      </p>
      {empty ? (
        (invite.run || info.onEdit) && (
          <div className="mt-4 grid max-w-[40rem] grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
            {invite.run && (
              <StarterCard
                icon={InviteIcon}
                title={inviteLabel}
                detail={invite.state === "failed" ? t("chat.empty.owner.failed") : t("chat.intro.inviteDetail")}
                onClick={invite.run}
                data-channel-intro-invite=""
              />
            )}
            {info.onEdit && !info.topic && (
              <StarterCard
                icon={PencilSimple}
                title={t("chat.intro.topic")}
                detail={t("chat.intro.topicDetail")}
                onClick={info.onEdit}
                data-channel-intro-topic=""
              />
            )}
          </div>
        )
      ) : (
        (invite.run || info.onEdit) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {invite.run && (
              <Button variant="secondary" size="sm" onClick={invite.run} data-channel-intro-invite="">
                <Icon icon={InviteIcon} size="sm" className="h-3.5 w-3.5" />
                {inviteLabel}
              </Button>
            )}
            {info.onEdit && (
              <Button variant="secondary" size="sm" onClick={info.onEdit} data-channel-intro-edit="">
                <Icon icon={PencilSimple} size="sm" className="h-3.5 w-3.5" />
                {t("chat.intro.edit")}
              </Button>
            )}
          </div>
        )
      )}
    </section>
  );
}

function StarterCard({
  icon,
  title,
  detail,
  onClick,
  ...rest
}: {
  icon: typeof Hash;
  title: string;
  detail: string;
  onClick: () => void;
  "data-channel-intro-invite"?: string;
  "data-channel-intro-topic"?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...rest}
      className="flex flex-col items-start gap-1 rounded-xl bg-surface-1 p-3 text-left ring-1 ring-inset ring-border hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="mb-1 grid h-8 w-8 place-items-center rounded-lg bg-surface-2 text-text-secondary">
        <Icon icon={icon} size="sm" className="h-[1.125rem] w-[1.125rem]" />
      </span>
      <span className="text-sm font-semibold leading-5 text-text">{title}</span>
      <span className="text-xs leading-4 text-text-tertiary">{detail}</span>
    </button>
  );
}

/** Copy, then "Copiado" for a moment; a failure says so in the detail line. */
function useCopyState(copy: (() => Promise<void>) | undefined) {
  const [state, setState] = useState<"idle" | "busy" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );
  if (!copy) {
    return { state, run: undefined };
  }
  const run = () => {
    if (state === "busy") {
      return;
    }
    setState("busy");
    copy()
      .then(() => setState("copied"))
      .catch(() => setState("failed"))
      .finally(() => {
        if (timer.current !== null) {
          window.clearTimeout(timer.current);
        }
        timer.current = window.setTimeout(() => setState("idle"), 1600);
      });
  };
  return { state, run };
}
