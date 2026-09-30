import { isDesktopApp } from "@/lib/desktop";

/** The public address. The same one the legal pages print. */
export const CONTACT_EMAIL = "contato@pqp.gg";
export const GITHUB_ISSUES_URL = "https://github.com/rafaelcg/pqp/issues";

/** What the diagnostics block may carry. Nothing else is ever added to a mail. */
export interface HelpDiagnostics {
  appVersion: string;
  platform: string;
  browser: string;
  locale: string;
}

/** `Chrome`, `Firefox`, `Safari`, `Edge`, `Opera` or `Other`. Family only, no version. */
export function browserFamily(userAgent: string): string {
  if (/Edg(e|A|iOS)?\//.test(userAgent)) return "Edge";
  if (/OPR\/|Opera/.test(userAgent)) return "Opera";
  if (/Firefox\/|FxiOS\//.test(userAgent)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Other";
}

/** `Windows`, `macOS`, `Android`, `iOS`, `Linux` or `Other`. Family only. */
export function osFamily(userAgent: string): string {
  if (/Android/.test(userAgent)) return "Android";
  if (/iPhone|iPad|iPod/.test(userAgent)) return "iOS";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Mac OS X|Macintosh/.test(userAgent)) return "macOS";
  if (/Linux|X11/.test(userAgent)) return "Linux";
  return "Other";
}

/**
 * Non-sensitive facts for the prefilled mail. Deliberately narrow: no token,
 * no user id, no address, no path, no call state. The person sees all of it
 * in their mail client and can delete it before sending.
 */
export function collectHelpDiagnostics(
  env: { userAgent?: string; locale?: string; appVersion?: string; desktop?: boolean } = {},
): HelpDiagnostics {
  const userAgent =
    env.userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  const fromApp =
    env.locale ?? (typeof document !== "undefined" ? document.documentElement.lang : "");
  const fromBrowser = typeof navigator !== "undefined" ? navigator.language : "";
  const version = (env.appVersion ?? import.meta.env.VITE_FARO_APP_VERSION ?? "")
    .trim()
    .slice(0, 12);
  const desktop = env.desktop ?? isDesktopApp();
  return {
    appVersion: version || "dev",
    platform: `${desktop ? "desktop app" : "web"}, ${osFamily(userAgent)}`,
    browser: browserFamily(userAgent),
    locale: (fromApp || fromBrowser || "").trim().slice(0, 16),
  };
}

export interface MailtoCopy {
  subject: string;
  /** Text above the diagnostics, where the person writes. */
  intro: string;
  diagnosticsHeading: string;
  labels: { app: string; platform: string; browser: string; language: string };
}

/** A `mailto:` link with subject and body encoded. */
export function buildContactMailto(diagnostics: HelpDiagnostics, copy: MailtoCopy): string {
  const body = [
    copy.intro,
    "",
    "",
    "---",
    copy.diagnosticsHeading,
    `${copy.labels.app}: ${diagnostics.appVersion}`,
    `${copy.labels.platform}: ${diagnostics.platform}`,
    `${copy.labels.browser}: ${diagnostics.browser}`,
    `${copy.labels.language}: ${diagnostics.locale}`,
  ].join("\n");
  const query = `subject=${encodeURIComponent(copy.subject)}&body=${encodeURIComponent(body)}`;
  return `mailto:${CONTACT_EMAIL}?${query}`;
}
