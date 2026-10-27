/**
 * Static theme benchmarks. Three numbers, all ratchets:
 *
 *   contrast  — WCAG ratio for every semantic foreground/background pair, per
 *               theme. Guards quality: a theme edit that makes muted text
 *               unreadable fails here rather than in someone's eyes.
 *   leaks     — colour literals living outside the token layer. Guards
 *               consistency: this is how the codebase drifted to eight
 *               un-themeable spots in the first place, and the only way to stop
 *               it is to count them and refuse to let the count grow.
 *   uiAliases — uses of the deprecated colour-named aliases inside
 *               `src/components/ui/`. Guards the design system: the primitives
 *               are the reference every other surface is copied from, so an
 *               `ink`/`paper`/`signal` name there teaches the wrong name to the
 *               next component. This one is a gate at zero, not a ratchet that
 *               pins today's number, because the primitives are already clean.
 *   uiStatics — Tailwind's own static radius, duration and shadow utilities
 *               (`rounded-md`, `duration-150`, `shadow-2xl`) inside
 *               `src/components/ui/`. Same rule as a colour literal: a
 *               primitive names a token, so it writes
 *               `rounded-[var(--radius-card)]`, not a number Tailwind chose.
 *               `rounded-full` is exempt: the pill is documented as a static
 *               utility in DESIGN.md. Gate at zero.
 *   tokenDrift — role tokens defined in `index.css` but missing from
 *               `src/lib/design-tokens.ts`, or listed there and gone from
 *               the
 *               CSS. That file is a hand-written mirror of the token names and
 *               is what `/qa/ui` draws, so a token nobody mirrored is a token
 *               the reference page silently omits. Always fails.
 *
 * Run: pnpm --filter @pqp/client bench:tokens
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { contrastRatio, deltaE, parseColour, round } from "./lib/color.mjs";

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
  { fg: "--color-text-secondary", bg: "--color-surface-0", floor: 4.5, label: "secondary text on app background" },
  { fg: "--color-text-secondary", bg: "--color-surface-1", floor: 4.5, label: "secondary text on panel" },
  { fg: "--color-text-tertiary", bg: "--color-surface-0", floor: 4.5, label: "tertiary text on app background" },
  { fg: "--color-text-tertiary", bg: "--color-surface-1", floor: 4.5, label: "tertiary text on panel" },
  { fg: "--color-accent", bg: "--color-surface-0", floor: 3.0, label: "accent on app background" },
  { fg: "--color-accent", bg: "--color-surface-1", floor: 3.0, label: "accent on panel" },
  { fg: "--color-on-accent", bg: "--color-accent", floor: 4.5, label: "text on an accent button" },
  { fg: "--color-danger", bg: "--color-surface-1", floor: 3.0, label: "danger on panel" },
  // An unread count: bold digits on a small red pill. Graphical-object floor,
  // the same 3.0 the danger hue itself meets on a panel.
  { fg: "--color-on-danger", bg: "--color-danger", floor: 3.0, label: "count on a danger badge" },
  { fg: "--color-warning", bg: "--color-surface-1", floor: 3.0, label: "warning on panel" },
  { fg: "--color-success", bg: "--color-surface-1", floor: 3.0, label: "success on panel" },
  { fg: "--color-code-text", bg: "--color-code-bg", floor: 4.5, label: "inline code" },
  { fg: "--color-border-strong", bg: "--color-surface-1", floor: 1.5, label: "visible border on panel" },
  // The soft surfaces. Each on/soft pair is body text on a fill, so the floor
  // is 4.5 — this is the number `bg-danger/20 text-danger` never had, because
  // an alpha wash over an unknown backdrop cannot be measured at all.
  { fg: "--color-on-accent-soft", bg: "--color-accent-soft", floor: 4.5, label: "text on a soft accent fill" },
  { fg: "--color-on-danger-soft", bg: "--color-danger-soft", floor: 4.5, label: "text on a soft danger fill" },
  { fg: "--color-on-danger-soft", bg: "--color-danger-soft-hover", floor: 4.5, label: "text on a hovered soft danger fill" },
  { fg: "--color-on-warning-soft", bg: "--color-warning-soft", floor: 4.5, label: "text on a soft warning fill" },
  { fg: "--color-on-success-soft", bg: "--color-success-soft", floor: 4.5, label: "text on a soft success fill" },
  // The redesign's shell and row roles (docs/redesign/LOG.md, council round
  // D1). `redesign: true` measures a pair only on the `redesign-*` themes:
  // nothing draws these roles with the toggle off.
  { fg: "--color-text", bg: "--color-pane-side", floor: 4.5, label: "body text on the side pane", redesign: true },
  { fg: "--color-text", bg: "--color-pane-main", floor: 4.5, label: "body text on the conversation pane", redesign: true },
  { fg: "--color-text-secondary", bg: "--color-pane-side", floor: 4.5, label: "secondary text on the side pane", redesign: true },
  { fg: "--color-text-tertiary", bg: "--color-pane-side", floor: 4.5, label: "tertiary text (offline names) on the side pane", redesign: true },
  { fg: "--color-text-tertiary", bg: "--color-pane-main", floor: 4.5, label: "tertiary text (timestamps) on the conversation pane", redesign: true },
  { fg: "--color-text-tertiary", bg: "--color-row-hover", floor: 4.5, label: "tertiary text on a hovered row", redesign: true },
  // The monogram under the redesign: a letter as small as 10px on its disc.
  { fg: "--color-text", bg: "--color-surface-3", floor: 4.5, label: "a monogram on its neutral disc", redesign: true },
  // Badges under the redesign: an 11px word on its fill.
  { fg: "--color-text", bg: "--color-surface-3", floor: 4.5, label: "a neutral badge (OP, Fechado)", redesign: true },
  { fg: "--color-text-secondary", bg: "--color-surface-2", floor: 4.5, label: "a muted badge (Saiu, Removido)", redesign: true },
  // Nothing but icons and the unread pip sits on the canvas (the rail), so
  // the non-text floor.
  { fg: "--color-text-secondary", bg: "--color-canvas", floor: 3.0, label: "an icon on the canvas (the rail)", redesign: true },
  { fg: "--color-accent", bg: "--color-canvas", floor: 3.0, label: "accent on the canvas", redesign: true },
  { fg: "--color-on-row-selected", bg: "--color-row-selected", floor: 4.5, label: "label and second line on the selected row", redesign: true },
  { fg: "--color-accent", bg: "--color-row-selected", floor: 3.0, label: "focus ring on the selected row", redesign: true },
  { fg: "--color-accent-text", bg: "--color-row-selected", floor: 3.0, label: "pressed icon on the selected fill", redesign: true },
  { fg: "--color-accent-text", bg: "--color-pane-side", floor: 4.5, label: "accent text on the side pane", redesign: true },
  { fg: "--color-accent-text", bg: "--color-pane-main", floor: 4.5, label: "accent text on the conversation pane", redesign: true },
  { fg: "--color-accent-text", bg: "--color-surface-2", floor: 4.5, label: "accent text on a raised panel", redesign: true },
  { fg: "--color-success-text", bg: "--color-pane-side", floor: 4.5, label: "success text on the side pane", redesign: true },
  { fg: "--color-success-text", bg: "--color-surface-1", floor: 4.5, label: "success text on panel", redesign: true },
  { fg: "--color-text", bg: "--color-mention-row", floor: 4.5, label: "body text on a mention row", redesign: true },
  { fg: "--color-text-tertiary", bg: "--color-mention-row", floor: 4.5, label: "timestamp on a mention row", redesign: true },
  { fg: "--color-mention-bar", bg: "--color-pane-main", floor: 3.0, label: "mention bar on the conversation pane", redesign: true },
  { fg: "--color-on-mention-chip", bg: "--color-mention-chip", floor: 4.5, label: "@name on a mention chip", redesign: true },
  { fg: "--color-indicator", bg: "--color-pane-side", floor: 3.0, label: "unread pip on the side pane", redesign: true },
  { fg: "--color-on-tooltip", bg: "--color-tooltip", floor: 4.5, label: "tooltip label", redesign: true },
  { fg: "--color-tooltip-detail", bg: "--color-tooltip", floor: 4.5, label: "tooltip detail line", redesign: true },
  { fg: "--color-text", bg: "--color-field", floor: 4.5, label: "value in a text field", redesign: true },
  { fg: "--color-text-tertiary", bg: "--color-field", floor: 4.5, label: "placeholder in a text field", redesign: true },
  { fg: "--color-text-secondary", bg: "--color-field", floor: 4.5, label: "prefix in a text field", redesign: true },
  { fg: "--color-field-border", bg: "--color-field", floor: 3.0, label: "text field edge on its fill", redesign: true },
  { fg: "--color-field-border", bg: "--color-surface-2", floor: 3.0, label: "text field edge on a dialog", redesign: true },
  { fg: "--color-field-border", bg: "--color-pane-main", floor: 3.0, label: "text field edge on the conversation pane", redesign: true },
];

/**
 * Steps between two fills that must stay visibly apart. Not text, so not a
 * WCAG ratio: the distance in OKLab, where 0 is the same colour. Council round
 * D1 found that panes told apart by tone alone collapse in light, and that
 * hover and selected looked alike; these pin both, on every redesign theme.
 */
const STEP_PAIRS = [
  { a: "--color-canvas", b: "--color-pane-side", floor: 0.04, label: "canvas to side pane" },
  { a: "--color-canvas", b: "--color-pane-main", floor: 0.04, label: "canvas to conversation pane" },
  { a: "--color-row-hover", b: "--color-pane-side", floor: 0.02, label: "hovered row on the side pane" },
  { a: "--color-row-hover", b: "--color-pane-main", floor: 0.02, label: "hovered row on the conversation pane" },
  { a: "--color-row-selected", b: "--color-row-hover", floor: 0.03, label: "selected row against a hovered row" },
  { a: "--color-row-selected", b: "--color-pane-side", floor: 0.03, label: "selected row on the side pane" },
  { a: "--color-mention-row", b: "--color-pane-main", floor: 0.03, label: "mention row on the conversation pane" },
  { a: "--color-mention-chip", b: "--color-mention-row", floor: 0.05, label: "@name chip on a mention row" },
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

/**
 * The deprecated aliases, longest name first so `ink` cannot swallow `ink-3`
 * and `muted` cannot swallow `text-muted`. Kept in sync with the alias block in
 * `index.css` by hand: it is a list that only ever shrinks.
 *
 * `text-muted` and `text-subtle` joined it when the text ladder was renamed to
 * text / text-secondary / text-tertiary. They still resolve everywhere, because
 * a couple of hundred call sites outside ui/ spell them, but a primitive that
 * writes `text-text-subtle` teaches a name whose meaning is backwards.
 */
const DEPRECATED_ALIASES = [
  "text-muted",
  "text-subtle",
  "ink-4",
  "ink-3",
  "ink-2",
  "ink",
  "paper-muted",
  "paper",
  "signal-dim",
  "signal",
  "panel-hover",
  "panel",
  "channel",
  "background",
  "foreground",
  "muted",
];

/**
 * A deprecated alias used as a colour. Two shapes, and both have to be caught
 * or the count is a fiction:
 *
 *   `hover:bg-ink-3`, `focus-visible:ring-signal/60` — a Tailwind utility, with
 *   any number of variant prefixes and an optional opacity suffix.
 *   `accent-[var(--color-signal)]` — the custom property named directly, which
 *   is what a component reaches for when no utility exists.
 *
 * The lookbehind stops `text-text-muted` from reading as the `muted` alias and
 * `bg-surface-1` from reading as anything at all.
 */
const ALIAS_UTILITY = new RegExp(
  "(?<![\\w-])(?:[a-z0-9-]+(?:\\[[^\\]]*\\])?:)*" +
    "(?:bg|text|border|ring|fill|stroke|from|via|to|accent|divide|outline|placeholder|caret|decoration)-" +
    `(?:${DEPRECATED_ALIASES.join("|")})` +
    "(?:/\\d+)?(?![\\w-])",
  "g",
);

const ALIAS_PROPERTY = new RegExp(
  `--color-(?:${DEPRECATED_ALIASES.join("|")})(?![\\w-])`,
  "g",
);

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

/**
 * Resolve `var(--x)` so aliases can be measured like real values: a whole-value
 * alias, or a `var()` inside a derived value such as a `color-mix()`.
 */
function resolve(tokens, name, seen = new Set()) {
  const value = tokens[name];
  if (value === undefined || seen.has(name)) {
    return null;
  }
  const chain = new Set(seen).add(name);
  let missing = false;
  const out = value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, inner) => {
    const resolved = resolve(tokens, inner, chain);
    if (resolved === null) {
      missing = true;
      return "";
    }
    return resolved;
  });
  return missing ? null : out;
}

const isRedesignTheme = (name) => name.startsWith("redesign-");

function auditContrast(tokens, themeName) {
  const results = [];
  for (const pair of CONTRAST_PAIRS) {
    if (pair.redesign && !isRedesignTheme(themeName)) {
      continue;
    }
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

function auditSteps(tokens, themeName) {
  if (!isRedesignTheme(themeName)) {
    return [];
  }
  return STEP_PAIRS.map((pair) => {
    const a = resolve(tokens, pair.a);
    const b = resolve(tokens, pair.b);
    const distance = a && b ? deltaE(a, b) : null;
    return {
      theme: themeName,
      label: pair.label,
      a: pair.a,
      b: pair.b,
      floor: pair.floor,
      distance: distance === null ? null : round(distance, 3),
      pass: distance === null ? null : distance >= pair.floor,
    };
  });
}

/**
 * The pane rule, as an order rather than a distance: on every redesign theme
 * the canvas is the darkest of the three and the conversation the brightest
 * (OKLab lightness). A distance alone let a look swap its panes and still
 * pass, which council round T2 caught in Modo 2005 light.
 */
function auditPaneOrder(tokens, themeName) {
  if (!isRedesignTheme(themeName)) {
    return [];
  }
  const l = (name) => {
    const value = resolve(tokens, name);
    return value ? parseColour(value)?.l ?? null : null;
  };
  const canvas = l("--color-canvas");
  const side = l("--color-pane-side");
  const main = l("--color-pane-main");
  if (canvas === null || side === null || main === null) {
    return [{ theme: themeName, label: "pane order unmeasurable", pass: null }];
  }
  return [
    {
      theme: themeName,
      label: "canvas darker than the side pane",
      values: [round(canvas, 3), round(side, 3)],
      pass: canvas < side,
    },
    {
      theme: themeName,
      label: "conversation at least as bright as the side pane",
      values: [round(side, 3), round(main, 3)],
      pass: main >= side,
    },
  ];
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

/**
 * Deprecated aliases inside the ui/ primitives. Only that directory: the rest
 * of the app still carries hundreds of them and codemodding it is a separate
 * change. The primitives are the reference, so they are held at zero.
 */
function auditUiAliases() {
  const uiDir = join(SRC, "components", "ui");
  const found = [];
  for (const file of walk(uiDir)) {
    if (LEAK_EXEMPT.some((pattern) => pattern.test(file))) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    const rel = relative(CLIENT, file);
    for (const pattern of [ALIAS_UTILITY, ALIAS_PROPERTY]) {
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split("\n").length;
        found.push({ file: rel, line, alias: match[0] });
      }
    }
  }
  return found;
}

/**
 * A static Tailwind radius, duration or shadow utility. The value has to be a
 * bare word or number: `rounded-[var(--radius-card)]` and
 * `shadow-[var(--shadow-popover)]` are token references and must not match, and
 * neither may the `--duration-fast` inside a `var()`, which the leading
 * lookbehind rules out.
 */
const STATIC_UTILITY = new RegExp(
  "(?<![\\w-])(?:[a-z0-9-]+(?:\\[[^\\]]*\\])?:)*" +
    "(rounded|shadow|duration)" +
    "(?:-(?:t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee))?" +
    "-([a-z0-9]+)(?![\\w-[])",
  "g",
);

/** The one static radius the design system keeps: the pill. */
const STATIC_ALLOWED = new Set(["rounded-full"]);

/**
 * Static radius/duration/shadow utilities inside the ui/ primitives. Scoped
 * there for the same reason the alias gate is: the rest of the app carries
 * hundreds and codemodding it is a separate change.
 */
function auditUiStatics() {
  const uiDir = join(SRC, "components", "ui");
  const found = [];
  for (const file of walk(uiDir)) {
    if (LEAK_EXEMPT.some((pattern) => pattern.test(file))) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    const rel = relative(CLIENT, file);
    for (const match of text.matchAll(STATIC_UTILITY)) {
      const utility = `${match[1]}-${match[2]}`;
      if (STATIC_ALLOWED.has(utility)) {
        continue;
      }
      const line = text.slice(0, match.index).split("\n").length;
      found.push({ file: rel, line, utility: match[0] });
    }
  }
  return found;
}

/** Role-token families the token sheet is expected to mirror in full. */
const MIRRORED = [
  /^--radius-/,
  /^--shadow-\d+$/,
  /^--duration-/,
  /^--ease-/,
  /^--type-/,
  /^--control-/,
  /^--space-/,
  // Icon sizes and stroke. `--icon-button-*` are IconButton's component
  // tokens, like `--button-*`, not roles the sheet lists.
  /^--icon-(?!button-)/,
];

const TOKENS_TS = join(SRC, "lib", "design-tokens.ts");

/** Every role token name `index.css` defines, in the families above. */
function cssRoleTokens(css) {
  const names = new Set();
  // Colours only from the `@theme static` block: the plain `:root` also holds
  // one-object colours (`--color-die-ink*`) that are not roles.
  const themeBlock = /@theme[^{]*\{([\s\S]*?)\n\}/.exec(css);
  if (!themeBlock) {
    throw new Error("theme-tokens: no @theme block in index.css");
  }
  const aliases = new Set(DEPRECATED_ALIASES.map((name) => `--color-${name}`));
  for (const [, name] of themeBlock[1].matchAll(/(--[\w-]+)\s*:/g)) {
    if (!name.startsWith("--color-")) continue;
    if (aliases.has(name)) continue;
    if (name.startsWith("--color-connection-")) continue;
    // The language picker's flags (BR, UK, ES): identifiers like the
    // connection marks above, not a themed role, so it is exempt the same
    // way.
    if (name.startsWith("--color-flag-")) continue;
    // Breu's colours: a bot's identity, the same in every theme.
    if (name.startsWith("--color-bot-")) continue;
    names.add(name);
  }
  for (const [, name] of css.matchAll(/(--[\w-]+)\s*:/g)) {
    if (MIRRORED.some((family) => family.test(name))) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Every role token name `design-tokens.ts` lists. Only double-quoted string
 * literals count, so a token named in a doc comment is prose, not a listing.
 * The type ramp is stored as roles rather than tokens, exactly as the page
 * consumes it (`--type-${role}-size`), so it is expanded here.
 */
function tsRoleTokens() {
  const text = readFileSync(TOKENS_TS, "utf8");
  const names = new Set();
  for (const [, name] of text.matchAll(/"(--[\w-]+)"/g)) {
    if (name.startsWith("--color-") || MIRRORED.some((f) => f.test(name))) {
      names.add(name);
    }
  }
  const roles = /export const TYPE_ROLES\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (!roles) {
    throw new Error("theme-tokens: TYPE_ROLES not found in design-tokens.ts");
  }
  const roleNames = [...roles[1].matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
  if (roleNames.length === 0) {
    throw new Error("theme-tokens: TYPE_ROLES is empty");
  }
  for (const role of roleNames) {
    names.add(`--type-${role}-size`);
    names.add(`--type-${role}-leading`);
  }
  if (names.size === 0) {
    throw new Error("theme-tokens: design-tokens.ts listed no tokens");
  }
  return names;
}

/** Both directions of the mirror. Either one non-empty is a failure. */
function auditTokenDrift(css) {
  const inCss = cssRoleTokens(css);
  const inTs = tsRoleTokens();
  return {
    missingFromSheet: [...inCss].filter((name) => !inTs.has(name)).sort(),
    missingFromCss: [...inTs].filter((name) => !inCss.has(name)).sort(),
  };
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
for (const appearance of [
  "harmony",
  "hearth",
  "night",
  "ocean",
  "catppuccin",
  "everforest",
  "retro",
]) {
  const darkSkin = readTokens(
    css,
    new RegExp(
      `:root\\[data-appearance="${appearance}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`,
    ),
  );
  const lightSkin = readTokens(
    css,
    new RegExp(
      `:root\\[data-appearance="${appearance}"\\]\\[data-theme="light"\\]\\s*\\{([\\s\\S]*?)\\n\\}`,
    ),
  );
  if (Object.keys(darkSkin).length > 0) {
    themes[`${appearance}-dark`] = { ...themes.dark, ...darkSkin };
  }
  if (Object.keys(lightSkin).length > 0) {
    themes[`${appearance}-light`] = {
      ...themes.dark,
      ...lightBlock,
      ...darkSkin,
      ...lightSkin,
    };
  }
}

/*
 * Every theme again with the redesign on (data-redesign, docs/redesign/).
 * A look's redesign block is one per brightness, written with `:where()` so
 * it ranks no higher than the look and comes after it; the merge order below
 * is that cascade. Clássico is the look "signal", and it must have both.
 */
function redesignLayer(look, isLight) {
  const selector = isLight
    ? `:root\\[data-redesign\\]\\[data-theme="light"\\]:where\\(\\[data-appearance="${look}"\\]\\)`
    : `:root\\[data-redesign\\]:where\\(\\[data-appearance="${look}"\\]:not\\(\\[data-theme="light"\\]\\)\\)`;
  return readTokens(css, new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`));
}
for (const name of Object.keys(themes)) {
  const isLight = name === "light" || name.endsWith("-light");
  const look = name === "dark" || name === "light" ? "signal" : name.replace(/-(dark|light)$/, "");
  const layer = redesignLayer(look, isLight);
  if (look === "signal" && Object.keys(layer).length === 0) {
    throw new Error(`theme-tokens: no redesign block for Clássico ${isLight ? "light" : "dark"}`);
  }
  themes[`redesign-${name}`] = { ...themes[name], ...layer };
}

const contrastBlock = readTokens(
  css,
  /:root\[data-contrast="more"\]\s*\{([\s\S]*?)\n\}/,
);
const contrastLightBlock = readTokens(
  css,
  /:root\[data-theme="light"\]\[data-contrast="more"\]\s*\{([\s\S]*?)\n\}/,
);
if (Object.keys(contrastBlock).length > 0) {
  for (const [name, tokens] of Object.entries({ ...themes })) {
    const isLight = name.includes("light");
    themes[`${name}-contrast`] = {
      ...tokens,
      ...contrastBlock,
      ...(isLight ? contrastLightBlock : {}),
    };
  }
}

const accentBlock = readTokens(
  css,
  /:root\[data-accent="custom"\]\s*\{([\s\S]*?)\n\}/,
);
const accentLightBlock = readTokens(
  css,
  /:root\[data-theme="light"\]\[data-accent="custom"\]\s*\{([\s\S]*?)\n\}/,
);
function resolveAccentTokens(tokens, hue) {
  const resolved = {};
  for (const [name, value] of Object.entries(tokens)) {
    resolved[name] = value.replaceAll("var(--accent-hue)", String(hue));
  }
  return resolved;
}
if (Object.keys(accentBlock).length > 0) {
  const accentBases = [
    "dark",
    "light",
    "night-dark",
    "harmony-light",
    "retro-light",
    "redesign-dark",
    "redesign-light",
  ];
  for (const hue of [0, 90, 125, 210, 255, 330]) {
    for (const name of accentBases) {
      const tokens = themes[name];
      if (!tokens) {
        continue;
      }
      const isLight = name.includes("light");
      themes[`${name}-accent-${hue}`] = {
        ...tokens,
        ...resolveAccentTokens(accentBlock, hue),
        ...(isLight ? resolveAccentTokens(accentLightBlock, hue) : {}),
      };
    }
  }
}

const contrast = Object.entries(themes).flatMap(([name, tokens]) =>
  auditContrast(tokens, name),
);
const steps = Object.entries(themes).flatMap(([name, tokens]) =>
  auditSteps(tokens, name),
);
const paneOrder = Object.entries(themes).flatMap(([name, tokens]) =>
  auditPaneOrder(tokens, name),
);
const orderFailures = paneOrder.filter((r) => r.pass !== true);
const stepFailures = steps.filter((r) => r.pass === false);
const stepMissing = steps.filter((r) => r.distance === null);
const leaks = auditLeaks();
const uiAliases = auditUiAliases();
const uiStatics = auditUiStatics();
const tokenDrift = auditTokenDrift(css);
const tokenDriftCount =
  tokenDrift.missingFromSheet.length + tokenDrift.missingFromCss.length;

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
  steps: {
    checked: steps.length - stepMissing.length,
    failing: stepFailures.length,
    missingTokens: stepMissing.length,
    results: steps,
  },
  paneOrder: {
    checked: paneOrder.length,
    failing: orderFailures.length,
    results: paneOrder,
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
  uiAliases: {
    count: uiAliases.length,
    results: uiAliases,
  },
  uiStatics: {
    count: uiStatics.length,
    results: uiStatics,
  },
  tokenDrift: {
    count: tokenDriftCount,
    ...tokenDrift,
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
console.log(
  `steps:    ${steps.length - stepMissing.length - stepFailures.length}/${steps.length - stepMissing.length} pass` +
    (stepMissing.length ? `, ${stepMissing.length} unmeasured` : ""),
);
for (const failure of stepFailures) {
  console.log(
    `  FAIL    ${failure.distance} < ${failure.floor} — ${failure.theme}, ${failure.label}`,
  );
}
console.log(`order:    ${paneOrder.length - orderFailures.length}/${paneOrder.length} pass`);
for (const failure of orderFailures) {
  console.log(`  FAIL    ${failure.theme}, ${failure.label} ${JSON.stringify(failure.values ?? [])}`);
}
console.log(`leaks:    ${leaks.length} colour literal(s) outside the token layer`);
for (const entry of report.leaks.byFile.slice(0, 10)) {
  console.log(`  ${String(entry.count).padStart(3)}  ${entry.file}`);
}
console.log(
  `ui:       ${uiAliases.length} deprecated alias use(s) in components/ui`,
);
for (const alias of uiAliases.slice(0, 10)) {
  console.log(`  ${alias.file}:${alias.line}  ${alias.alias}`);
}
console.log(
  `ui:       ${uiStatics.length} static radius/duration/shadow utility(s) in components/ui`,
);
for (const hit of uiStatics.slice(0, 10)) {
  console.log(`  ${hit.file}:${hit.line}  ${hit.utility}`);
}
console.log(`tokens:   ${tokenDriftCount} name(s) out of sync with design-tokens.ts`);
for (const name of tokenDrift.missingFromSheet) {
  console.log(`  ${name} defined in index.css, not on the token sheet`);
}
for (const name of tokenDrift.missingFromCss) {
  console.log(`  ${name} on the token sheet, not defined in index.css`);
}

console.log(`\nwrote ${relative(CLIENT, outPath)}`);

// A ratchet, not a gate: BENCH_MAX_LEAKS pins the current number so the count
// can only go down. Contrast failures always fail.
const maxLeaks = process.env.BENCH_MAX_LEAKS;
// The ui/ alias count is already zero, so it is pinned there by default rather
// than by an env var somebody has to remember to set. BENCH_MAX_UI_ALIASES is
// an escape hatch for a half-finished migration, not a setting.
const maxUiAliases = Number(process.env.BENCH_MAX_UI_ALIASES ?? 0);
// Same shape, same reasoning: BENCH_MAX_UI_STATICS exists for a migration in
// progress, and the number it defaults to is zero.
const maxUiStatics = Number(process.env.BENCH_MAX_UI_STATICS ?? 0);
if (
  failures.length > 0 ||
  stepFailures.length > 0 ||
  stepMissing.length > 0 ||
  orderFailures.length > 0
) {
  process.exitCode = 1;
} else if (maxLeaks !== undefined && leaks.length > Number(maxLeaks)) {
  console.error(
    `\nleak ratchet: ${leaks.length} > ${maxLeaks}. Use a token instead of a literal.`,
  );
  process.exitCode = 1;
} else if (uiAliases.length > maxUiAliases) {
  console.error(
    `\nui alias ratchet: ${uiAliases.length} > ${maxUiAliases}. ` +
      "Use the role name from the alias table in index.css.",
  );
  process.exitCode = 1;
} else if (uiStatics.length > maxUiStatics) {
  console.error(
    `\nui static-utility ratchet: ${uiStatics.length} > ${maxUiStatics}. ` +
      "Name a token: rounded-[var(--radius-card)], not rounded-lg.",
  );
  process.exitCode = 1;
} else if (tokenDriftCount > 0) {
  console.error(
    `\ntoken drift: ${tokenDriftCount} name(s). ` +
      "index.css and src/lib/design-tokens.ts must list the same role tokens.",
  );
  process.exitCode = 1;
}
