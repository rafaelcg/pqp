import type { CommunityLink } from "@pqp/shared";
import { ExternalLink, Heart, Lock } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { SettingsCopyButton } from "@/components/settings/kit/copy-button";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";

/**
 * What a locked Baú post says where it used to show a disabled "VIP, em breve".
 *
 * OPTION A: pqp NEVER TOUCHES THE MONEY. The button opens the creator's OWN
 * support link (LivePix, Apoia.se, Patreon, a Pix key...) and the VIP cargo is
 * granted by hand by whoever runs the server afterwards, which is why the card
 * ends by saying so. Nothing here sells anything, checks a payment or unlocks
 * on its own.
 *
 * WHAT IT PROMISES IS WHAT THE CLIENT KNOWS: the supporter-only posts. A person
 * who cannot see a VIP-only voice or watch-party room cannot be told a server
 * has one (the channel list hides what they may not view and nothing else says
 * so), so rooms are not mentioned until the API says them.
 *
 * TWO SHAPES OF SUPPORT LINK. A page opens in a new tab with
 * `rel="noopener noreferrer"`. A Pix key or copia e cola is TEXT: the button
 * opens a small panel under it with the text and a copy button, and the text
 * is only ever rendered as text, never an href, never fetched.
 *
 * Without a support link the button is absent and the card only says who to
 * ask.
 */
export function VipUnlockCard({
  support,
  onView,
  onSupportClick,
}: {
  support: CommunityLink | null;
  /** The card was drawn with a support link on it. Once per mount. */
  onView?: () => void;
  /** The support button was pressed (page opened, or Pix panel opened). */
  onSupportClick?: () => void;
}) {
  const { t } = useTranslation();
  const hasSupport = Boolean(support && (support.url || support.pix));

  // A view is one render of a card WITH something to press, reported once.
  const viewed = useRef(false);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  useEffect(() => {
    if (hasSupport && !viewed.current) {
      viewed.current = true;
      onViewRef.current?.();
    }
  }, [hasSupport]);

  return (
    <div
      className="mt-4 rounded-[var(--radius-control)] border border-border bg-surface-1 p-3"
      data-home-unlock-cta
      data-home-unlock-support={hasSupport ? "1" : "0"}
    >
      <p className="flex items-start gap-2 text-sm leading-6 text-text">
        <Lock
          aria-hidden
          className="mt-1 h-3.5 w-3.5 shrink-0 text-text-tertiary"
        />
        <span>{t("communityHome.vip.what")}</span>
      </p>
      {support?.url ? (
        <div className="mt-3">
          <Button asChild variant="default" size="sm" className="gap-1.5">
            <a
              href={support.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => onSupportClick?.()}
              data-home-support-cta
            >
              <Heart aria-hidden className="h-3.5 w-3.5" />
              {t("communityHome.vip.support")}
              <ExternalLink aria-hidden className="h-3 w-3 opacity-70" />
              <span className="sr-only">{t("communityHome.vip.opensNewTab")}</span>
            </a>
          </Button>
        </div>
      ) : support?.pix ? (
        <PixSupport pix={support.pix} onOpen={onSupportClick} />
      ) : null}
      <p
        className="mt-3 text-xs leading-5 text-text-tertiary"
        data-home-unlock-after
      >
        {hasSupport
          ? t("communityHome.vip.afterSupport")
          : t("communityHome.vip.askStaff")}
      </p>
    </div>
  );
}

/**
 * The Pix variant: a disclosure button and the panel it controls. Escape closes
 * it and puts focus back on the button, so a keyboard user is never stranded.
 */
function PixSupport({
  pix,
  onOpen,
}: {
  pix: string;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLElement>(null);

  return (
    <div
      className="mt-3"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <Button
        ref={buttonRef}
        type="button"
        variant="default"
        size="sm"
        className="gap-1.5"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (!open) {
            onOpen?.();
          }
          setOpen(!open);
        }}
        data-home-support-cta
      >
        <Heart aria-hidden className="h-3.5 w-3.5" />
        {t("communityHome.vip.support")}
      </Button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label={t("communityHome.vip.pixTitle")}
          className="chat-swap-in mt-2 rounded-[var(--radius-control)] border border-border bg-surface-0 p-3"
          data-home-support-pix
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
            {t("communityHome.vip.pixTitle")}
          </p>
          {/* Text, in a code element: React escapes it and nothing links it. */}
          <code
            ref={textRef}
            className="mt-1.5 block max-h-28 select-all overflow-y-auto break-all rounded-sm bg-surface-1 px-2 py-1.5 text-xs leading-5 text-text"
            data-home-support-pix-text
          >
            {pix}
          </code>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <SettingsCopyButton
              text={pix}
              label={t("communityHome.vip.pixCopy")}
              copiedLabel={t("communityHome.vip.pixCopied")}
              showLabel
              selectOnFail={() => textRef.current}
            />
            <span className="text-xs text-text-tertiary">
              {t("communityHome.vip.pixHelp")}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
