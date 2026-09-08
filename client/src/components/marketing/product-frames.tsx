import { Maximize2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Real captures of the running app, in pt-BR, for the landing page.
 *
 * WHY SCREENSHOTS. The previous version drew CSS mockups so they would
 * follow theme and language. Andre asked for the actual product instead:
 * a visitor should see pqp, not a sketch of it. Recapture the files in
 * `public/images/product/` when the UI they show changes. Do not invent
 * a feature in a frame that the product does not ship.
 *
 * Pillar shots open full-viewport on click (same job as `BlogMedia` on
 * `/blog`): a desktop window, shrunk into a column, is unreadable.
 * The alt text is the accessible statement of the same fact.
 */

function ProductShot({
  src,
  altKey,
  width,
  height,
  className,
  priority = false,
  expand = false,
  object = "left",
}: {
  src: string;
  altKey: MessageKey;
  width: number;
  height: number;
  className?: string;
  priority?: boolean;
  expand?: boolean;
  object?: "left" | "top";
}) {
  const { t } = useTranslation();
  const alt = t(altKey);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown, true);
      if (triggerRef.current?.isConnected) {
        triggerRef.current.focus();
      }
    };
  }, [open]);

  const img = (
    <img
      src={src}
      alt={expand ? "" : alt}
      width={width}
      height={height}
      className={cn(
        "block w-full object-cover",
        object === "top" ? "h-full object-top" : "h-auto object-left",
      )}
      decoding="async"
      {...(priority
        ? { fetchPriority: "high" as const }
        : { loading: "lazy" as const })}
    />
  );

  return (
    <>
      <figure
        className={cn(
          "w-full overflow-hidden rounded-2xl border border-white/10 bg-ink-2 shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)]",
          className,
        )}
      >
        {expand ? (
          <button
            ref={triggerRef}
            type="button"
            className={cn(
              "relative block w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 focus-visible:ring-inset",
              object === "top" && "h-full",
            )}
            aria-label={t("landing.shot.expand", { label: alt })}
            onClick={() => setOpen(true)}
          >
            {img}
            <span
              className="pointer-events-none absolute bottom-3 right-3 grid h-8 w-8 place-items-center rounded-lg bg-ink/70 text-paper"
              aria-hidden
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </span>
          </button>
        ) : (
          img
        )}
      </figure>
      {open
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="fixed inset-0 z-[70] flex cursor-zoom-out flex-col bg-ink/92"
              onClick={() => setOpen(false)}
            >
              <button
                ref={closeRef}
                type="button"
                aria-label={t("blog.media.close")}
                className="absolute right-3 top-3 z-[1] rounded-md p-2 text-paper-muted transition-colors hover:bg-ink-3 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 sm:right-5 sm:top-5"
                onClick={() => setOpen(false)}
              >
                <X className="h-5 w-5" />
              </button>
              <div className="flex min-h-0 flex-1 items-center justify-center p-3 sm:p-8">
                <img
                  src={src}
                  alt={alt}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
              <p
                id={titleId}
                className="sr-only"
              >
                {alt}
              </p>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function HeroFrame({ className }: { className?: string }) {
  return (
    <ProductShot
      src="/images/product/hero.webp"
      altKey="landing.shot.hero"
      width={1920}
      height={1080}
      className={cn("mx-auto w-full max-w-5xl", className)}
      priority
      expand
    />
  );
}

export function ScreenFrame({ className }: { className?: string }) {
  return (
    <ProductShot
      src="/images/product/screen.webp"
      altKey="landing.shot.screen"
      width={1920}
      height={1080}
      className={className}
      expand
    />
  );
}

export function ChatFrame({ className }: { className?: string }) {
  return (
    <ProductShot
      src="/images/product/chat.webp"
      altKey="landing.shot.chat"
      width={1920}
      height={1080}
      className={className}
      expand
    />
  );
}

export function ImportFrame({ className }: { className?: string }) {
  return (
    <ProductShot
      src="/images/product/import.webp"
      altKey="landing.shot.import"
      width={1344}
      height={1820}
      className={cn("aspect-[5/4]", className)}
      object="top"
      expand
    />
  );
}

export function RolesFrame({ className }: { className?: string }) {
  return (
    <ProductShot
      src="/images/product/roles.webp"
      altKey="landing.shot.roles"
      width={1792}
      height={2096}
      className={className}
      expand
    />
  );
}

export function VoiceFrame({ className }: { className?: string }) {
  return (
    <ProductShot
      src="/images/product/call.webp"
      altKey="landing.shot.voice"
      width={1920}
      height={1200}
      className={className}
      expand
    />
  );
}
