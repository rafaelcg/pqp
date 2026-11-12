import type { JamPublication, JamPublicationPart } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { JamPublicationState } from "@/hooks/use-jam-publication";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { useEffect, useState } from "react";

/**
 * Making a song public, and looking after it afterwards. One sheet, two states.
 *
 * Not published: says plainly what becomes public (the sound, the picture when
 * a person allows it, their names) and what does not (anything without a yes),
 * and asks only the one thing that is the starter's to decide, whether the
 * server it came from is shown. Published: who has answered, the server
 * switch, what is waiting, and the way back.
 *
 * Quiet on purpose: text, one switch, two buttons. Nothing here celebrates.
 */

export interface JamPublicSheetProps {
  open: boolean;
  onClose: () => void;
  songTitle: string;
  /** The server the song came from (a channel song), or null for a standalone one. */
  originName: string | null;
  state: JamPublicationState;
  /** Where the song lives on the open web, for the "Abrir" link. */
  publicUrl: string;
}

/** Anything the starter can republish: never published, or taken down by them. An operator's removal is final here. */
function isOn(publication: JamPublication | null): boolean {
  return publication !== null && (publication.status === "live" || publication.status === "review" || publication.status === "hidden");
}

export function JamPublicSheet({ open, onClose, songTitle, originName, state, publicUrl }: JamPublicSheetProps) {
  const { t } = useTranslation();
  const { publication, busy, error } = state;
  const on = isOn(publication);
  const removed = publication?.status === "removed";
  // The choice made before publishing; once published it is the stored one.
  const [showOriginDraft, setShowOriginDraft] = useState(true);
  useEffect(() => {
    if (open) {
      setShowOriginDraft(publication?.showOrigin ?? true);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- a fresh draft each time it opens

  const hasOrigin = originName !== null && (publication?.hasOrigin ?? true);

  async function publish() {
    const done = await state.publish(hasOrigin ? showOriginDraft : undefined);
    if (done) {
      void state.refresh();
    }
  }

  const errorText = error ? t(`jam.public.error.${error}` as MessageKey) : null;

  if (!on) {
    return (
      <Dialog
        open={open}
        title={t("jam.public.sheet.title")}
        description={songTitle}
        size="sm"
        onClose={onClose}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t("jam.public.sheet.cancel")}
            </Button>
            {!removed && (
              <Button onClick={() => void publish()} disabled={busy} data-jam-public-go="">
                {t("jam.public.sheet.go")}
              </Button>
            )}
          </div>
        }
      >
        <DialogBody>
          <div className="flex flex-col gap-4 text-sm leading-snug text-text-secondary" data-jam-public-sheet="off">
            {removed ? (
              <p role="status">
                {t("jam.public.sheet.removed")}
                {publication?.removedReason ? ` ${publication.removedReason}` : ""}
              </p>
            ) : (
              <>
                <p className="text-text">{t("jam.public.sheet.lead")}</p>
                <ul className="flex flex-col gap-1.5 pl-4 [&>li]:list-disc [&>li]:marker:text-text-tertiary">
                  <li>{t("jam.public.sheet.audio")}</li>
                  <li>{t("jam.public.sheet.video")}</li>
                  <li>{t("jam.public.sheet.names")}</li>
                </ul>
                <p>{t("jam.public.sheet.consent")}</p>
                {hasOrigin && (
                  <div className="rounded-[var(--radius-card)] bg-surface-2 px-3.5 py-1">
                    <Switch
                      checked={showOriginDraft}
                      onCheckedChange={setShowOriginDraft}
                      label={t("jam.public.sheet.showOrigin")}
                      description={t("jam.public.sheet.showOriginHint", { name: originName })}
                    />
                  </div>
                )}
                <p>{t("jam.public.sheet.undo")}</p>
              </>
            )}
            {errorText && (
              <p role="alert" className="text-danger">
                {errorText}
              </p>
            )}
          </div>
        </DialogBody>
      </Dialog>
    );
  }

  const pub = publication!;
  const answered = pub.parts.filter((part) => part.consent !== "pending").length;
  return (
    <Dialog
      open={open}
      title={t("jam.public.manage.title")}
      description={songTitle}
      size="sm"
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button variant="ghost" className="text-danger" onClick={() => void state.unpublish()} disabled={busy} data-jam-public-off="">
            {t("jam.public.manage.unpublish")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t("jam.public.sheet.close")}
          </Button>
        </div>
      }
    >
      <DialogBody>
        <div className="flex flex-col gap-4 text-sm leading-snug text-text-secondary" data-jam-public-sheet="on">
          <p role="status" className="text-text" data-jam-public-status={pub.status}>
            {t(`jam.public.status.${pub.status}` as MessageKey)}
          </p>
          {pub.status === "live" && !pub.listed && <p>{t("jam.public.manage.notListed")}</p>}
          {pub.status === "live" && pub.listed && (
            <a
              href={publicUrl}
              target="_blank"
              rel="noreferrer"
              className="w-fit font-semibold text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {t("jam.public.manage.open")}
            </a>
          )}

          {pub.parts.length > 0 && (
            <section aria-labelledby="jam-public-parts" className="flex flex-col gap-1.5">
              <h3 id="jam-public-parts" className="flex items-baseline justify-between text-xs font-bold uppercase tracking-wide text-text-tertiary">
                <span>{t("jam.public.manage.parts")}</span>
                <span className="font-semibold normal-case tracking-normal">
                  {t("jam.public.manage.answered", { done: answered, total: pub.parts.length })}
                </span>
              </h3>
              <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-card)] bg-surface-2">
                {pub.parts.map((part) => (
                  <PartRow key={part.trackId} part={part} />
                ))}
              </ul>
            </section>
          )}

          {pub.pendingTakes > 0 && (
            <p data-jam-public-pending-takes="">
              {t("jam.public.manage.pendingTakes", { count: pub.pendingTakes, countLabel: pub.pendingTakes })}
            </p>
          )}

          {pub.hasOrigin && originName !== null && (
            <div className="rounded-[var(--radius-card)] bg-surface-2 px-3.5 py-1">
              <Switch
                checked={pub.showOrigin}
                busy={busy}
                onCheckedChange={(next) => void state.setShowOrigin(next)}
                label={t("jam.public.sheet.showOrigin")}
                description={t("jam.public.sheet.showOriginHint", { name: originName })}
              />
            </div>
          )}

          {pub.plays > 0 && (
            <p className="text-[13px]" data-jam-public-numbers="">
              {t("jam.public.plays", { count: pub.plays, countLabel: pub.plays })}
              {pub.likes > 1 && ` · ${t("jam.public.likes", { count: pub.likes, countLabel: pub.likes })}`}
            </p>
          )}
          {errorText && (
            <p role="alert" className="text-danger">
              {errorText}
            </p>
          )}
        </div>
      </DialogBody>
    </Dialog>
  );
}

function PartRow({ part }: { part: JamPublicationPart }) {
  const { t } = useTranslation();
  const look = JAM_INSTRUMENT_LOOK[part.instrument];
  return (
    <li className="flex items-center justify-between gap-3 px-3.5 py-2.5" data-jam-public-part={part.consent}>
      <span className="min-w-0 truncate text-text">
        <span className="font-semibold">{t(look.nameKey as MessageKey)}</span>
        <span className="text-text-secondary"> · {part.authorName ?? t("jam.tile.anonymous")}</span>
      </span>
      <span className="shrink-0 text-[13px] font-semibold text-text-secondary">
        {t(`jam.public.consent.state.${part.consent}` as MessageKey)}
      </span>
    </li>
  );
}
