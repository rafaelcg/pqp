/**
 * Fingerprints an English legal section so a translation can say which version
 * of it it was written against.
 *
 * Imported only by `documents.test.ts` — it is never referenced from app code,
 * so nothing here reaches the bundle.
 *
 * The fingerprint is taken over the *rendered* section rather than its source
 * text, which makes it insensitive to the things that should not invalidate a
 * translation (Prettier reflowing a paragraph, a `{" "}` moving to the end of
 * the previous line, JSX indentation) and sensitive to the only thing that
 * should: what the section says. Markup is included, so turning a sentence into
 * a link or wrapping a phrase in `<strong>` also counts as a change — it is a
 * change to the document, and the Portuguese should get the same treatment.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { LegalSection } from "./document";

/** React's SSR comment separators and whitespace are formatting, not content. */
function normalize(markup: string): string {
  return markup
    .replace(/<!--.*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** FNV-1a, 32-bit. Short enough to read in a diff, plenty for change detection. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** A section as HTML, with formatting noise removed. */
export function renderSection(section: LegalSection): string {
  return normalize(
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement("div", null, section.heading ?? "", section.body),
      ),
    ),
  );
}

/** A section as readable text — tags dropped, entities resolved. */
export function sectionText(section: LegalSection): string {
  return renderSection(section)
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function sectionFingerprint(section: LegalSection): string {
  return fingerprint(renderSection(section));
}
