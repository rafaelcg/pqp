import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  getApiBaseUrl: () => "https://api.example.test",
}));

const { UserAvatar } = await import("./user-avatar");

/**
 * The component every person's picture now goes through. What matters is what
 * it does with a URL it was handed, since that URL is a string one account
 * holder chose and everybody else's browser is about to fetch.
 */
describe("UserAvatar", () => {
  it("draws the monogram when there is no picture", () => {
    const html = renderToStaticMarkup(<UserAvatar name="Rafael" />);
    expect(html).toContain(">R<");
    expect(html).not.toContain("<img");
  });

  it("falls back to a question mark rather than an empty box", () => {
    expect(renderToStaticMarkup(<UserAvatar name="   " />)).toContain(">?<");
  });

  it("renders an https avatar as an image", () => {
    const html = renderToStaticMarkup(
      <UserAvatar name="Rafael" avatarUrl="https://cdn.example.com/a.png" />,
    );
    expect(html).toContain('src="https://cdn.example.com/a.png"');
    expect(html).not.toContain(">R<");
  });

  it("points this server's own avatar path at the API origin", () => {
    const html = renderToStaticMarkup(
      <UserAvatar name="Rafael" avatarUrl="/api/avatars/abc?v=1234abcd" />,
    );
    expect(html).toContain("https://api.example.test/api/avatars/abc?v=1234abcd");
  });

  it("draws the monogram for a scheme it will not load", () => {
    for (const url of ["javascript:alert(1)", "http://cdn.example.com/a.png"]) {
      const html = renderToStaticMarkup(
        <UserAvatar name="Rafael" avatarUrl={url} />,
      );
      expect(html).not.toContain("<img");
      expect(html).toContain(">R<");
    }
  });

  it("sends no referrer with the request", () => {
    // A typed avatar URL is a credible tracking pixel aimed at everybody who
    // can see this person; it should at least not learn which page they are on.
    const html = renderToStaticMarkup(
      <UserAvatar name="Rafael" avatarUrl="https://cdn.example.com/a.png" />,
    );
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('loading="lazy"');
  });

  it("keeps the caller's shape and fallback colour", () => {
    const html = renderToStaticMarkup(
      <UserAvatar
        name="Rafael"
        className="h-6 w-6"
        fallbackClassName="bg-ink-4 text-[10px] text-paper"
        rounded="full"
      />,
    );
    expect(html).toContain("rounded-full");
    expect(html).toContain("h-6 w-6");
    expect(html).toContain("bg-ink-4");
  });
});
