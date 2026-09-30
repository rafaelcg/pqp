import { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Link, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { blogMediaMarkdown } from "@/components/blog/blog-markdown";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { formatPostDate } from "@/lib/blog/format";
import { loadPostBody } from "@/lib/blog/bodies";
import {
  blogLocaleFor,
  blogReadLocaleFor,
  postBySlug,
  postLocale,
  postSummary,
  postTitle,
} from "@/lib/blog/posts";
import { loadArticleBody } from "@/lib/blog/article-bodies";
import {
  articleBySlug,
  articleFaq,
  articleSummary,
  articleTitle,
} from "@/lib/blog/articles";
import { useTranslation } from "@/lib/i18n";

/**
 * `/blog/<slug>`: one release note, or one guide.
 *
 * THE BODY IS FETCHED, NOT BUNDLED. Posts and guides accumulate forever and
 * the landing page's download budget does not, so each one is a dynamic
 * import resolved when its route mounts. That is also why the head still
 * comes from the edge: the crawler that matters never waits for this fetch.
 *
 * A SLUG NAMES EITHER A POST OR A GUIDE, NEVER BOTH — `articles.test.ts` pins
 * that the two lists never share one. Release notes are looked up first, same
 * order `blogTargetFromMetaPath` uses at the edge, so the two halves of this
 * feature can never disagree about what a slug means.
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
  ...blogMediaMarkdown,
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
  const blogLocale = blogLocaleFor(locale);
  const readLocale = blogReadLocaleFor(locale);
  const post = slug ? postBySlug(slug) : null;
  const article = !post && slug ? articleBySlug(slug) : null;
  const [body, setBody] = useState<string | null>(null);

  useEffect(() => {
    if (!post && !article) {
      return;
    }
    let live = true;
    setBody(null);
    const load = post
      ? loadPostBody(post.slug, readLocale)
      : loadArticleBody(article!.slug, blogLocale);
    void load.then((text) => {
      if (live) {
        setBody(text);
      }
    });
    // Cancels on unmount and on a language switch mid-load, so a slow fetch of
    // the Portuguese body cannot land after the reader has moved to English.
    return () => {
      live = false;
    };
  }, [post, article, blogLocale, readLocale]);

  if (!post && !article) {
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

  const title = post
    ? postTitle(post, readLocale)
    : articleTitle(article!, blogLocale);
  const summary = post
    ? postSummary(post, readLocale)
    : articleSummary(article!, blogLocale);
  const faq = article ? articleFaq(article, blogLocale) : [];

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo
        title={`${title} · pqp`}
        description={summary}
        path={`/blog/${post ? post.slug : article!.slug}`}
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
            {title}
          </h1>
          {post ? (
            <time
              dateTime={post.date}
              className="mt-4 block text-sm text-paper-muted/80"
            >
              {formatPostDate(post.date, postLocale(post, readLocale))}
            </time>
          ) : (
            <time
              dateTime={article!.updated}
              className="mt-4 block text-sm text-paper-muted/80"
            >
              {t("blog.article.updated", {
                date: formatPostDate(article!.updated, blogLocale),
              })}
            </time>
          )}

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

          {faq.length > 0 && (
            // Rendered, not just schema: `blog/articles.ts` requires every
            // JSON-LD question to appear here, asked the same way, so this is
            // the copy that FAQPage structured data describes rather than a
            // second, drifting source of truth.
            <section className="mt-14" aria-labelledby="blog-article-faq">
              <h2
                id="blog-article-faq"
                className="font-display text-xl font-semibold sm:text-2xl"
              >
                {t("blog.article.faqHeading")}
              </h2>
              <dl className="mt-6 flex flex-col gap-6">
                {faq.map((item) => (
                  <div key={item.question}>
                    <dt className="font-medium text-paper">{item.question}</dt>
                    <dd className="mt-2 leading-relaxed text-paper-muted">
                      {item.answer}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </article>
      </main>

      <MarketingFooter />
    </div>
  );
}
