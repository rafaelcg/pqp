import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GooglePlayBadge } from "./google-play-badge";

const HREF = "https://play.google.com/store/apps/details?id=gg.pqp.app&hl=en";
// React escapes `&` in serialized HTML attributes.
const HREF_ESCAPED = HREF.replace("&", "&amp;");

describe("GooglePlayBadge", () => {
  it("renders the locale-correct official artwork, unaltered", () => {
    const html = renderToStaticMarkup(<GooglePlayBadge href={HREF} locale="en" />);
    expect(html).toContain(`href="${HREF_ESCAPED}"`);
    expect(html).toContain('src="/images/google-play-badge-en.png"');
    expect(html).toContain('alt="Get it on Google Play"');
    // Google's guideline: never stretch or squash the badge.
    expect(html).toContain('width="646"');
    expect(html).toContain('height="250"');
  });

  it("picks the pt-BR badge and alt text", () => {
    const html = renderToStaticMarkup(<GooglePlayBadge href={HREF} locale="pt-BR" />);
    expect(html).toContain('src="/images/google-play-badge-pt-br.png"');
    expect(html).toContain('alt="Disponível no Google Play"');
  });

  it("picks the es-419 badge (Latin American Spanish) and alt text", () => {
    const html = renderToStaticMarkup(<GooglePlayBadge href={HREF} locale="es" />);
    expect(html).toContain('src="/images/google-play-badge-es-419.png"');
    expect(html).toContain('alt="Disponible en Google Play"');
  });

  it("opens in the same tab (this is a real store link, not a download)", () => {
    const html = renderToStaticMarkup(<GooglePlayBadge href={HREF} locale="en" />);
    expect(html).toContain('rel="noopener"');
    expect(html).not.toContain('target="_blank"');
  });
});
