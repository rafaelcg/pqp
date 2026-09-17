import { Link } from "react-router-dom";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { ARTICLES, articleSummary, articleTitle } from "@/lib/blog/articles";
import { POSTS, type BlogLocale } from "@/lib/blog/posts";
import { useTranslation } from "@/lib/i18n";
import { formatPostDate } from "@/lib/blog/format";

/**
 * `/blog`: two sections, one page.
 *
 * **Guias** are tactical and evergreen — how to watch a film together, how to
 * move a Discord server over — written to answer a question a search engine
 * or an AI answer engine gets asked, not to report what shipped this week.
 * **Notas de versão** are the changelog that reads like prose it always was:
 * somebody who already uses pqp, wanting to know what changed and why,
 * including the parts that are not finished. Guides come first because a
 * first-time visitor from a search result is here for the answer, not the
 * changelog; the page itself stays deliberately plain either way — no hero
 * CTA above either list, no newsletter box.
 */
export function BlogPage() {
  const { t, locale } = useTranslation();
  const blogLocale: BlogLocale = locale === "pt-BR" ? "pt-BR" : "en";

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo
        title={t("blog.seo.title")}
        description={t("blog.seo.description")}
        path="/blog"
      />
      <MarketingNav />

      <main className="relative flex-1">
        <div className="mx-auto max-w-2xl px-5 pb-24 pt-14 sm:px-8 sm:pt-20">
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            {t("blog.hero.title")}
          </h1>
          <p className="mt-4 text-pretty text-base leading-relaxed text-paper-muted">
            {t("blog.hero.lede")}
          </p>

          {ARTICLES.length > 0 && (
            <section className="mt-14" aria-labelledby="blog-guides-heading">
              <h2
                id="blog-guides-heading"
                className="font-display text-xs font-semibold uppercase tracking-[0.14em] text-paper-muted/70"
              >
                {t("blog.guides.heading")}
              </h2>
              <p className="mt-2 text-sm text-paper-muted">
                {t("blog.guides.lede")}
              </p>
              <ol className="mt-6 flex flex-col">
                {ARTICLES.map((article) => (
                  <li
                    key={article.slug}
                    className="border-t border-paper/10 py-8 first:border-t-0 first:pt-0"
                  >
                    <article>
                      <h3 className="text-balance font-display text-xl font-semibold leading-snug sm:text-2xl">
                        <Link
                          to={`/blog/${article.slug}`}
                          className="transition-colors hover:text-signal focus-visible:text-signal"
                        >
                          {articleTitle(article, blogLocale)}
                        </Link>
                      </h3>
                      <p className="mt-3 text-pretty leading-relaxed text-paper-muted">
                        {articleSummary(article, blogLocale)}
                      </p>
                    </article>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="mt-14" aria-labelledby="blog-notes-heading">
            <h2
              id="blog-notes-heading"
              className="font-display text-xs font-semibold uppercase tracking-[0.14em] text-paper-muted/70"
            >
              {t("blog.notes.heading")}
            </h2>
            <p className="mt-2 text-sm text-paper-muted">{t("blog.notes.lede")}</p>
            <ol className="mt-6 flex flex-col">
              {POSTS.map((post) => (
                <li
                  key={post.slug}
                  className="border-t border-paper/10 py-8 first:border-t-0 first:pt-0"
                >
                  <article>
                    <time
                      dateTime={post.date}
                      className="text-xs uppercase tracking-[0.14em] text-paper-muted/70"
                    >
                      {formatPostDate(post.date, blogLocale)}
                    </time>
                    <h3 className="mt-2 text-balance font-display text-xl font-semibold leading-snug sm:text-2xl">
                      {/* The whole card is not a link: a heading link keeps
                          the summary selectable and gives screen readers one
                          target with a real name rather than a paragraph of
                          it. */}
                      <Link
                        to={`/blog/${post.slug}`}
                        className="transition-colors hover:text-signal focus-visible:text-signal"
                      >
                        {post.title[blogLocale]}
                      </Link>
                    </h3>
                    <p className="mt-3 text-pretty leading-relaxed text-paper-muted">
                      {post.summary[blogLocale]}
                    </p>
                  </article>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
