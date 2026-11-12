import type { JamPublicConsentRequest, JamPublicInboxItem } from "@pqp/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { openPublicJamById } from "@/lib/jam-public-nav";
import { answerConsent, useJamPublicMe, useJamPublicWaiting } from "@/lib/jam-public-store";
import { JamConsentChoices, useConsentAnswer } from "./jam-public-parts";

/**
 * What is waiting for this account on public jams, said where a person is
 * already looking (the Jam wall) and answerable from anywhere (the app's toast).
 *
 * Two questions, both durable on the server (`/consents`, `/inbox`), so none of
 * this depends on a live frame arriving: a song made public with a part of
 * theirs in it, and outside takes on a song they started.
 */

/** Two quiet rows above the wall: only the ones that have something to say. */
export function JamPublicWaitingStrip() {
  const { t } = useTranslation();
  const me = useJamPublicMe();
  const waiting = useJamPublicWaiting();
  const [consentOpen, setConsentOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  if (!me.enabled || (waiting.consents.length === 0 && waiting.inbox.length === 0)) {
    return null;
  }
  const row = "mx-3 mt-3 flex items-center justify-between gap-3 rounded-[var(--radius-card)] bg-surface-1 px-3.5 py-3 text-sm text-text sm:mx-5";
  return (
    <>
      {waiting.consents.length > 0 && (
        <p className={row} role="status" data-jam-waiting="consent">
          <span className="min-w-0">
            {waiting.consents.length === 1
              ? t("jam.public.waiting.consentOne", { title: waiting.consents[0]!.title })
              : t("jam.public.waiting.consents", { count: waiting.consents.length, countLabel: waiting.consents.length })}
          </span>
          <Button size="sm" variant="secondary" className="pointer-coarse:h-11" onClick={() => setConsentOpen(true)} data-jam-waiting-open="consent">
            {t("jam.public.waiting.answer")}
          </Button>
        </p>
      )}
      {waiting.inbox.length > 0 && (
        <p className={row} role="status" data-jam-waiting="inbox">
          <span className="min-w-0">
            {waiting.inbox.length === 1
              ? t("jam.public.waiting.takeOne", { title: waiting.inbox[0]!.songTitle })
              : t("jam.public.waiting.takes", { count: waiting.inbox.length, countLabel: waiting.inbox.length })}
          </span>
          <Button size="sm" variant="secondary" className="pointer-coarse:h-11" onClick={() => setInboxOpen(true)} data-jam-waiting-open="inbox">
            {t("jam.public.waiting.see")}
          </Button>
        </p>
      )}
      <JamConsentDialog open={consentOpen} onClose={() => setConsentOpen(false)} />
      <JamInboxDialog open={inboxOpen} onClose={() => setInboxOpen(false)} />
    </>
  );
}

/** Every song where somebody is waiting for this person's answer, each with the three choices. */
export function JamConsentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { consents } = useJamPublicWaiting();
  const answer = useConsentAnswer(answerConsent);
  // Nothing left to answer: the dialog has done its job.
  useEffect(() => {
    if (open && consents.length === 0) {
      onClose();
    }
  }, [open, consents.length, onClose]);
  return (
    <Dialog
      open={open && consents.length > 0}
      title={t("jam.public.consent.dialogTitle")}
      description={t("jam.public.consent.dialogHint")}
      size="sm"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t("jam.public.sheet.close")}
        </Button>
      }
    >
      <DialogBody>
        <ul className="flex flex-col gap-4" data-jam-consent-list="">
          {consents.map((request) => (
            <ConsentItem key={request.songId} request={request} busy={answer.busy} onChoose={(choice) => void answer.choose(request.songId, choice)} />
          ))}
        </ul>
        {answer.error && (
          <p role="alert" className="mt-3 text-[13px] text-danger">
            {answer.error}
          </p>
        )}
      </DialogBody>
    </Dialog>
  );
}

function ConsentItem({
  request,
  busy,
  onChoose,
}: {
  request: JamPublicConsentRequest;
  busy: boolean;
  onChoose: Parameters<typeof JamConsentChoices>[0]["onChoose"];
}) {
  const { t } = useTranslation();
  const by = request.startedBy.name ?? t("jam.tile.anonymous");
  return (
    <li className="flex flex-col gap-2" data-jam-consent-item={request.songId}>
      <div className="flex flex-col leading-snug">
        <span className="text-sm font-bold text-text">{request.title}</span>
        <span className="text-[13px] text-text-secondary">
          {request.serverName
            ? t("jam.public.consent.byIn", { name: by, server: request.serverName })
            : t("jam.public.consent.by", { name: by })}
          {" · "}
          {t("jam.public.consent.parts", { count: request.parts, countLabel: request.parts })}
        </span>
      </div>
      <JamConsentChoices busy={busy} onChoose={onChoose} />
    </li>
  );
}

/**
 * The starter's outside takes, across their songs. Hearing one and deciding
 * happens in the song itself, with the band playing, so each row opens it.
 */
export function JamInboxDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { inbox } = useJamPublicWaiting();
  useEffect(() => {
    if (open && inbox.length === 0) {
      onClose();
    }
  }, [open, inbox.length, onClose]);
  return (
    <Dialog
      open={open && inbox.length > 0}
      title={t("jam.public.inbox.title")}
      description={t("jam.public.inbox.hint")}
      size="sm"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t("jam.public.sheet.close")}
        </Button>
      }
    >
      <DialogBody>
        <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-card)] bg-surface-2" data-jam-inbox-list="">
          {inbox.map((item) => (
            <InboxRow
              key={item.track.id}
              item={item}
              onOpen={() => {
                onClose();
                openPublicJamById(item.songId);
              }}
            />
          ))}
        </ul>
      </DialogBody>
    </Dialog>
  );
}

function InboxRow({ item, onOpen }: { item: JamPublicInboxItem; onOpen: () => void }) {
  const { t } = useTranslation();
  const look = JAM_INSTRUMENT_LOOK[item.track.instrument];
  return (
    <li className="flex items-center justify-between gap-3 px-3.5 py-2.5" data-jam-inbox-item={item.track.id}>
      <span className="flex min-w-0 flex-col leading-snug">
        <span className="truncate text-sm font-bold text-text">{item.songTitle}</span>
        <span className="truncate text-[13px] text-text-secondary">
          {t(look.nameKey as MessageKey)} · {item.track.authorName ?? t("jam.tile.anonymous")}
        </span>
      </span>
      <Button size="sm" variant="secondary" onClick={onOpen} className="shrink-0">
        {t("jam.public.inbox.open")}
      </Button>
    </li>
  );
}
