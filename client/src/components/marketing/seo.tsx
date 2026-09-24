import { useEffect } from "react";

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
    // SEO i18n: the same URL serves both languages by negotiation, and ?lang=
    // is the crawlable way to force each. hreflang tells engines the pairing,
    // x-default that the bare URL negotiates. One canonical, so the lang
    // variants are alternates rather than duplicate-content competitors.
    setLink("canonical", `${SITE_URL}${path}`);
    setLink("alternate", `${SITE_URL}${path}`, "x-default");
    setLink("alternate", `${SITE_URL}${path}?lang=pt-BR`, "pt-BR");
    setLink("alternate", `${SITE_URL}${path}?lang=en`, "en");
    setLink("alternate", `${SITE_URL}${path}?lang=es`, "es");
    setMeta("twitter:card", "summary_large_image");
    setMeta("twitter:title", socialTitle);
    setMeta("twitter:description", socialDescription);
    setMeta("twitter:image", `${SITE_URL}${image}`);
    setLink("canonical", `${SITE_URL}${path}`);

    if (noIndex) {
      setMeta("robots", "noindex, nofollow");
    } else {
      setMeta("robots", "index, follow");
    }
  }, [title, description, socialTitle, socialDescription, path, noIndex, image]);

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
