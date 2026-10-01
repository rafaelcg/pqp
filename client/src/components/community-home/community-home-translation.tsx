import type {
  CommunityHomePostTranslationRow,
  CommunityHomeTranslationLang,
} from "@pqp/shared";
import { Languages } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchCommunityHomeTranslations } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The two small surfaces of Baú's automatic translation.
 *
 * Reader: one quiet line under a translated post that says so and flips that
 * one post back to the author's words and again. It is the same single line,
 * the same height, in both states, so toggling moves nothing but the text
 * above it.
 *
 * Staff: a note in the composer that readers in other languages see a
 * translation, and a read-only look at what each language was given. No
 * editing: a translation is made again by editing the post.
 */

export function TranslationNote({
  showingOriginal,
  onToggle,
}: {
  showingOriginal: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <p
      className="mt-3 flex min-h-5 flex-wrap items-center gap-x-1.5 text-xs text-text-tertiary"
      data-home-translation-note
      data-home-translation-state={showingOriginal ? "original" : "translated"}
    >
      <Languages className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        {showingOriginal
          ? t("communityHome.translation.showingOriginal")
          : t("communityHome.translation.auto")}
      </span>
      <span aria-hidden>·</span>
      <button
        type="button"
        className="rounded-sm text-text-secondary underline-offset-2 hover:text-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        aria-pressed={showingOriginal}
        onClick={onToggle}
        data-home-translation-toggle
      >
        {showingOriginal
          ? t("communityHome.translation.seeTranslation")
          : t("communityHome.translation.seeOriginal")}
      </button>
    </p>
  );
}

const LANGUAGE_NAME_KEY: Record<CommunityHomeTranslationLang, MessageKey> = {
  en: "settings.appearance.language.en",
  pt: "settings.appearance.language.ptBR",
  es: "settings.appearance.language.es",
};

function TranslationRows({
  serverId,
  postId,
}: {
  serverId: string;
  postId: string;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<CommunityHomePostTranslationRow[] | null>(
    null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setRows(null);
    setFailed(false);
    fetchCommunityHomeTranslations(serverId, postId)
      .then((res) => {
        if (live) {
          setRows(res.translations);
        }
      })
      .catch(() => {
        if (live) {
          setFailed(true);
        }
      });
    return () => {
      live = false;
    };
  }, [serverId, postId]);

  if (failed) {
    return (
      <p className="text-xs text-text-tertiary">
        {t("communityHome.translation.staffFailed")}
      </p>
    );
  }
  if (rows === null) {
    return (
      <p className="text-xs text-text-tertiary">{t("common.loading")}</p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="text-xs text-text-tertiary">
        {t("communityHome.translation.staffEmpty")}
      </p>
    );
  }
  return (
    <ul className="space-y-3" data-home-translation-rows>
      {rows.map((row) => (
        <li
          key={row.lang}
          className="rounded-lg border border-border bg-surface-1 p-3"
          data-home-translation-row={row.lang}
        >
          <p className="mb-1 flex flex-wrap items-center gap-x-2 text-xs font-semibold text-text-secondary">
            <span>{t(LANGUAGE_NAME_KEY[row.lang])}</span>
            {row.stale && (
              <span className="font-normal text-warning">
                {t("communityHome.translation.staffStale")}
              </span>
            )}
          </p>
          {row.sameLanguage ? (
            <p className="text-xs text-text-tertiary">
              {t("communityHome.translation.staffSame")}
            </p>
          ) : (
            <>
              {row.title && (
                <p className="break-words text-sm font-semibold text-text">
                  {row.title}
                </p>
              )}
              {row.body && (
                <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-text-secondary">
                  {row.body}
                </p>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Under the composer. `enabled` is what the API said about this server (the
 * flag is on and a key is configured): off, this renders nothing at all, so a
 * self-host or a server that was left out never sees a promise it cannot keep.
 * The per-language look is offered for a post that already exists.
 */
export function ComposeTranslationNote({
  enabled,
  serverId,
  postId,
  className,
}: {
  enabled: boolean;
  serverId: string;
  postId: string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!enabled) {
    return null;
  }
  return (
    <div className={cn("mb-2 text-xs text-text-tertiary", className)} data-home-compose-translation>
      <p className="flex flex-wrap items-center gap-x-1.5">
        <Languages className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t("communityHome.translation.staffNote")}</span>
        {postId && (
          <button
            type="button"
            className="rounded-sm text-text-secondary underline-offset-2 hover:text-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            data-home-compose-translation-toggle
          >
            {open
              ? t("communityHome.translation.staffHide")
              : t("communityHome.translation.staffSee")}
          </button>
        )}
      </p>
      {open && postId && (
        <div className="mt-2">
          <TranslationRows serverId={serverId} postId={postId} />
        </div>
      )}
    </div>
  );
}
