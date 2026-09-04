import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Menu, Sparkles, X } from "lucide-react";
import { blogMediaMarkdown } from "@/components/blog/blog-markdown";
import { formatPostDate, formatPostShortDate } from "@/lib/blog/format";
import { loadPostBody } from "@/lib/blog/bodies";
import { POSTS, type BlogLocale, type BlogPost } from "@/lib/blog/posts";
import { subscribeEscapeUnlessOverlay } from "@/lib/escape-unless-overlay";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const MARKDOWN_PLUGINS = [remarkGfm];

const MARKDOWN_COMPONENTS: Components = {
  ...blogMediaMarkdown,
  a: ({ href, children, ...rest }) => {
    if (!href) {
      return <a {...rest}>{children}</a>;
    }
    return (
      <a href={href} target="_blank" rel="noreferrer" {...rest}>
        {children}
      </a>
    );
  },
};

interface WhatsNewViewProps {
  mobileOpen: boolean;
  onMobileClose: () => void;
  onMobileOpen: () => void;
  onClose: () => void;
  footer: ReactNode;
}

/**
 * In-app release notes. A reader, not a channel.
 *
 * The notes are the same files as `/blog`. A weekly catch-up, not a per-PR
 * file. There is no composer and no "pqp team" cargo. The rail sparkle
 * opens this; a hall, Home, or Escape puts the app back.
 */
export function WhatsNewView({
  mobileOpen,
  onMobileClose,
  onMobileOpen,
  onClose,
  footer,
}: WhatsNewViewProps) {
  const { t, locale } = useTranslation();
  const blogLocale: BlogLocale = locale === "pt-BR" ? "pt-BR" : "en";
  const [selectedSlug, setSelectedSlug] = useState(
    () => POSTS[0]?.slug ?? "",
  );
  const selected = POSTS.find((post) => post.slug === selectedSlug) ?? POSTS[0];

  useEffect(() => subscribeEscapeUnlessOverlay(onClose), [onClose]);

  function selectPost(slug: string) {
    setSelectedSlug(slug);
    onMobileClose();
  }

  return (
    <>
      <aside
        className={cn(
          "fixed inset-y-0 left-[72px] z-30 flex w-[min(100%-72px,20rem)] flex-col border-r border-ink-4/50 bg-channel transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] md:static md:z-auto md:w-80 md:translate-x-0",
          mobileOpen
            ? "translate-x-0"
            : "-translate-x-[calc(100%+72px)] md:translate-x-0",
        )}
      >
        <div className="flex items-start justify-between gap-3 px-5 pb-4 pt-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-signal text-ink">
                <Sparkles className="h-4 w-4" aria-hidden />
              </span>
              <h1 className="truncate font-display text-lg font-bold tracking-tight">
                {t("whatsNew.feed.title")}
              </h1>
            </div>
            <p className="mt-2 text-pretty text-xs leading-relaxed text-paper-muted">
              {t("whatsNew.feed.lede")}
            </p>
          </div>
          <button
            type="button"
            className="rounded-md p-1.5 text-paper-muted hover:bg-ink-3 hover:text-paper md:hidden"
            aria-label={t("chrome.closeChannelList")}
            onClick={onMobileClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
          aria-label={t("whatsNew.feed.title")}
        >
          {POSTS.length === 0 ? (
            <p className="px-2 py-6 text-sm text-paper-muted">
              {t("whatsNew.feed.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {POSTS.map((post) => {
                const active = post.slug === selected?.slug;
                return (
                  <li key={post.slug}>
                    <button
                      type="button"
                      onClick={() => selectPost(post.slug)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "w-full rounded-xl px-3 py-2.5 text-left transition-colors",
                        active
                          ? "bg-ink-3 text-paper"
                          : "text-paper-muted hover:bg-ink-3/70 hover:text-paper",
                      )}
                    >
                      <time
                        dateTime={post.date}
                        className="block text-[11px] font-medium uppercase tracking-[0.14em] text-paper-muted/80"
                      >
                        {formatPostShortDate(post.date, blogLocale)}
                      </time>
                      <span
                        className={cn(
                          "mt-1 block text-sm leading-snug",
                          active ? "font-semibold text-paper" : "font-medium",
                        )}
                      >
                        {post.title[blogLocale]}
                      </span>
                      <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-paper-muted">
                        {post.summary[blogLocale]}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        {footer}
      </aside>

      <section
        className="relative flex min-w-0 flex-1 flex-col bg-ink"
        aria-labelledby="whats-new-article-title"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(90%_80%_at_50%_-10%,var(--glow-accent)_0%,transparent_70%)]"
        />
        <header className="relative z-10 flex h-14 shrink-0 items-center border-b border-ink-4/40 px-3 md:hidden">
          <button
            type="button"
            className="rounded-md p-1.5 hover:bg-ink-3"
            aria-label={t("chrome.openNav")}
            onClick={onMobileOpen}
          >
            <Menu className="h-5 w-5" />
          </button>
        </header>
        {selected ? (
          <WhatsNewArticle
            key={selected.slug}
            post={selected}
            locale={blogLocale}
          />
        ) : (
          <p className="relative z-10 px-8 py-16 text-sm text-paper-muted">
            {t("whatsNew.feed.empty")}
          </p>
        )}
      </section>
    </>
  );
}

function WhatsNewArticle({
  post,
  locale,
}: {
  post: BlogPost;
  locale: BlogLocale;
}) {
  const { t } = useTranslation();
  const [body, setBody] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setBody(null);
    void loadPostBody(post.slug, locale).then((text) => {
      if (live) {
        setBody(text);
      }
    });
    return () => {
      live = false;
    };
  }, [post.slug, locale]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [post.slug]);

  return (
    <div ref={scroller} className="relative z-10 min-h-0 flex-1 overflow-y-auto">
      <article className="mx-auto w-full max-w-[42rem] px-5 pb-24 pt-8 sm:px-8 sm:pt-14">
        <time
          dateTime={post.date}
          className="text-xs font-medium uppercase tracking-[0.16em] text-paper-muted/70"
        >
          {formatPostDate(post.date, locale)}
        </time>
        <h2
          id="whats-new-article-title"
          className="mt-4 text-balance font-display text-3xl font-bold leading-[1.12] tracking-tight sm:text-4xl"
        >
          {post.title[locale]}
        </h2>
        <p className="mt-4 text-pretty text-lg leading-relaxed text-paper-muted">
          {post.summary[locale]}
        </p>

        <div className="blog-prose mt-10">
          {body === null ? (
            <div className="flex flex-col gap-3" aria-hidden>
              <div className="h-4 w-full rounded bg-paper/10" />
              <div className="h-4 w-11/12 rounded bg-paper/10" />
              <div className="h-4 w-4/6 rounded bg-paper/10" />
            </div>
          ) : (
            <ReactMarkdown
              remarkPlugins={MARKDOWN_PLUGINS}
              components={MARKDOWN_COMPONENTS}
            >
              {body}
            </ReactMarkdown>
          )}
        </div>

        <p className="mt-16 border-t border-ink-4/50 pt-6 text-sm leading-relaxed text-paper-muted">
          {t("whatsNew.feed.origin")}{" "}
          <a
            href={`/blog/${post.slug}`}
            target="_blank"
            rel="noreferrer"
            className="text-signal underline-offset-2 hover:underline"
          >
            {t("whatsNew.feed.onSite")}
          </a>
        </p>
      </article>
    </div>
  );
}
