import { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Link, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { formatPostDate } from "@/lib/blog/format";
import { loadPostBody } from "@/lib/blog/bodies";
import { postBySlug, type BlogLocale } from "@/lib/blog/posts";
import { useTranslation } from "@/lib/i18n";

/**
 * `/blog/<slug>`: one release note.
 *
 * THE BODY IS FETCHED, NOT BUNDLED. Posts accumulate forever and the landing
 * page's download budget does not, so each one is a dynamic import resolved
 * when its route mounts. That is also why the head still comes from the edge:
 * the crawler that matters never waits for this fetch.
 *
 * The prose is authored markdown from this repository, not user input, so
 * unlike `message-list` it does not run behind an element allowlist. What it
 * does keep is `remark-gfm` for tables and strikethrough, and deliberately NOT
 * `remark-breaks`: a lone newline in a chat message means a line break, in a
 * paragraph of prose it means the author wrapped the file.
 */
const MARKDOWN_PLUGINS = [remarkGfm];

/**
 * A markdown link to one of our own pages should not cost a full document
 * load. Posts now link into `/tela`, and without this the reader leaves the
 * SPA and comes back through a cold boot. Everything else (http, mailto, an
 * in-page `#anchor`) is left exactly as authored.
 */
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children, ...rest }) =>
    href?.startsWith("/") ? (
      <Link to={href} {...rest}>
        {children}
      </Link>
    ) : (
      <a href={href} {...rest}>
        {children}
      </a>
    ),
};

export function BlogPostPage() {
  const { slug } = useParams<{ slug: string }>();
  const { t, locale } = useTranslation();
  const blogLocale: BlogLocale = locale === "pt-BR" ? "pt-BR" : "en";
  const post = slug ? postBySlug(slug) : null;
  const [body, setBody] = useState<string | null>(null);

  useEffect(() => {
    if (!post) {
      return;
    }
    let live = true;
    setBody(null);
    void loadPostBody(post.slug, blogLocale).then((text) => {
      if (live) {
        setBody(text);
      }
    });
    // Cancels on unmount and on a language switch mid-load, so a slow fetch of
    // the Portuguese body cannot land after the reader has moved to English.
    return () => {
      live = false;
    };
  }, [post, blogLocale]);

  if (!post) {
    return (
      <div className="flex min-h-full flex-col bg-ink text-paper">
        <Seo
          title={t("blog.notFound.title")}
          description={t("blog.notFound.body")}
          path="/blog"
          noIndex
        />
        <MarketingNav />
        <main className="flex-1">
          <div className="mx-auto max-w-2xl px-5 py-24 sm:px-8">
            <h1 className="font-display text-2xl font-bold sm:text-3xl">
              {t("blog.notFound.title")}
            </h1>
            <p className="mt-4 leading-relaxed text-paper-muted">
              {t("blog.notFound.body")}
            </p>
            <Link
              to="/blog"
              className="mt-8 inline-block text-signal hover:underline"
            >
              {t("blog.back")}
            </Link>
          </div>
        </main>
        <MarketingFooter />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo
        title={`${post.title[blogLocale]} — pqp`}
        description={post.summary[blogLocale]}
        path={`/blog/${post.slug}`}
      />
      <MarketingNav />

      <main className="relative flex-1">
        <article className="mx-auto max-w-2xl px-5 pb-24 pt-14 sm:px-8 sm:pt-20">
          <Link
            to="/blog"
            className="text-xs uppercase tracking-[0.14em] text-paper-muted/70 transition-colors hover:text-signal"
          >
            {t("blog.back")}
          </Link>

          <h1 className="mt-6 text-balance font-display text-3xl font-bold leading-[1.15] tracking-tight sm:text-4xl">
            {post.title[blogLocale]}
          </h1>
          <time
            dateTime={post.date}
            className="mt-4 block text-sm text-paper-muted/80"
          >
            {formatPostDate(post.date, blogLocale)}
          </time>

          <div className="blog-prose mt-10">
            {body === null ? (
              // A skeleton rather than a spinner: the shape is known, and the
              // fetch is a same-origin chunk that usually beats a spinner's
              // own fade-in.
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
        </article>
      </main>

      <MarketingFooter />
    </div>
  );
}
