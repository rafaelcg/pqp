import { useEffect } from "react";

interface SeoProps {
  title: string;
  description: string;
  path?: string;
  noIndex?: boolean;
}

const SITE_URL = "https://pqp.gg";

export function Seo({ title, description, path = "/", noIndex = false }: SeoProps) {
  useEffect(() => {
    document.title = title;

    setMeta("description", description);
    setMeta("og:title", title, "property");
    setMeta("og:description", description, "property");
    setMeta("og:url", `${SITE_URL}${path}`, "property");
    setMeta("og:type", "website", "property");
    setMeta("og:image", `${SITE_URL}/images/og-image.jpg`, "property");
    setMeta("og:site_name", "pqp", "property");
    setMeta("twitter:card", "summary_large_image");
    setMeta("twitter:title", title);
    setMeta("twitter:description", description);
    setMeta("twitter:image", `${SITE_URL}/images/og-image.jpg`);
    setLink("canonical", `${SITE_URL}${path}`);

    if (noIndex) {
      setMeta("robots", "noindex, nofollow");
    } else {
      setMeta("robots", "index, follow");
    }
  }, [title, description, path, noIndex]);

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

function setLink(rel: string, href: string) {
  let el = document.head.querySelector(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}
