import { useEffect } from "react";

/**
 * The document head, kept right in the browser. The edge writes the head a
 * crawler or an unfurler reads (`lib/jam-meta.ts`); this keeps the tab title,
 * the description and `noindex` right once the page has loaded and as the
 * visitor moves between the home and a song.
 */
export interface JamHead {
  title: string;
  description?: string;
  noindex?: boolean;
  canonical?: string;
}

function meta(attr: "name" | "property", key: string): HTMLMetaElement {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attr, key);
    document.head.appendChild(element);
  }
  return element;
}

export function applyHead(head: JamHead): void {
  document.title = head.title;
  meta("property", "og:title").content = head.title;
  meta("name", "twitter:title").content = head.title;
  if (head.description) {
    meta("name", "description").content = head.description;
    meta("property", "og:description").content = head.description;
    meta("name", "twitter:description").content = head.description;
  }
  const robots = meta("name", "robots");
  robots.content = head.noindex ? "noindex, nofollow" : "index, follow";
  let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (head.canonical) {
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    canonical.href = head.canonical;
  } else if (canonical) {
    canonical.remove();
  }
}

export function useHead(head: JamHead): void {
  const { title, description, noindex, canonical } = head;
  useEffect(() => {
    applyHead({ title, description, noindex, canonical });
  }, [title, description, noindex, canonical]);
}
