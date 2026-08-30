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
});
