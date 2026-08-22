import { Link } from "react-router-dom";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { POSTS, type BlogLocale } from "@/lib/blog/posts";
import { useTranslation } from "@/lib/i18n";
import { formatPostDate } from "@/lib/blog/format";

/**
 * `/blog`: the release notes, newest first.
 *
 * A CHANGELOG THAT READS LIKE PROSE, not a list of commits. The audience is
 * somebody who already uses pqp and wants to know what changed, so every entry
 * is expected to say what started working, what still does not, and why. The
 * page itself is deliberately plain: no hero, no CTA above the posts, no
 * newsletter box. It is the one surface on the site that is not selling
 * anything, and that is exactly what makes it worth linking to.
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

          <ol className="mt-12 flex flex-col">
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
                  <h2 className="mt-2 text-balance font-display text-xl font-semibold leading-snug sm:text-2xl">
                    {/* The whole card is not a link: a heading link keeps the
                        summary selectable and gives screen readers one target
                        with a real name rather than a paragraph of it. */}
                    <Link
                      to={`/blog/${post.slug}`}
                      className="transition-colors hover:text-signal focus-visible:text-signal"
                    >
                      {post.title[blogLocale]}
                    </Link>
                  </h2>
                  <p className="mt-3 text-pretty leading-relaxed text-paper-muted">
                    {post.summary[blogLocale]}
                  </p>
                </article>
              </li>
            ))}
          </ol>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
