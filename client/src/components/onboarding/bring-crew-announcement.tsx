import { Check, Copy, Pin, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import {
  ANNOUNCEMENT_LANGS,
  ANNOUNCEMENT_LANG_LABELS,
  announcementUrl,
  defaultAnnouncementLang,
  discordAnnouncement,
  type AnnouncementLang,
} from "@/lib/discord-announcement";
import { useTranslation } from "@/lib/i18n";
import { track } from "@/lib/track";
import { cn } from "@/lib/utils";

const COPY_MS = 1600;

const LANG_OPTIONS = ANNOUNCEMENT_LANGS.map((value) => ({
  value,
  label: ANNOUNCEMENT_LANG_LABELS[value],
}));

/**
 * "Traz tua galera", the last screen of a Discord import with the
 * `discord_bring_crew` flag on: the announcement for the old Discord, in the
 * old server's language, one tap to copy. On a phone, a share sheet too.
 *
 * The text is drawn the way Discord will show it (a quote bar, the bold
 * line bold) rather than in a textarea, so the owner sees what their server
 * will see. What is copied is the raw markdown.
 */
export function BringCrewAnnouncement({
  serverName,
  inviteCode,
  className,
  onCopyFailed,
}: {
  serverName: string;
  inviteCode: string;
  className?: string;
  onCopyFailed?: () => void;
}) {
  const { t, locale } = useTranslation();
  const [lang, setLang] = useState<AnnouncementLang>(() =>
    defaultAnnouncementLang(locale),
  );
  const [copied, setCopied] = useState<"copy" | "share" | null>(null);
  const timer = useRef<number | null>(null);
  const origin =
    typeof window === "undefined" ? "https://pqp.gg" : window.location.origin;
  const text = discordAnnouncement(lang, serverName, announcementUrl(origin, inviteCode));
  const canShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );

  function mark(kind: "copy" | "share") {
    setCopied(kind);
    track("bring_crew_copy", { surface: "dialog", via: kind, lang });
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(() => setCopied(null), COPY_MS);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      mark("copy");
    } catch {
      onCopyFailed?.();
    }
  }

  async function share() {
    try {
      await navigator.share({ text });
      mark("share");
    } catch (error) {
      // A closed sheet is a decision, not a failure.
      if (!(error instanceof Error && error.name === "AbortError")) {
        await copy();
      }
    }
  }

  const [headline, ...rest] = text.split("\n");

  return (
    <section
      data-bring-crew-announcement=""
      aria-labelledby="bring-crew-announcement-title"
      className={cn(
        "animate-pop-in space-y-3 rounded-[var(--radius-card)] border border-border bg-surface-2/40 p-3 [animation-delay:80ms]",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id="bring-crew-announcement-title"
          className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-tertiary redesign:text-[13px] redesign:normal-case redesign:tracking-normal redesign:text-text-secondary"
        >
          {t("bringCrew.announcement.title")}
        </h3>
        <RadioGroup
          value={lang}
          onValueChange={setLang}
          options={LANG_OPTIONS}
          label={t("bringCrew.announcement.language")}
          variant="segmented"
          size="sm"
          fit="content"
        />
      </div>

      <div
        data-bring-crew-text=""
        lang={lang}
        className="rounded-md border-l-4 border-accent bg-surface-1 px-3 py-2 text-sm leading-snug text-text [overflow-wrap:anywhere]"
      >
        <p className="font-semibold">{headline?.replace(/\*\*/g, "")}</p>
        {rest.map((line) => (
          <p key={line} className="mt-1 text-text-secondary">
            {line}
          </p>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          data-bring-crew-copy=""
          className="flex-1"
          onClick={() => void copy()}
        >
          {copied === "copy" ? (
            <Check aria-hidden="true" className="animate-icon-swap h-4 w-4" />
          ) : (
            <Copy aria-hidden="true" className="h-4 w-4" />
          )}
          {copied === "copy"
            ? t("bringCrew.announcement.copied")
            : t("bringCrew.announcement.copy")}
        </Button>
        {canShare && (
          <Button
            type="button"
            variant="secondary"
            data-bring-crew-share=""
            className="flex-1"
            onClick={() => void share()}
          >
            <Share2 aria-hidden="true" className="h-4 w-4" />
            {t("invite.paste.share")}
          </Button>
        )}
      </div>

      <p className="flex items-start gap-1.5 text-xs leading-snug text-text-tertiary">
        <Pin aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t("bringCrew.announcement.pinTip")}
      </p>
    </section>
  );
}
