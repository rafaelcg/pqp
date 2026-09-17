import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The about paragraph: clamped to a few lines, with a control under it that
 * opens the rest in place.
 *
 * NO MEASURE OF ITS OWN. The paragraph is as wide as the column it sits in,
 * and the caller picks the measure (`max-w-prose` inside the in-app identity
 * band, the poster column on `/c/`). A `40ch` cap used to live here, left over
 * from the research plan, and it made the about a newspaper column occupying
 * under half of a feed whose chips and cards ran the full width. Discord's
 * server profile, an Apple Music artist page and a Material about block all
 * use the content column; so does this.
 *
 * Newlines stay (authors write paragraphs). The clamp is CSS, so the first
 * paint is already right, and the button appears only when the text actually
 * overflows the clamp.
 */
export function CommunityAboutText({
  about,
  lines,
  className,
}: {
  about: string;
  /** 3 in-app, 8 on `/c/`. */
  lines: 3 | 8;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const clampClass = lines === 3 ? "line-clamp-3" : "line-clamp-[8]";

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) {
      return;
    }
    const measure = () => {
      if (open) {
        return;
      }
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [about, open, lines]);

  return (
    <div className={className} data-community-about>
      <p
        ref={textRef}
        className={cn(
          "whitespace-pre-line text-base leading-7 text-text",
          !open && clampClass,
        )}
        data-community-about-open={open ? "1" : "0"}
      >
        {about}
      </p>
      {(overflows || open) && (
        <button
          type="button"
          className="mt-1 inline-flex h-8 items-center rounded-[var(--radius-control)] text-sm font-medium text-accent transition-colors duration-[var(--duration-fast)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          data-community-about-toggle
        >
          {open
            ? t("publicCommunity.about.less")
            : t("publicCommunity.about.more")}
        </button>
      )}
    </div>
  );
}
