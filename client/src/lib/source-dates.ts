/**
 * Where a marketing page's `lastmod` comes from.
 *
 * A blog page is dated by its content (`page-registry.ts`). A marketing page has
 * no date of its own, so the build asks the repository: the day of the last
 * commit that touched the page's own source file or its copy in the locale
 * catalogues (the lines under the page's i18n key prefixes, see
 * `COPY_KEY_PREFIXES`). The three legal documents are
 * the exception, because they state their own date ("Last updated: 12 October
 * 2026") and that is the truth a reader sees; it is read from the English source
 * (the Portuguese one is held to the same sections by `documents.test.ts`).
 *
 * NEVER INVENTED. Where the date cannot be known the answer is null and the
 * sitemap leaves `<lastmod>` out: a checkout with no history (a shallow CI
 * clone answers every file with the one commit it has, which would stamp every
 * page with the deploy day and teach crawlers to ignore the field), no `git`,
 * or a page with no source listed here.
 *
 * Build-time only (it runs `git`); nothing the edge or the client imports may
 * import this file.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The file(s) a marketing page is written in, relative to `client/`. A page
 * that is composed of shared components is dated by its own file only: a
 * footer change does not mean the page changed.
 */
export const MARKETING_SOURCES: Record<string, readonly string[]> = {
  // The home page is a folder of sections (PR 1387), not one file.
  "/": ["src/pages/home"],
  "/vs-discord": ["src/pages/vs-discord-page.tsx"],
  "/vem": ["src/pages/vem-page.tsx"],
  "/tela": ["src/pages/tela-page.tsx"],
  "/watch-party": ["src/pages/watch-party-page.tsx"],
  "/streamers": ["src/pages/streamers-page.tsx"],
  "/beta": ["src/pages/beta-page.tsx"],
  "/android": ["src/pages/android-page.tsx"],
  "/download": ["src/pages/download-page.tsx"],
  "/garanta": ["src/pages/claim-page.tsx"],
  "/apoie": ["src/pages/apoie-page.tsx"],
  "/contact": ["src/pages/contact-page.tsx"],
  // The comparison pages are dated by their page file AND the facts they print:
  // a re-checked cell (`compare-facts.ts`) is a change to the page. A path that
  // does not exist yet (before the hub merges) is simply not a commit.
  "/compare": ["src/pages/compare-page.tsx", "src/content/compare-facts.ts"],
  "/compare/stoat": ["src/pages/compare-product-page.tsx", "src/content/compare-facts.ts"],
  "/compare/teamspeak": ["src/pages/compare-product-page.tsx", "src/content/compare-facts.ts"],
  "/compare/slack": ["src/pages/compare-product-page.tsx", "src/content/compare-facts.ts"],
  "/status": ["src/pages/status-page.tsx"],
};

/** The documents that carry their own date, by the English source that holds it. */
export const LEGAL_SOURCES: Record<string, string> = {
  "/privacy": "src/pages/legal/privacy.en.tsx",
  "/terms": "src/pages/legal/terms.en.tsx",
  "/cookies": "src/pages/legal/cookies.en.tsx",
};

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * The `updated: "12 October 2026"` line of an English legal document as
 * `2026-10-12`, or null when it is missing or not a real date.
 */
export function legalUpdatedDay(source: string): string | null {
  const match = /^\s*updated:\s*"(\d{1,2}) ([A-Za-z]+) (\d{4})"/m.exec(source);
  if (!match) {
    return null;
  }
  const month = MONTHS.indexOf(match[2]!.toLowerCase());
  if (month === -1) {
    return null;
  }
  const at = new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  if (at.getUTCMonth() !== month || at.getUTCDate() !== Number(match[1])) {
    return null;
  }
  return at.toISOString().slice(0, 10);
}

export interface Probe {
  /** `git` output for these arguments, or null if git failed. */
  git(args: readonly string[]): string | null;
  /** A file's text, or null. */
  read(file: string): string | null;
}

/** The real thing, rooted at `client/`. */
export function realProbe(clientDir: string): Probe {
  return {
    git(args) {
      try {
        return execFileSync("git", [...args], {
          cwd: clientDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return null;
      }
    },
    read(file) {
      try {
        return fs.readFileSync(path.resolve(clientDir, file), "utf8");
      } catch {
        return null;
      }
    },
  };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The newest of two days, either of which may be absent. */
function newest(a: string | null, b: string | null): string | null {
  return a === null ? b : b === null ? a : a >= b ? a : b;
}

/**
 * The i18n key prefixes a page's visible copy lives under, in the three
 * catalogues. The catalogues are one big file per language that every page
 * shares, so a file-level date would move every page whenever any page's words
 * change; the date of the last commit that touched a LINE with one of these
 * prefixes (`git log -G`) moves only the page whose copy was edited.
 */
export const COPY_KEY_PREFIXES: Record<string, readonly string[]> = {
  // `home.*` is the page's copy; `landing.seo.*` is the title and description it kept.
  "/": ["home", "landing"],
  "/vs-discord": ["vsDiscord"],
  "/vem": ["vem"],
  "/tela": ["tela"],
  "/watch-party": ["watchPartyPage"],
  "/streamers": ["streamersPage"],
  "/beta": ["betaPage"],
  "/android": ["androidPage"],
  "/download": ["downloadPage"],
  "/garanta": ["claim"],
  "/apoie": ["apoie"],
  "/contact": ["contactPage"],
  "/status": ["status"],
  "/compare": ["compare"],
  "/compare/stoat": ["compare"],
  "/compare/teamspeak": ["compare"],
  "/compare/slack": ["compare"],
};

/** The three catalogues, relative to `client/`. */
export const CATALOGUES = [
  "src/locales/pt-BR/translation.json",
  "src/locales/en/translation.json",
  "src/locales/es/translation.json",
] as const;

/**
 * The day of the last commit that touched any of `files`, or, when `prefixes`
 * are given, any catalogue line under one of those i18n key prefixes. The newest
 * of the two. Null when history cannot say.
 */
export function gitLastModified(
  probe: Probe,
  files: readonly string[],
  prefixes: readonly string[] = [],
): string | null {
  if (probe.git(["rev-parse", "--is-shallow-repository"]) !== "false") {
    return null;
  }
  const valid = (day: string | null) => (day && DAY_RE.test(day) ? day : null);
  const fromFiles = valid(probe.git(["log", "-1", "--format=%cs", "--", ...files]));
  if (prefixes.length === 0) {
    return fromFiles;
  }
  // A line such as `  "vsDiscord.hero.title": "...",` added or removed. `git log -G` takes a POSIX
  // extended regex, where a backslash-s is a GNU extension: on a git linked against another libc it
  // matches nothing and every copy edit would go unseen, so the whitespace is the POSIX class.
  const pattern = `^[[:space:]]*"(${prefixes.join("|")})\\.`;
  const fromCopy = valid(
    probe.git(["log", "-1", "--format=%cs", `-G${pattern}`, "--", ...CATALOGUES]),
  );
  return newest(fromFiles, fromCopy);
}

/** A marketing page's `lastmod`, or null when it cannot be known. */
export function marketingLastmod(probe: Probe, pathname: string): string | null {
  const legal = LEGAL_SOURCES[pathname];
  if (legal) {
    const source = probe.read(legal);
    const day = source === null ? null : legalUpdatedDay(source);
    if (day) {
      return day;
    }
  }
  const files = MARKETING_SOURCES[pathname] ?? (legal ? [legal] : null);
  return files ? gitLastModified(probe, files, COPY_KEY_PREFIXES[pathname] ?? []) : null;
}
