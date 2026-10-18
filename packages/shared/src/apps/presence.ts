import { APP_REQUIRED_LOCALES, appString, type AppLocale, type AppManifest } from "./manifest.js";

/**
 * The presence line of somebody who is in an app ("Raf tá na Locadora").
 * Computed on the client from the manifest's translated template and the
 * person's display name; nothing here is sent or stored.
 */

export const APP_PRESENCE_MAX_NAME_LENGTH = 32;

// C0 and DEL, C1, the Unicode line and paragraph separators, and the bidi
// override and isolate characters. A display name is typed by a stranger and
// lands inside a sentence we wrote, so it must not be able to reorder the text
// around it or split the line.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

const PLACEHOLDER = "{name}";

export interface FormatAppPresenceOptions {
  /** Longest name kept, counting the trailing ellipsis. Default 32. */
  maxNameLength?: number;
  /** Used when nothing is left of the name after cleaning. Default "?". */
  fallbackName?: string;
}

function cleanName(raw: string, maxLength: number): string {
  const cleaned = raw.replace(UNSAFE_NAME_CHARS, "").trim();
  const chars = Array.from(cleaned);
  if (chars.length <= maxLength) return cleaned;
  return `${chars
    .slice(0, Math.max(1, maxLength) - 1)
    .join("")
    .trimEnd()}…`;
}

/**
 * Put `displayName` into the template's single `{name}`. The substitution is a
 * plain splice, never `String.prototype.replace` with a string (so `$&` and
 * `$1` in a name stay literal), and it runs once (a name that itself contains
 * `{name}` stays literal).
 */
export function formatAppPresence(
  template: string,
  displayName: string,
  opts: FormatAppPresenceOptions = {},
): string {
  const at = template.indexOf(PLACEHOLDER);
  if (at === -1) return template;
  const maxLength = opts.maxNameLength ?? APP_PRESENCE_MAX_NAME_LENGTH;
  const name = cleanName(displayName, maxLength) || (opts.fallbackName ?? "?");
  return template.slice(0, at) + name + template.slice(at + PLACEHOLDER.length);
}

/**
 * The locale to read a manifest's strings in: the exact one, then its base
 * language (`pt` and `pt-PT` read pt-BR, `es-*` reads es, `en-*` reads en),
 * then English.
 */
export function resolveAppLocale(locale: string): AppLocale {
  const normalized = locale.trim().replace(/_/g, "-").toLowerCase();
  const exact = APP_REQUIRED_LOCALES.find((candidate) => candidate.toLowerCase() === normalized);
  if (exact) return exact;
  const base = normalized.split("-")[0];
  if (base === "pt") return "pt-BR";
  if (base === "es") return "es";
  return "en";
}

export function resolveAppPresence(
  manifest: AppManifest,
  locale: string,
  displayName: string,
): { phrase: string; short: string } {
  const resolved = resolveAppLocale(locale);
  const read = (key: string): string =>
    appString(manifest.i18n[resolved], key) ?? appString(manifest.i18n.en, key) ?? "";
  return {
    phrase: formatAppPresence(read(manifest.presence.phrase), displayName),
    short: read(manifest.presence.short),
  };
}
