import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { DownloadCatalog } from "./download-catalog";

describe("DownloadCatalog", () => {
  it("lists every platform so a shared link works on the friend's machine", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DownloadCatalog />
      </MemoryRouter>,
    );
    expect(html).toContain("Windows");
    expect(html).toContain("Mac");
    expect(html).toContain("Linux");
    expect(html).toContain("iPhone");
    expect(html).toContain("Android");
    expect(html).toContain("Download for Windows");
    expect(html).toContain("/beta");
    expect(html).toContain("/android");
  });

  // The installer can crash before it writes anything to disk (APPCRASH
  // 0xc0000005 in an NSIS plugin), and the portable build is the only way out
  // of that. It has to be reachable from the shared link, not only from the
  // Windows-detected note, because whoever forwards the link is rarely the
  // person whose installer failed.
  it("offers the Windows portable build from the all-platforms list", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DownloadCatalog />
      </MemoryRouter>,
    );
    expect(html).toContain("Portable");
    expect(html).toContain("Download the portable build");
  });
});
