import { useEffect, useRef, useState } from "react";
import { jt } from "@/lib/i18n/jam-site";
import { intlLocale, type Locale } from "@/lib/locale";
import {
  JAM_SHARE_NETWORKS,
  jamPublicSongLink,
  jamShareNetworkHref,
  type JamShareNetwork,
} from "@/lib/jam-share-link";
import { canShareNatively, copyShareLink, shareNatively } from "@/lib/jam-share-run";
import { jamShareText, type JamShareSong } from "@/lib/jam-share-text";
import { jamAttribution } from "./attribution";
import { Link2Icon as Link2 } from "./icons";
import { buttonClass, focusRing } from "./ui";
import { cn, instrumentName, listOf } from "./util";

/**
 * The song page's Compartilhar.
 *
 * On a phone it hands the song to the system's share sheet (Web Share API, so
 * WhatsApp is one tap), with a message prepared from what the song is missing.
 * Everywhere else it opens this small card: the message, the link (shown, so
 * nobody wonders what was copied), a copy button, and WhatsApp, X and Telegram
 * as plain links. The link is always `jamPublicSongLink` (`lib/jam-share-link.ts`),
 * `ref=share` unless the page was opened with a `ref` already.
 *
 * The site carries no analytics tag (`docs/JAM_SITE.md`, D7), so nothing is
 * counted here: `ref=share` on the link is what the acquisition report reads.
 */

const NETWORK_LABEL: Record<JamShareNetwork, string> = { whatsapp: "WhatsApp", x: "X", telegram: "Telegram" };

/** The prepared message for a song, in the reader's language. */
export function shareMessage(song: JamShareSong, locale: Locale): string {
  return jamShareText(song, {
    say: (kind, vars) => jt(`share.msg.${kind}` as Parameters<typeof jt>[0], vars),
    name: (instrument) => instrumentName(instrument),
    list: (names) => listOf(names, locale),
  });
}

export function songShareLink(songId: string): string {
  return jamPublicSongLink(songId, { attribution: jamAttribution() });
}

/**
 * What the button does when pressed: a native sheet where there is one (true when it
 * took the song or the person dismissed it), otherwise nothing and the caller opens the card.
 */
export async function shareFromButton(song: JamShareSong & { id: string }, locale: Locale): Promise<"done" | "open"> {
  if (!canShareNatively()) {
    return "open";
  }
  const outcome = await shareNatively({
    title: song.title,
    text: shareMessage(song, locale),
    url: songShareLink(song.id),
  });
  return outcome === "failed" ? "open" : "done";
}

export function ShareMenu({
  song,
  locale,
  onClose,
}: {
  song: JamShareSong & { id: string };
  locale: Locale;
  onClose: () => void;
}) {
  const url = songShareLink(song.id);
  const text = shareMessage(song, locale);
  const [copied, setCopied] = useState<"idle" | "yes" | "no">("idle");
  const root = useRef<HTMLDivElement | null>(null);
  const first = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    first.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && root.current && !root.current.contains(target) && !(target as HTMLElement).closest?.("[data-jam-share]")) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={jt("share.sheetTitle")}
      lang={intlLocale(locale)}
      data-jam-share-menu=""
      className="absolute right-0 top-full z-20 mt-2 flex w-[min(21rem,100%)] flex-col gap-3 rounded-[var(--radius-panel)] border border-border bg-surface-1 p-4 shadow-[var(--shadow-2)]"
    >
      <p className="font-display text-lg font-extrabold">{jt("share.sheetTitle")}</p>
      <div className="rounded-[var(--radius-control)] bg-surface-2 px-3 py-2.5">
        <p className="break-words text-sm leading-snug [text-wrap:pretty]">{text}</p>
        <p className="mt-1 select-all break-all text-[13px] leading-snug text-text-secondary" data-jam-share-link="">
          {url}
        </p>
      </div>
      <button
        ref={first}
        type="button"
        data-jam-share-copy=""
        onClick={async () => setCopied((await copyShareLink(url)) ? "yes" : "no")}
        className={cn(buttonClass.base, buttonClass.primary, "h-12 gap-2 px-5 text-base")}
      >
        <Link2 className="h-[18px] w-[18px]" aria-hidden />
        {copied === "yes" ? jt("share.copied") : jt("share.copy")}
      </button>
      <div className="flex flex-wrap gap-2">
        {JAM_SHARE_NETWORKS.map((network) => (
          <a
            key={network}
            href={jamShareNetworkHref(network, text, url)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={jt("share.shareOn", { network: NETWORK_LABEL[network] })}
            data-jam-share-network={network}
            className={cn(
              "inline-flex h-10 items-center rounded-full border border-border-strong bg-surface-2 px-4 text-sm font-semibold hover:bg-surface-3",
              focusRing,
            )}
          >
            {NETWORK_LABEL[network]}
          </a>
        ))}
      </div>
      <p className={copied === "no" ? "text-[13px] font-semibold text-danger" : "sr-only"} role="status" aria-live="polite">
        {copied === "yes" ? jt("share.copied") : copied === "no" ? jt("share.manual", { url }) : ""}
      </p>
    </div>
  );
}
