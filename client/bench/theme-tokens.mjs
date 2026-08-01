/**
 * Static theme benchmarks. Two numbers, both ratchets:
 *
 *   contrast  — WCAG ratio for every semantic foreground/background pair, per
 *               theme. Guards quality: a theme edit that makes muted text
 *               unreadable fails here rather than in someone's eyes.
 *   leaks     — colour literals living outside the token layer. Guards
 *               consistency: this is how the codebase drifted to eight
 *               un-themeable spots in the first place, and the only way to stop
 *               it is to count them and refuse to let the count grow.
 *
 * Run: pnpm --filter @pqp/client bench:tokens
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { contrastRatio, round } from "./lib/color.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..");
const SRC = join(CLIENT, "src");
const CSS = join(SRC, "index.css");

/**
 * Pairs that must stay legible. Foreground first. `AA` is the WCAG floor for
 * that pair: 4.5 for body text, 3.0 for large text and non-text indicators.
 */
const CONTRAST_PAIRS = [
  { fg: "--color-text", bg: "--color-surface-0", floor: 4.5, label: "body text on app background" },
  { fg: "--color-text", bg: "--color-surface-1", floor: 4.5, label: "body text on panel" },
  { fg: "--color-text", bg: "--color-surface-2", floor: 4.5, label: "body text on raised panel" },
  { fg: "--color-text-muted", bg: "--color-surface-0", floor: 4.5, label: "muted text on app background" },
  { fg: "--color-text-muted", bg: "--color-surface-1", floor: 4.5, label: "muted text on panel" },
  { fg: "--color-accent", bg: "--color-surface-0", floor: 3.0, label: "accent on app background" },
  { fg: "--color-accent", bg: "--color-surface-1", floor: 3.0, label: "accent on panel" },
  { fg: "--color-on-accent", bg: "--color-accent", floor: 4.5, label: "text on an accent button" },
  { fg: "--color-danger", bg: "--color-surface-1", floor: 3.0, label: "danger on panel" },
  { fg: "--color-warning", bg: "--color-surface-1", floor: 3.0, label: "warning on panel" },
  { fg: "--color-success", bg: "--color-surface-1", floor: 3.0, label: "success on panel" },
  { fg: "--color-code-text", bg: "--color-code-bg", floor: 4.5, label: "inline code" },
  { fg: "--color-border-strong", bg: "--color-surface-1", floor: 1.5, label: "visible border on panel" },
];

/**
 * Colour literals anywhere but the token definitions. The lookbehind keeps
 * prose like the `name#1234` handle format from reading as a hex colour.
 */
const COLOR_LITERAL =
  /(?:oklch|rgba?|hsla?)\([^)]*\)|(?<![\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;

/** Files whose colours are inherently outside the theme system. */
const LEAK_EXEMPT = [
  /\/bench\//,
  /\/e2e\//,
  /\.test\.[tj]sx?$/,
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if ([".ts", ".tsx", ".css", ".html"].includes(extname(full))) {
      out.push(full);
    }
  }
  return out;
}

/** Extract `--token: value;` declarations from a CSS block. */
function readTokens(css, blockMatcher) {
  const block = blockMatcher.exec(css);
  if (!block) {
    return {};
  }
  const tokens = {};
  for (const [, name, value] of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

/** Resolve `var(--x)` chains so aliases can be measured like real values. */
function resolve(tokens, name, seen = new Set()) {
  const value = tokens[name];
  if (value === undefined || seen.has(name)) {
    return null;
  }
  seen.add(name);
  const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  return alias ? resolve(tokens, alias[1], seen) : value;
}

function auditContrast(tokens, themeName) {
  const results = [];
  for (const pair of CONTRAST_PAIRS) {
    const fg = resolve(tokens, pair.fg);
    const bg = resolve(tokens, pair.bg);
    if (!fg || !bg) {
      results.push({ ...pair, theme: themeName, ratio: null, pass: null, reason: "token missing" });
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    results.push({
      theme: themeName,
      label: pair.label,
      fg: pair.fg,
      bg: pair.bg,
      floor: pair.floor,
      ratio: ratio === null ? null : round(ratio),
      pass: ratio === null ? null : ratio >= pair.floor,
    });
  }
  return results;
}

function auditLeaks() {
  const css = readFileSync(CSS, "utf8");
  // Everything inside a token-defining block is a definition, not a leak.
  const definitionRanges = [];
  for (const match of css.matchAll(/(?:@theme[\w\s]*|:root[^{]*)\{/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    definitionRanges.push([match.index, i]);
  }
  const inDefinition = (index) =>
    definitionRanges.some(([from, to]) => index >= from && index < to);

  const leaks = [];
  for (const file of walk(SRC)) {
    const rel = relative(CLIENT, file);
    if (LEAK_EXEMPT.some((pattern) => pattern.test(file))) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    const isIndexCss = file === CSS;
    for (const match of text.matchAll(COLOR_LITERAL)) {
      if (isIndexCss && inDefinition(match.index)) {
        continue;
      }
      const line = text.slice(0, match.index).split("\n").length;
      leaks.push({ file: rel, line, literal: match[0] });
    }
  }
  return leaks;
}

const css = readFileSync(CSS, "utf8");
const themes = {
  dark: readTokens(css, /@theme[^{]*\{([\s\S]*?)\n\}/),
};
// A light theme, once it exists, layers over the dark tokens.
const lightBlock = readTokens(css, /:root\[data-theme="light"\][^{]*\{([\s\S]*?)\n\}/);
if (Object.keys(lightBlock).length > 0) {
  themes.light = { ...themes.dark, ...lightBlock };
}
const contrastBlock = readTokens(
  css,
  /:root\[data-theme="high-contrast"\][^{]*\{([\s\S]*?)\n\}/,
);
if (Object.keys(contrastBlock).length > 0) {
  themes["high-contrast"] = { ...themes.dark, ...contrastBlock };
}

const contrast = Object.entries(themes).flatMap(([name, tokens]) =>
  auditContrast(tokens, name),
);
const leaks = auditLeaks();

const measured = contrast.filter((r) => r.ratio !== null);
const failures = measured.filter((r) => r.pass === false);
const missing = contrast.filter((r) => r.ratio === null);

const report = {
  measuredAt: new Date().toISOString(),
  themes: Object.keys(themes),
  contrast: {
    checked: measured.length,
    failing: failures.length,
    missingTokens: missing.length,
    worst: measured.length
      ? measured.reduce((a, b) => (a.ratio < b.ratio ? a : b))
      : null,
    results: contrast,
  },
  leaks: {
    count: leaks.length,
    byFile: Object.entries(
      leaks.reduce((acc, leak) => {
        acc[leak.file] = (acc[leak.file] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .sort((a, b) => b[1] - a[1])
      .map(([file, count]) => ({ file, count })),
    results: leaks,
  },
};

const outPath = join(HERE, "results", "theme-tokens.json");
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`themes:   ${report.themes.join(", ") || "(none)"}`);
console.log(
  `contrast: ${measured.length - failures.length}/${measured.length} pass` +
    (missing.length ? `, ${missing.length} token(s) not defined yet` : ""),
);
if (report.contrast.worst) {
  const w = report.contrast.worst;
  console.log(`  worst:  ${w.ratio}:1 (floor ${w.floor}) — ${w.theme}, ${w.label}`);
}
for (const failure of failures) {
  console.log(
    `  FAIL    ${failure.ratio}:1 < ${failure.floor} — ${failure.theme}, ${failure.label}`,
  );
}
console.log(`leaks:    ${leaks.length} colour literal(s) outside the token layer`);
for (const entry of report.leaks.byFile.slice(0, 10)) {
  console.log(`  ${String(entry.count).padStart(3)}  ${entry.file}`);
}
console.log(`\nwrote ${relative(CLIENT, outPath)}`);

// A ratchet, not a gate: BENCH_MAX_LEAKS pins the current number so the count
// can only go down. Contrast failures always fail.
const maxLeaks = process.env.BENCH_MAX_LEAKS;
if (failures.length > 0) {
  process.exitCode = 1;
} else if (maxLeaks !== undefined && leaks.length > Number(maxLeaks)) {
  console.error(
    `\nleak ratchet: ${leaks.length} > ${maxLeaks}. Use a token instead of a literal.`,
  );
  process.exitCode = 1;
}
