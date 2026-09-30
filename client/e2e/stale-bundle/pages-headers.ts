/**
 * What Cloudflare Pages does with `public/_headers`, as far as cache policy is
 * concerned, in a form a unit test and the stand-in server can both use:
 *
 *  - a file with no matching rule gets what Pages gives every asset by default,
 *    `public, max-age=0, must-revalidate`;
 *  - the REAL `_headers` file is parsed and applied, with Pages' rule that
 *    several matching rules ADD to a header rather than replace it. A rule that
 *    wrongly matched `/assets/*` and `/*` shows up as a comma-joined
 *    Cache-Control, which is what production would send.
 *
 * It does NOT model the Cloudflare zone in front of Pages, which on 2026-09-30
 * rewrote `/sw.js` to `max-age=14400` on `pqp.gg`; see the note in `_headers`.
 */

export interface HeaderRule {
  pattern: RegExp;
  headers: [string, string][];
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

/** Cloudflare Pages `_headers`: an unindented path, then indented `Name: value` lines. */
export function parseHeadersFile(source: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    if (!/^\s/.test(line)) {
      current = { pattern: patternToRegExp(line.trim()), headers: [] };
      rules.push(current);
      continue;
    }
    const colon = line.indexOf(":");
    if (current && colon > 0) {
      current.headers.push([
        line.slice(0, colon).trim().toLowerCase(),
        line.slice(colon + 1).trim(),
      ]);
    }
  }
  return rules;
}

/**
 * The headers Pages would send for `pathname`, given what file answered it.
 * Exported so a unit test can pin the cache policy without a browser.
 */
export function headersFor(
  rules: HeaderRule[],
  pathname: string,
  contentType: string,
): Record<string, string> {
  const headers = new Map<string, string>();
  headers.set("content-type", contentType);
  // The Pages default for anything no rule speaks to.
  headers.set("cache-control", "public, max-age=0, must-revalidate");
  let ruled = false;
  for (const rule of rules) {
    // The REQUEST path, never the file that answered it: `/` is served from
    // `index.html` and must not also collect the `/index.html` rule.
    if (!rule.pattern.test(pathname)) {
      continue;
    }
    for (const [name, value] of rule.headers) {
      if (name === "cache-control") {
        // Pages joins the values of every matching rule. The default is
        // replaced by the first rule that speaks, then joined by the rest.
        headers.set(name, ruled ? `${headers.get(name)}, ${value}` : value);
        ruled = true;
      } else if (headers.has(name) && name !== "content-type") {
        headers.set(name, `${headers.get(name)}, ${value}`);
      } else {
        headers.set(name, value);
      }
    }
  }
  return Object.fromEntries(headers);
}

