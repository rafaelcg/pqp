// The sitemap the build writes, produced the way the build produces it, for the
// tests that used to read `public/sitemap.xml` (which no longer exists: the
// file is generated, see `src/lib/sitemap-pages.ts`).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSitemap } from "../lib/seo-files";
import { sitemapPages } from "../lib/sitemap-pages";
import { marketingLastmod, realProbe } from "../lib/source-dates";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const GENERATED_SITEMAP = renderSitemap(
  sitemapPages((page) => marketingLastmod(realProbe(clientDir), page)),
);
