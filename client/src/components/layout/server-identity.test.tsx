import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  getApiBaseUrl: () => "https://api.example.test",
}));

const { ServerBanner, ServerIcon, serverMonogram } = await import(
  "./server-identity"
);

/**
 * A server's pictures, on the two paths that matter: the picture is missing (by
 * far the common case, and the one that must look deliberate) and the URL is
 * hostile.
 *
 * `ChannelIcon` has the same shape of test for the same reason — these values
 * are set by one person and rendered to a whole server, so the fallback is not
 * an edge case, it is the default rendering.
 */

describe("serverMonogram", () => {
  it("is the first two characters, uppercased — what the rail already drew", () => {
    expect(serverMonogram("pqp")).toBe("PQ");
    expect(serverMonogram("Ghostty")).toBe("GH");
  });
});

describe("ServerIcon", () => {
  it("draws the monogram when there is no icon", () => {
    const html = renderToStaticMarkup(
      <ServerIcon name="Ghostty" iconUrl={null} />,
    );
    expect(html).toContain("GH");
    expect(html).not.toContain("<img");
  });

  it("prefixes the API origin onto this deployment's own icon path", () => {
    // The SPA and the API are routinely two origins; a bare relative path here
    // asks Cloudflare Pages for an image only Railway has.
    const html = renderToStaticMarkup(
      <ServerIcon name="Ghostty" iconUrl="/api/servers/abc/icon?v=deadbeef" />,
    );
    expect(html).toContain(
      'src="https://api.example.test/api/servers/abc/icon?v=deadbeef"',
    );
  });

  it("falls back to the monogram for a non-https URL rather than rendering it", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "http://cdn.example.com/a.png",
    ]) {
      const html = renderToStaticMarkup(
        <ServerIcon name="Ghostty" iconUrl={hostile} />,
      );
      expect(html).not.toContain("<img");
      expect(html).toContain("GH");
    }
  });

  it("sends no referrer with the image request", () => {
    const html = renderToStaticMarkup(
      <ServerIcon name="Ghostty" iconUrl="https://cdn.example.com/a.png" />,
    );
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("lets the caller override the monogram", () => {
    // The communities directory has its own, which is emoji-safe and takes word
    // initials. Only the image path is shared between the two.
    const html = renderToStaticMarkup(
      <ServerIcon name="Eu odeio acordar cedo" iconUrl={null} fallback="EO" />,
    );
    expect(html).toContain("EO");
  });
});

describe("ServerBanner", () => {
  it("renders nothing at all without a banner", () => {
    // Not an empty band and not a placeholder: a server that set no banner has
    // to keep exactly the column it has always had.
    expect(
      renderToStaticMarkup(<ServerBanner name="Ghostty" bannerUrl={null} />),
    ).toBe("");
  });

  it("renders nothing for a non-https URL", () => {
    expect(
      renderToStaticMarkup(
        <ServerBanner name="Ghostty" bannerUrl="javascript:alert(1)" />,
      ),
    ).toBe("");
  });

  it("draws the image, a scrim, and the server name over it", () => {
    const html = renderToStaticMarkup(
      <ServerBanner name="Ghostty" bannerUrl="https://cdn.example.com/b.png" />,
    );
    expect(html).toContain('src="https://cdn.example.com/b.png"');
    expect(html).toContain("Ghostty");
    // The scrim is what makes the name legible over an arbitrary photograph;
    // no colour token can promise contrast against one.
    expect(html).toContain("bg-gradient-to-t");
    expect(html).toContain('referrerPolicy="no-referrer"');
  });
});
