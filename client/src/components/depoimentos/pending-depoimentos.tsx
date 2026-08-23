import { Check, X } from "lucide-react";
import { useState } from "react";
import type { Depoimento } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { depoimentoDate } from "./depoimentos-model";

/**
 * The queue: depoimentos friends have written about you that nobody — not even
 * the person who wrote them — can see until you publish one.
 *
 * It lives in the Pending tab beside friend requests because it is the same
 * errand: somebody is waiting for an answer from you, and both answers are two
 * buttons. Putting it anywhere else would mean a second badge on a second door.
 *
 * THREE THINGS ARE DELIBERATE ABOUT THE ORDER OF WHAT YOU SEE:
 *
 *  - THE AUTHOR IS SHOWN ABOVE THE TEXT. §05's risk note: an ex-friend is the
 *    one person the friends gate cannot exclude, so nobody should be ambushed
 *    by a paragraph from a name they were not ready to read.
 *  - PUBLISHING IS TWO TAPS, over a preview that is literally the rendered text
 *    in the state it will be published in. This is the "Não aceita!" mitigation
 *    and §05 calls it the most important UI decision in the feature.
 *  - REFUSING IS ONE TAP AND IS NOT CONFIRMED. Nothing is lost that the author
 *    cannot rewrite, the author is never told, and the whole safety argument
 *    rests on refusing staying cheap. It is the same asymmetry the friends view
 *    already draws between "decline" and "unfriend".
 */

interface PendingDepoimentosProps {
  depoimentos: Depoimento[];
  busyId: string | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

export function PendingDepoimentos({
  depoimentos,
  busyId,
  onApprove,
  onReject,
}: PendingDepoimentosProps) {
  const { t, locale } = useTranslation();
  /** The one being published, held for its second tap. */
  const [confirming, setConfirming] = useState<string | null>(null);

  if (depoimentos.length === 0) {
    return null;
  }

  return (
    <section
      aria-label={t("depoimentos.pending")}
      data-depoimentos-pending={depoimentos.length}
      className="mb-4"
    >
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-paper-muted">
        {t("depoimentos.pending")}
      </h2>
      <p className="mb-2 text-xs text-paper-muted">
        {t("depoimentos.pending.hint")}
      </p>
      <ul className="max-w-2xl space-y-1.5">
        {depoimentos.map((one) => {
          const busy = busyId === one.id;
          return (
            <li
              key={one.id}
              data-depoimento-pending={one.id}
              className="rounded-md border border-ink-4/60 bg-ink-2/60 p-2.5"
            >
              {/* Name first. See the module note. */}
              <div className="flex items-center gap-2">
                <UserAvatar
                  name={one.author.displayName}
                  avatarUrl={one.author.avatarUrl}
                  rounded="full"
                  className="h-6 w-6"
                  fallbackClassName="bg-ink-3 text-[10px] text-paper"
                />
                <span className="truncate text-sm font-medium text-paper">
                  {one.author.displayName}
                </span>
                <span className="truncate text-[11px] text-paper-muted">
                  {one.author.tag}
                </span>
                <span className="ml-auto shrink-0 text-[11px] text-paper-muted">
                  {depoimentoDate(one, locale)}
                </span>
              </div>

              <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-paper">
                {one.body}
              </p>

              {confirming === one.id ? (
                /* The second tap, over the text exactly as it will appear.
                   The sentence names the consequence — public, on your profile,
                   under your name — rather than asking "are you sure?". */
                <div
                  role="alertdialog"
                  aria-label={t("depoimentos.approve.confirm.title")}
                  data-depoimento-confirm={one.id}
                  className="mt-2 rounded-md border border-ink-4 bg-ink-3/60 p-2"
                >
                  <p className="text-xs font-semibold text-paper">
                    {t("depoimentos.approve.confirm.title")}
                  </p>
                  <p className="mt-1 text-[11px] text-paper-muted">
                    {t("depoimentos.approve.confirm.body", {
                      name: one.author.displayName,
                    })}
                  </p>
                  <div className="mt-2 flex gap-1.5">
                    <Button
                      size="sm"
                      disabled={busy}
                      data-depoimento-approve={one.id}
                      onClick={() => {
                        setConfirming(null);
                        onApprove(one.id);
                      }}
                    >
                      {t("depoimentos.approve.confirm.publish")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirming(null)}
                    >
                      {t("depoimentos.approve.confirm.wait")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex gap-1.5">
                  <Button
                    size="sm"
                    disabled={busy}
                    data-depoimento-publish={one.id}
                    onClick={() => setConfirming(one.id)}
                  >
                    <Check aria-hidden className="h-3.5 w-3.5" />
                    {t("depoimentos.approve")}
                  </Button>
                  {/* One tap, no confirmation, and silent to the author — the
                      row simply stops existing. */}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    data-depoimento-reject={one.id}
                    onClick={() => onReject(one.id)}
                  >
                    <X aria-hidden className="h-3.5 w-3.5" />
                    {t("depoimentos.reject")}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
