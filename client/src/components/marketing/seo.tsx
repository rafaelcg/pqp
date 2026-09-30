import { useEffect } from "react";
import { useTranslation } from "@/lib/i18n";
import { marketingPageFromMetaPath, marketingUrlsFor } from "@/lib/marketing-meta";

interface SeoProps {
  title: string;
  description: string;
  /** Paste-card title. Falls back to `title` when omitted. */
  ogTitle?: string;
  /** Paste-card description. Falls back to `description` when omitted. */
  ogDescription?: string;
  path?: string;
  noIndex?: boolean;
  /**
   * Site-relative path of the share card. Defaults to the product card; a
   * campaign page with its own art passes it here and in `marketing-meta.ts`,
   * which is what an unfurler actually reads.
   */
  image?: string;
}

const SITE_URL = "https://pqp.gg";



export function Seo({
  title,
  description,
  ogTitle,
  ogDescription,
  path = "/",
  noIndex = false,
  image = "/images/og-image.jpg",
}: SeoProps) {
  const { locale } = useTranslation();
  const socialTitle = ogTitle ?? title;
  const socialDescription = ogDescription ?? description;

  useEffect(() => {
    document.title = title;

    setMeta("description", description);
    setMeta("og:title", socialTitle, "property");
    setMeta("og:description", socialDescription, "property");
    setMeta("og:url", `${SITE_URL}${path}`, "property");
    setMeta("og:type", "website", "property");
    setMeta("og:image", `${SITE_URL}${image}`, "property");
    setMeta("og:site_name", "pqp", "property");
    // SEO i18n: the same URL serves each language by negotiation, and ?lang=
    // is the crawlable way to force one. On the marketing pages the edge
    // (`marketing-meta.ts`) writes a self-referencing canonical per language
    // plus the hreflang set, and this mirrors it from the same function so a
    // client-side render leaves the head the way the edge wrote it. Every
    // other page (profiles, communities, blog) keeps one canonical and the
    // bare-path alternates, as before.
    const marketingPage = marketingPageFromMetaPath(path);
    if (marketingPage) {
      const urls = marketingUrlsFor(marketingPage, locale);
      setLink("canonical", urls.canonical);
      setMeta("og:url", urls.canonical, "property");
      // Recomputed on every route change: a page with no Spanish copy has no
      // `es` alternate, and the one a previous page left in <head> must go.
      const wanted = new Set(urls.alternates.map((alt) => alt.hreflang));
      document.head
        .querySelectorAll("link[rel='alternate'][hreflang]")
        .forEach((el) => {
          if (!wanted.has(el.getAttribute("hreflang") ?? "")) el.remove();
        });
      for (const alt of urls.alternates) {
        setLink("alternate", alt.href, alt.hreflang);
      }
    } else {
      setLink("canonical", `${SITE_URL}${path}`);
      setLink("alternate", `${SITE_URL}${path}`, "x-default");
      setLink("alternate", `${SITE_URL}${path}?lang=pt-BR`, "pt-BR");
      setLink("alternate", `${SITE_URL}${path}?lang=en`, "en");
      setLink("alternate", `${SITE_URL}${path}?lang=es`, "es");
    }
    setMeta("twitter:card", "summary_large_image");
    setMeta("twitter:title", socialTitle);
    setMeta("twitter:description", socialDescription);
    setMeta("twitter:image", `${SITE_URL}${image}`);

    if (noIndex) {
      setMeta("robots", "noindex, nofollow");
    } else {
      setMeta("robots", "index, follow");
    }
  }, [title, description, socialTitle, socialDescription, path, noIndex, image, locale]);

  return null;
}

function setMeta(
  name: string,
  content: string,
  attr: "name" | "property" = "name",
) {
  let el = document.head.querySelector(`meta[${attr}="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setLink(rel: string, href: string, hreflang?: string) {
  // hreflang variants are siblings, not replacements, so they select on both.
  const selector = hreflang
    ? `link[rel="${rel}"][hreflang="${hreflang}"]`
    : `link[rel="${rel}"]:not([hreflang])`;
  let el = document.head.querySelector(selector);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    if (hreflang) {
      el.setAttribute("hreflang", hreflang);
    }
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}
