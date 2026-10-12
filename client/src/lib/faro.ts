/**
 * Grafana Faro (frontend error + RUM tracking), initialised ONLY on the hosted
 * pqp.gg build and inert everywhere else.
 *
 * WHY THIS IS GATED, and how it stays out of a self-host. Same reasoning as the
 * Umami and Google Ads tags (see `client/vite.config.ts` and
 * `client/src/lib/google-ads-tag.ts`): pqp is AGPL and meant to be self-hosted,
 * and a self-hoster must not inherit OUR observability endpoint. The gate is
 * `VITE_FARO_URL`: `initFaro` reads it and does nothing at all when it is unset
 * or blank — no `initializeFaro`, so no network request, no `window` global, no
 * session cookie, nothing. Only the pqp.gg Pages build sets it (a repository
 * VARIABLE, not a secret — the collector URL carries a write-only ingest key
 * that ships in any client bundle regardless), wired in
 * `.github/workflows/deploy-web.yml` next to the other `VITE_*` names.
 *
 * The SDK itself is Apache-2.0 and is bundled unconditionally (that is what
 * lets the build-time source-map upload in `vite.config.ts` de-obfuscate a
 * stack trace), but bundled is not running: with no URL it never initialises,
 * so a self-host ships dormant code that talks to nobody. The one property that
 * matters — a self-hoster's users are never reported to us — holds by the URL
 * being empty.
 *
 * WHAT IT CAPTURES. `getWebInstrumentations()` wires uncaught errors and
 * unhandled promise rejections, console errors, and Web Vitals, plus session
 * and view tracking. Tracing (`@grafana/faro-web-tracing`) is deliberately NOT
 * included: errors and Web Vitals are the priority, and OTEL tracing would add
 * meaningful bundle weight for a signal we are not yet using.
 *
 * NO PII. This app never calls `faro.api.setUser`, so no user id, email or
 * handle is ever attached; Faro's own session id is a random opaque value, not
 * an account identifier. If a user is ever attached in future, use an opaque id
 * (a hash), never the Clerk id or an email — but the simplest guarantee is the
 * one in force today: attach nobody.
 */

import {
  getWebInstrumentations,
  initializeFaro,
  type Faro,
} from "@grafana/faro-web-sdk";

/** The three build vars this reads. Named as a type so both halves are one place. */
export interface FaroEnv {
  /** The Faro collector URL. Empty/unset on every non-pqp.gg build → inert. */
  VITE_FARO_URL?: string;
  /** App name in Faro. Defaults to `pqp-web`. */
  VITE_FARO_APP_NAME?: string;
  /** App version — the deployed commit SHA on the hosted build. Defaults to `dev`. */
  VITE_FARO_APP_VERSION?: string;
  /** Share of sessions reported, 0 to 1. Defaults to `DEFAULT_SESSION_SAMPLE_RATE`. */
  VITE_FARO_SESSION_SAMPLE_RATE?: string;
}

/**
 * Share of browser sessions that report anything at all. Sampling is per
 * session in Faro: a sampled-out session sends nothing (errors included), a
 * sampled-in one sends everything, so a session is never half there.
 *
 * WHY NOT 1. The Grafana Cloud stack is on the free tier: 50,000 frontend
 * sessions a month, and past that the collector answers 402 to EVERY request
 * until the month turns over. October 2026 used 50,000 by the 9th (about 6,300
 * sessions a day, most of them desktop windows that stay open and roll over to a
 * new session after 15 idle minutes), and from then on Faro was blind:
 * `grafanacloud_org_fe_o11y_billable_sessions` flat at the cap, the collector
 * answering 402, nothing in Loki. At 0.2 a month is about 38,000 sessions,
 * which leaves room for a busy weekend. Raise it with the repository variable
 * `VITE_FARO_SESSION_SAMPLE_RATE` (a build-time value) if the plan changes.
 */
export const DEFAULT_SESSION_SAMPLE_RATE = 0.2;

/** A rate from the build variable, or the default for anything unset or unusable. */
export function parseSessionSampleRate(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) {
    return DEFAULT_SESSION_SAMPLE_RATE;
  }
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1
    ? rate
    : DEFAULT_SESSION_SAMPLE_RATE;
}

export interface FaroConfig {
  url: string;
  appName: string;
  appVersion: string;
  environment: string;
  sessionSampleRate: number;
}

/**
 * The configuration for a given environment, or null when this build carries no
 * Faro URL — which is every self-hosted and local build. Pure and side-effect
 * free so the gate is unit-testable (see `faro.test.ts`), the same arrangement
 * `google-ads-tag.ts` uses for the same reason.
 */
export function resolveFaroConfig(env: FaroEnv): FaroConfig | null {
  const url = env.VITE_FARO_URL?.trim();
  if (!url) {
    return null;
  }
  return {
    url,
    appName: env.VITE_FARO_APP_NAME?.trim() || "pqp-web",
    appVersion: env.VITE_FARO_APP_VERSION?.trim() || "dev",
    environment: "production",
    sessionSampleRate: parseSessionSampleRate(env.VITE_FARO_SESSION_SAMPLE_RATE),
  };
}

/**
 * Faro event names that are never sent. `faro.performance.resource` is one
 * event per completed browser request (fetch, script, image): every API call,
 * Clerk token refresh and sound file. Measured 2026-09-29 on Grafana Loki it was
 * 99.6% of all Faro bytes (801 MB of 805 MB of events in 24 h, 463k lines at
 * ~1.7 KB each), about 99% of everything in Loki, and nothing reads it: the
 * API's own logs and metrics time the same requests, and no dashboard or alert
 * queries it. Errors, console errors, Web Vitals (`kind=measurement`), the
 * navigation timing and session events are all kept.
 */
const DROPPED_EVENT_NAMES = new Set(["faro.performance.resource"]);

/** `beforeSend` hook: drop the noisy event names, pass everything else through untouched. */
export function dropNoisyItems<T extends { type: string; payload: unknown }>(
  item: T,
): T | null {
  if (item.type === "event") {
    const name = (item.payload as { name?: unknown } | null)?.name;
    if (typeof name === "string" && DROPPED_EVENT_NAMES.has(name)) {
      return null;
    }
  }
  return item;
}

let faro: Faro | null = null;

export interface InitFaroDeps {
  /** Defaults to `import.meta.env`; injectable so a test need not touch the bundle env. */
  env?: FaroEnv;
  /** Defaults to the real `initializeFaro`; injectable so a test asserts the call without a network. */
  initialize?: typeof initializeFaro;
}

/**
 * Start Faro if (and only if) this build was given a collector URL. Idempotent:
 * a second call returns the same instance rather than initialising twice, which
 * `initializeFaro` warns about. Returns the instance, or null when inert.
 */
export function initFaro(deps: InitFaroDeps = {}): Faro | null {
  const { env = import.meta.env as unknown as FaroEnv, initialize = initializeFaro } =
    deps;
  if (faro) {
    return faro;
  }
  const config = resolveFaroConfig(env);
  if (!config) {
    // Self-host / local build: no URL, so nothing runs. This is the whole gate.
    return null;
  }
  faro = initialize({
    url: config.url,
    app: {
      name: config.appName,
      version: config.appVersion,
      environment: config.environment,
    },
    // Errors (uncaught + unhandled rejection), console errors, and Web Vitals,
    // plus session/view tracking. No tracing (see the file header).
    instrumentations: getWebInstrumentations(),
    // Per-request resource timings are dropped (see DROPPED_EVENT_NAMES).
    beforeSend: dropNoisyItems,
    // Only a share of sessions report, to stay inside the plan's monthly
    // session allowance (see DEFAULT_SESSION_SAMPLE_RATE).
    sessionTracking: { samplingRate: config.sessionSampleRate },
    // No `user` is set: this app attaches no account identity to telemetry.
  });
  return faro;
}

/**
 * This tab's Faro session id, or null when Faro is off (every self-host, and
 * local dev). The feedback box attaches it so the operator can open the
 * errors around the moment a bug was reported. It is Faro's own random id and
 * identifies a browser session, not an account.
 */
export function faroSessionId(): string | null {
  try {
    return faro?.api.getSession()?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Push a named event with string attributes. A no-op when Faro is off (every
 * self-host, local dev) or the push throws: telemetry never breaks the app.
 */
export function reportFaroEvent(name: string, attributes: Record<string, string> = {}): void {
  try {
    faro?.api.pushEvent(name, attributes);
  } catch {
    // Nothing to do: losing one event is better than an error in the caller.
  }
}

/** Test seam: forget the instance so a later `initFaro` runs again. */
export function resetFaroForTests(): void {
  faro = null;
}
