import type { JamInstrument } from "@pqp/shared";
import { Check, Copy, Share2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { bidiClean } from "@/lib/bidi";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import {
  JAM_SHARE_NETWORKS,
  jamPublicSongLink,
  jamShareNetworkHref,
  type JamShareNetwork,
  type JamShareTarget,
} from "@/lib/jam-share-link";
import { canShareNatively, copyShareLink, shareNatively } from "@/lib/jam-share-run";
import { jamShareKind, jamShareText, jamStillNeeds, type JamShareKind } from "@/lib/jam-share-text";
import { track } from "@/lib/track";
import { cn } from "@/lib/utils";
import { bandOrder } from "./jam-art";
import { JamCoverPhoto, useJamCover } from "./jam-cover";
import { formatList, useNeedLabel } from "./jam-need";
import { JamGeneratedCover } from "@/lib/jam-generated-cover";

/**
 * "Chama a galera": what a person is offered right after they publish a song or
 * send a part, and from the song's own share button.
 *
 * The song's picture and title, the message that will go out (so nobody has to
 * guess what their friends get), one primary action and a quiet one. Where the
 * browser has the Web Share API (phones) the primary opens the phone's own
 * sheet, so WhatsApp is one tap; where it does not (a desktop) the primary
 * copies the link and WhatsApp, X and Telegram are plain links beside it.
 *
 * What it hands out is always `jamPublicSongLink`: the song's public page, with
 * `ref=share`. The caller only draws this for a song that is really public
 * (`jamShareable`); a private channel song never gets here.
 *
 * Events (`lib/track.ts`, inert without the hosted tag): `jam_share_shown` when
 * it is drawn, `jam_share_tap` with the target of each action.
 */

export interface JamInviteSubject {
  id: string;
  title: string;
  coverUrl?: string | null;
  artist?: string | null;
  joinMode: "open" | "wanted" | "closed";
  wantedInstruments: readonly JamInstrument[];
  instruments: readonly JamInstrument[];
  /**
   * What the person sent that waits for the song's starter. The message says so and does not ask their
   * friends for it (`jamStillNeeds`, `lib/jam-share-text.ts`).
   */
  pending?: readonly JamInstrument[];
}

export type JamInviteSurface = "created" | "sent" | "song";

const NETWORK_LABEL: Record<JamShareNetwork, string> = { whatsapp: "WhatsApp", x: "X", telegram: "Telegram" };

/** The song's share message and link, from what the song is missing. */
export function useJamInviteMessage(subject: JamInviteSubject) {
  const { t, locale } = useTranslation();
  const url = useMemo(() => jamPublicSongLink(subject.id), [subject.id]);
  const pending = subject.pending ?? [];
  const needs = jamStillNeeds(subject, pending);
  const kind = jamShareKind({ joinMode: subject.joinMode, needs });
  const title = bidiClean(subject.title);
  const text = jamShareText(
    { title, joinMode: subject.joinMode, needs, pending },
    {
      say: (which, vars) =>
        t(`jam.invite.${vars.pending ? "textSent" : "text"}.${which}` as MessageKey, {
          title: vars.title,
          list: vars.list,
          count: vars.count,
          mine: vars.mine,
        }),
      name: (instrument) =>
        t(JAM_INSTRUMENT_LOOK[instrument as JamInstrument].nameKey as MessageKey).toLocaleLowerCase(locale),
      list: (names) => formatList(names, locale),
    },
  );
  return { url, text, title, kind, needs };
}

/** Run one share action and report what the person should be told. */
function useShareActions(url: string, text: string, title: string, surface: JamInviteSurface, kind: JamShareKind) {
  const [state, setState] = useState<"idle" | "shared" | "copied" | "copyFailed">("idle");
  const tap = useCallback(
    (target: JamShareTarget) => track("jam_share_tap", { target, surface, kind }),
    [surface, kind],
  );
  const copy = useCallback(
    async (target: "copy" | "native" = "copy") => {
      if (target === "copy") {
        tap("copy");
      }
      setState((await copyShareLink(url)) ? "copied" : "copyFailed");
    },
    [url, tap],
  );
  const share = useCallback(async () => {
    tap("native");
    const outcome = await shareNatively({ title, text, url });
    if (outcome === "shared") {
      setState("shared");
    } else if (outcome === "failed" || outcome === "unavailable") {
      // The sheet could not open: the link still has to leave, so it is copied and said so.
      await copy("native");
    }
  }, [tap, title, text, url, copy]);
  return { state, tap, copy, share };
}

function SongLine({ subject, kind, needs }: { subject: JamInviteSubject; kind: JamShareKind; needs: readonly string[] }) {
  const { t } = useTranslation();
  const needLabel = useNeedLabel();
  const cover = useJamCover(subject.coverUrl ?? null);
  const band = bandOrder(subject.instruments.length > 0 ? subject.instruments : subject.wantedInstruments);
  const sub =
    kind === "needs"
      ? needLabel({ kind: "missing", instruments: needs as JamInstrument[] })
      : subject.artist
        ? bidiClean(subject.artist)
        : t("jam.original");
  return (
    <div className="flex items-center gap-3" data-jam-invite-song="">
      <span aria-hidden="true" className="relative h-14 w-14 shrink-0 overflow-hidden rounded-[var(--radius-control)] bg-surface-2">
        {cover.src !== null && cover.status !== "failed" ? (
          <JamCoverPhoto cover={cover} eager />
        ) : (
          <JamGeneratedCover songId={subject.id} instruments={band} />
        )}
      </span>
      <span className="min-w-0">
        <span className="block break-words text-base font-extrabold leading-tight text-text [text-wrap:balance]" data-jam-invite-title="">
          {bidiClean(subject.title)}
        </span>
        <span className="block truncate text-sm text-text-secondary first-letter:uppercase">{sub}</span>
      </span>
    </div>
  );
}

export function JamInviteCard({
  subject,
  surface,
  className,
  heading = true,
}: {
  subject: JamInviteSubject;
  surface: JamInviteSurface;
  className?: string;
  /** Draw the card's own title (a dialog already has one). */
  heading?: boolean;
}) {
  const { t } = useTranslation();
  const { url, text, title, kind, needs } = useJamInviteMessage(subject);
  const native = canShareNatively();
  const { state, tap, copy, share } = useShareActions(url, text, title, surface, kind);

  const shown = useRef(false);
  useEffect(() => {
    if (!shown.current) {
      shown.current = true;
      track("jam_share_shown", { surface, kind, native });
    }
  }, [surface, kind, native]);

  const status =
    state === "copied" ? t("jam.invite.copied") : state === "shared" ? t("jam.invite.shared") : state === "copyFailed" ? t("jam.invite.copyFailed") : "";

  return (
    <section
      aria-label={t("jam.invite.title")}
      data-jam-invite=""
      data-surface={surface}
      data-kind={kind}
      className={cn(
        "jam-invite-in flex w-full flex-col gap-3 rounded-[var(--radius-panel)] border border-border bg-surface-1 p-4 text-left",
        className,
      )}
    >
      {heading ? (
        <div>
          <h3 className="font-display text-xl font-extrabold text-text">{t("jam.invite.title")}</h3>
          <p className="mt-0.5 text-[13px] text-text-secondary [text-wrap:pretty]">{t("jam.invite.hint")}</p>
        </div>
      ) : (
        <p className="text-[13px] text-text-secondary [text-wrap:pretty]">{t("jam.invite.hint")}</p>
      )}
      <SongLine subject={subject} kind={kind} needs={needs} />
      <figure className="m-0 rounded-[var(--radius-control)] bg-surface-2 px-3 py-2.5" data-jam-invite-message="">
        <figcaption className="sr-only">{t("jam.invite.message")}</figcaption>
        <p className="break-words text-sm leading-snug text-text [text-wrap:pretty]">{text}</p>
        <p className="mt-1 select-all break-all text-[13px] leading-snug text-text-secondary" data-jam-invite-link="" aria-label={t("jam.invite.linkLabel")}>
          {url}
        </p>
      </figure>

      {native ? (
        <>
          <Button className="h-12 gap-2 rounded-full text-base" onClick={() => void share()} data-jam-invite-share="">
            <Share2 className="h-[18px] w-[18px]" aria-hidden />
            {t("jam.invite.share")}
          </Button>
          <Button variant="secondary" className="h-11 gap-2 rounded-full" onClick={() => void copy()} data-jam-invite-copy="">
            {state === "copied" ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            {state === "copied" ? t("jam.invite.copied") : t("jam.invite.copy")}
          </Button>
        </>
      ) : (
        <>
          <Button className="h-12 gap-2 rounded-full text-base" onClick={() => void copy()} data-jam-invite-copy="">
            {state === "copied" ? <Check className="h-[18px] w-[18px]" aria-hidden /> : <Copy className="h-[18px] w-[18px]" aria-hidden />}
            {state === "copied" ? t("jam.invite.copied") : t("jam.invite.copy")}
          </Button>
          <div className="flex flex-col gap-2" data-jam-invite-networks="">
            <p className="text-[13px] font-semibold text-text-secondary">{t("jam.invite.networks")}</p>
            <div className="flex flex-wrap gap-2">
              {JAM_SHARE_NETWORKS.map((network) => (
                <a
                  key={network}
                  href={jamShareNetworkHref(network, text, url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t("jam.invite.shareOn", { network: NETWORK_LABEL[network] })}
                  data-jam-invite-network={network}
                  onClick={() => tap(network)}
                  className="inline-flex h-10 items-center rounded-full border border-border-strong bg-surface-2 px-4 text-sm font-semibold text-text outline-none hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {NETWORK_LABEL[network]}
                </a>
              ))}
            </div>
          </div>
        </>
      )}
      {/* The button already says "Link copiado"; this line is for a screen reader, and for the one case that needs words. */}
      <p
        className={state === "copyFailed" ? "text-[13px] font-semibold text-danger" : "sr-only"}
        role="status"
        aria-live="polite"
        data-jam-invite-status=""
      >
        {status}
      </p>
    </section>
  );
}

/** The same card in a dialog, for the song's own share button on a desktop (a phone goes straight to its share sheet). */
export function JamInviteDialog({
  open,
  onClose,
  subject,
}: {
  open: boolean;
  onClose: () => void;
  subject: JamInviteSubject;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} title={t("jam.invite.title")} size="sm" onClose={onClose}>
      <div className="px-5 py-4">
        {open && <JamInviteCard subject={subject} surface="song" heading={false} className="border-0 bg-transparent p-0" />}
      </div>
    </Dialog>
  );
}

/**
 * What the song's share button does. A phone shows its own share sheet at once
 * (no card in between: one tap to WhatsApp); a desktop opens the card.
 * Returns the handler and the dialog to render.
 */
export function useJamInviteButton(subject: JamInviteSubject | null) {
  const [open, setOpen] = useState(false);
  const message = useJamInviteMessage(
    subject ?? { id: "", title: "", joinMode: "closed", wantedInstruments: [], instruments: [] },
  );
  const onPress = useCallback(async () => {
    if (!subject) {
      return;
    }
    if (canShareNatively()) {
      track("jam_share_tap", { target: "native", surface: "song", kind: message.kind });
      const outcome = await shareNatively({ title: message.title, text: message.text, url: message.url });
      if (outcome === "failed") {
        setOpen(true);
      }
      return;
    }
    setOpen(true);
  }, [subject, message.kind, message.title, message.text, message.url]);
  const dialog = subject ? <JamInviteDialog open={open} onClose={() => setOpen(false)} subject={subject} /> : null;
  return { onPress, dialog };
}
