import { Check, ExternalLink, Link2, Share2 } from "lucide-react";
import { forwardRef, useCallback, useEffect, useMemo, useState } from "react";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { Menu } from "@/components/ui/menu";
import { useMediaQuery } from "@/components/ui/use-media-query";
import {
  BAU_SHARE_NETWORKS,
  copyShareLink,
  shareNatively,
  shareNetworkHref,
  type BauShareNetwork,
} from "@/lib/community-home/public-share";
import { track } from "@/lib/track";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Compartilhar on a public Baú post, on the card in the app and on the public
 * page itself.
 *
 * ONE CONTROL, TWO SHAPES. A phone gets the OS share sheet (`navigator.share`):
 * it already holds every app the person actually posts to, and it is what a
 * thumb expects. A desktop browser gets a menu of the networks the product
 * cares about (copy link, X, Reddit, WhatsApp, Telegram), because the desktop
 * sheet, where it exists at all, holds none of them. A sheet that fails for any
 * reason but being dismissed falls back to copying the link, so the button is
 * never a dead end.
 *
 * It renders only when the API handed the client a `publicUrl`: that field is
 * present exactly while the post has a page that answers, so this component has
 * no rule of its own about which posts qualify and cannot disagree with the
 * server about it.
 */

const NETWORK_LABEL: Record<BauShareNetwork, MessageKey> = {
  x: "bauShare.x",
  reddit: "bauShare.reddit",
  whatsapp: "bauShare.whatsapp",
  telegram: "bauShare.telegram",
};

export interface BauShareButtonProps {
  /** `post.publicUrl`, from the API. */
  publicUrl: string;
  /** The post's title, or a line of its body: the words that travel with the link. */
  title: string;
  /** Where the button sits, for the analytics line. */
  surface: "card" | "page";
  className?: string;
}

const ShareTrigger = forwardRef<
  HTMLButtonElement,
  {
    className?: string;
    copied: boolean;
    label: string;
    surface: "card" | "page";
  } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function ShareTrigger({ className, copied, label, surface, ...rest }, ref) {
  const Icon = copied ? Check : Share2;
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={cn(
        "inline-flex items-center gap-1.5 transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
        surface === "page"
          ? "h-12 rounded-full border border-ink-4 px-5 text-sm font-medium text-paper hover:border-signal/50"
          : // The footer stays as compact as the like button beside it, but the
            // tap area is 44px tall (the pseudo-element reaches 10px past the
            // button above and below, and 4px to each side): a thumb target
            // the design guideline asks for, without a taller card.
              "relative rounded-md px-2 py-1 text-xs text-paper-muted hover:bg-ink-4 hover:text-paper after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-['']",
        copied && "text-success",
        className,
      )}
      data-bau-share={surface}
    >
      <Icon aria-hidden className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );
});

export function BauShareButton({
  publicUrl,
  title,
  surface,
  className,
}: BauShareButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  // Reactive, so a tablet docked to a keyboard moves to the menu as it goes.
  const touch = useMediaQuery("(pointer: coarse)", false);
  const canNativeShare =
    touch && typeof navigator !== "undefined" && typeof navigator.share === "function";

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async () => {
    const ok = await copyShareLink(publicUrl);
    if (ok) {
      setCopied(true);
    }
    track("bau_share", { surface, via: "copy", ok });
  }, [publicUrl, surface]);

  const items = useMemo<ContextMenuItemDef[]>(
    () => [
      {
        id: "copy",
        label: t("bauShare.copyLink"),
        icon: Link2,
        onSelect: () => void copy(),
      },
      { id: "sep", label: "", separator: true },
      ...BAU_SHARE_NETWORKS.map((network) => ({
        id: network,
        label: t(NETWORK_LABEL[network]),
        icon: ExternalLink,
        onSelect: () => {
          track("bau_share", { surface, via: network });
          window.open(
            shareNetworkHref(network, publicUrl, title),
            "_blank",
            "noopener,noreferrer",
          );
        },
      })),
    ],
    [copy, publicUrl, surface, t, title],
  );

  const label = copied ? t("bauShare.copied") : t("bauShare.button");

  if (canNativeShare) {
    return (
      <ShareTrigger
        className={className}
        copied={copied}
        label={label}
        surface={surface}
        aria-label={t("bauShare.aria")}
        onClick={() => {
          void shareNatively(publicUrl, title).then((result) => {
            track("bau_share", { surface, via: "native", result });
            if (result === "failed") {
              void copy();
            }
          });
        }}
      />
    );
  }

  return (
    <Menu items={items} align="end" side="top">
      <ShareTrigger
        className={className}
        copied={copied}
        label={label}
        surface={surface}
        aria-label={t("bauShare.aria")}
      />
    </Menu>
  );
}
