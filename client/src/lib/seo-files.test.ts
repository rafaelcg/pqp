// Reads the two files a search engine actually fetches, `robots.txt` and
// `sitemap.xml`, the same way `blog-meta.test.ts` reads the real
// `index.html`: against the bytes that ship, not a description of them.
import robotsTxt from "../../public/robots.txt?raw";
import sitemapXml from "../../public/sitemap.xml?raw";
import { describe, expect, it } from "vitest";

/**
 * `robots.txt` vs `sitemap.xml`, the two files a technical SEO audit checks
 * first and the two that most easily drift from each other because nothing
 * enforces they agree: `robots.txt` is a list of rules, `sitemap.xml` is a
 * list of URLs, and there is no build step that reads one against the other.
 *
 * THE RULE THIS PINS: every URL listed in the sitemap has to be crawlable
 * under `robots.txt`'s own rules, for both the default crawler group and the
 * named AI-crawler group (they are meant to match, and a scanner grading the
 * named group would not know to check the wildcard one instead). A sitemap
 * entry a crawler is told not to fetch is a contradiction this project has
 * already been burned by once, on `/app/*` — see `app-robots.ts`.
 *
 * A minimal `Allow`/`Disallow` matcher, not a full RFC 9309 implementation:
 * longest match wins, ties go to `Allow` (both the actual Googlebot rule and
 * what this file's own comments say it is written for).
 */

interface Rule {
  path: string;
  allow: boolean;
}

function parseGroups(robots: string): Rule[][] {
  const groups: Rule[][] = [];
  let current: Rule[] = [];
  let sawDirective = false;
  for (const rawLine of robots.split("\n")) {
    const line = rawLine.split("#")[0]!.trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey!.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      if (sawDirective) {
        groups.push(current);
        current = [];
        sawDirective = false;
      }
      continue;
    }
    if (key === "allow" || key === "disallow") {
      current.push({ path: value, allow: key === "allow" });
      sawDirective = true;
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

/** Whether `pathname` may be fetched under one group's rules. */
function isAllowed(rules: Rule[], pathname: string): boolean {
  let best: Rule | null = null;
  for (const rule of rules) {
    if (rule.path === "") continue; // empty Disallow means "allow everything"
    if (pathname === rule.path || pathname.startsWith(rule.path)) {
      if (
        !best ||
        rule.path.length > best.path.length ||
        (rule.path.length === best.path.length && rule.allow && !best.allow)
      ) {
        best = rule;
      }
    }
  }
  return best ? best.allow : true;
}

function sitemapPaths(xml: string): string[] {
  return [...xml.matchAll(/<loc>https:\/\/pqp\.gg([^<]*)<\/loc>/g)].map(
    (m) => m[1]!,
  );
}

describe("robots.txt vs sitemap.xml", () => {
  const groups = parseGroups(robotsTxt);
  const paths = sitemapPaths(sitemapXml);

  it("actually found rule groups and sitemap URLs to check", () => {
    // A parsing bug that silently returns nothing would make every check
    // below vacuously pass.
    expect(groups.length).toBeGreaterThan(0);
    expect(paths.length).toBeGreaterThan(10);
  });

  it("keeps every sitemap URL crawlable under every named rule group", () => {
    for (const group of groups) {
      for (const path of paths) {
        expect(isAllowed(group, path), `${path} in group ${JSON.stringify(group)}`).toBe(
          true,
        );
      }
    }
  });

  it("lists the sitemap itself in robots.txt", () => {
    expect(robotsTxt).toContain("Sitemap: https://pqp.gg/sitemap.xml");
  });

  it("declares the wildcard and the named AI-crawler group the same way for /app", () => {
    // The two groups are meant to agree (the file's own comment says so);
    // this is what would catch one being edited without the other.
    const disallowsApp = groups.map((group) =>
      group.some((rule) => !rule.allow && rule.path === "/app"),
    );
    expect(disallowsApp.every((v) => v === false)).toBe(true);
  });
});
