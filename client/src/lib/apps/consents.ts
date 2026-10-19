import { useSyncExternalStore } from "react";
import { appConsentSchema, resolveAppLocale, type AppConsent } from "@pqp/shared";
import { apiFetch } from "@/lib/api";

/**
 * WHAT THIS PERSON ACCEPTED, per app (`GET /api/me/app-consents`, mock 04).
 *
 * The join sheet shows the first time per app per person; after that Entrar
 * goes straight in. "After that" is read from here: a consent that is on file
 * and not STALE (a newer version of the app asking for something different)
 * skips the sheet. Whatever cannot be read (the list has not landed, the
 * request failed) is "not accepted", which means the sheet shows: asking twice
 * is the safe way to be wrong.
 *
 * Module-level and subscribed to with `useAppConsents`, because the join
 * controller (which has no component to hold it), Configurações and the nav
 * entry all read the same list, and a revoke in one has to reach the others.
 */

export type { AppConsent };

export interface AppConsentsState {
  /** The list as last read; null until a read lands. */
  consents: readonly AppConsent[] | null;
  loading: boolean;
}

let state: AppConsentsState = { consents: null, loading: false };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function commit(next: AppConsentsState): void {
  state = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function getAppConsentsState(): AppConsentsState {
  return state;
}

export function useAppConsents(): AppConsentsState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
    () => state,
  );
}

export async function fetchAppConsents(): Promise<AppConsent[]> {
  const raw = await apiFetch<{ consents?: unknown }>("/api/me/app-consents");
  const rows = Array.isArray(raw?.consents) ? raw.consents : [];
  const out: AppConsent[] = [];
  for (const row of rows) {
    const parsed = appConsentSchema.safeParse(row);
    if (parsed.success) {
      out.push(parsed.data);
    }
  }
  return out;
}

/** Read the list once at a time. A failed read keeps what was there. */
export function loadAppConsents(): Promise<void> {
  if (!inflight) {
    commit({ ...state, loading: true });
    inflight = fetchAppConsents()
      .then((consents) => {
        commit({ consents, loading: false });
      })
      .catch(() => {
        commit({ ...state, loading: false });
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** The list if it has landed, reading it first if it has not. */
export async function ensureAppConsents(): Promise<readonly AppConsent[] | null> {
  if (state.consents === null) {
    await loadAppConsents();
  }
  return state.consents;
}

/** Record the acceptance on the server, then on this tab's list. Rejects when the server did not take it. */
export async function acceptApp(appId: string, identityGranted: boolean): Promise<void> {
  await apiFetch<unknown>(`/api/apps/${encodeURIComponent(appId)}/consent`, {
    method: "POST",
    body: JSON.stringify({ identityGranted }),
  });
  // The list is read again rather than patched: the server owns the accepted
  // version and the capability diff.
  await loadAppConsents();
}

/** Take the acceptance back: the next Entrar shows the sheet again. */
export async function revokeApp(appId: string): Promise<void> {
  await apiFetch<unknown>(`/api/apps/${encodeURIComponent(appId)}/consent`, {
    method: "DELETE",
  });
  const before = state.consents;
  if (before) {
    commit({ ...state, consents: before.filter((one) => one.appId !== appId) });
  }
  await loadAppConsents();
}

/** Whether `appId` has an acceptance on file that still covers what the app asks. */
export function hasValidConsent(
  consents: readonly AppConsent[] | null,
  appId: string,
): boolean {
  return consents?.some((one) => one.appId === appId && !one.stale) === true;
}

/** The app's name in this person's language, then English, then the id. */
export function consentName(consent: AppConsent, locale: string): string {
  return consent.names[resolveAppLocale(locale)] ?? consent.names.en ?? consent.appId;
}

/** The app's one-line notice in this person's language, when it has one. */
export function consentNotice(consent: AppConsent, locale: string): string | null {
  return consent.notices[resolveAppLocale(locale)] ?? consent.notices.en ?? null;
}

export function resetAppConsentsForTests(): void {
  inflight = null;
  state = { consents: null, loading: false };
  for (const listener of [...listeners]) {
    listener();
  }
}
