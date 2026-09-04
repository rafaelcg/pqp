import { Maximize2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "@/lib/i18n";

interface BlogMediaProps {
  src: string;
  alt: string;
  caption?: string;
}

/**
 * A post figure that opens the picture on the whole screen.
 *
 * The column is ~42rem. A desktop screenshot of the app, shrunk to fit,
 * is unreadable. Click (or Enter) puts the same file on the viewport.
 * Escape, the close button, or another click puts it back.
 */
export function BlogMedia({ src, alt, caption }: BlogMediaProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
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

  return (
    <>
      <figure className="blog-media">
        <button
          ref={triggerRef}
          type="button"
          className="blog-media-open"
          aria-label={t("blog.media.expand")}
          onClick={() => setOpen(true)}
        >
          <img src={src} alt={alt} loading="lazy" decoding="async" />
          <span className="blog-media-hint" aria-hidden>
            <Maximize2 className="h-3.5 w-3.5" />
          </span>
        </button>
        {caption ? <figcaption>{caption}</figcaption> : null}
      </figure>
      {open
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={caption ? titleId : undefined}
              aria-label={caption ? undefined : alt || t("blog.media.expand")}
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
              {caption ? (
                <p
                  id={titleId}
                  className="shrink-0 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-center text-sm text-paper-muted"
                >
                  {caption}
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
