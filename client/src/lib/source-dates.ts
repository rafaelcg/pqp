/**
 * Where a marketing page's `lastmod` comes from.
 *
 * A blog page is dated by its content (`page-registry.ts`). A marketing page has
 * no date of its own, so the build asks the repository: the day of the last
 * commit that touched the page's own source file. The three legal documents are
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
  "/": ["src/pages/landing-page.tsx"],
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

/** The day of the last commit that touched any of `files`, or null. */
export function gitLastModified(probe: Probe, files: readonly string[]): string | null {
  if (probe.git(["rev-parse", "--is-shallow-repository"]) !== "false") {
    return null;
  }
  const day = probe.git(["log", "-1", "--format=%cs", "--", ...files]);
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
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
  return files ? gitLastModified(probe, files) : null;
}
