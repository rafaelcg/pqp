/**
 * Web Push — the client half. Subscribing this browser, tearing it down, and
 * knowing when the option can honestly be offered.
 *
 * Everything permission-shaped here must run from a user gesture: the settings
 * modal's button is the only caller of `enablePush`, and nothing in this
 * module runs at startup. That is not politeness — Chrome punishes pages that
 * prompt unprompted, and on iOS a push subscription outside a user gesture is
 * simply refused.
 *
 * iOS is the platform this feature mostly exists for and the one with the
 * sharpest edge: Safari only exposes `PushManager` inside an *installed*
 * home-screen web app (16.4+). In a plain tab the API is absent, so the
 * honest answer there is "install first", not a broken button — which is what
 * `resolvePushAvailability` is for.
 */

import { apiFetch } from "./api";

export interface PushConfig {
  /** False when the server has no VAPID keys — the whole feature is off. */
  enabled: boolean;
  publicKey: string | null;
  /** Whether this account lets DM pushes name the sender. Default false. */
  dmDetails: boolean;
}

export function getPushConfig(): Promise<PushConfig> {
  return apiFetch<PushConfig>("/api/push/config");
}

export function setPushDmDetails(
  dmDetails: boolean,
): Promise<{ dmDetails: boolean }> {
  return apiFetch<{ dmDetails: boolean }>("/api/push/settings", {
    method: "PATCH",
    body: JSON.stringify({ dmDetails }),
  });
}

// ------------------------------------------------------------- availability

export type PushAvailability =
  /** This browser will never do push (or has no service worker registered). */
  | "unsupported"
  /** iOS Safari in a tab: push exists only inside the installed PWA. */
  | "needs-install"
  | "available";

export interface PushEnvironment {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  isIos: boolean;
  standalone: boolean;
}

/**
 * Pure so the matrix is testable without a DOM. The iOS distinction matters
 * because "unsupported" and "install the app first" demand opposite UI: one
 * is a dead end, the other is the single most useful sentence on the screen.
 */
export function resolvePushAvailability(env: PushEnvironment): PushAvailability {
  if (env.isIos && !env.standalone) {
    // In-tab iOS Safari reports no PushManager at all; the install is what
    // creates the capability, so say so rather than "unsupported".
    return "needs-install";
  }
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) {
    return "unsupported";
  }
  return "available";
}

export function detectPushEnvironment(): PushEnvironment {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {
      hasServiceWorker: false,
      hasPushManager: false,
      hasNotification: false,
      isIos: false,
      standalone: false,
    };
  }
  // iPadOS 13+ masquerades as macOS; the touch-point check is the accepted tell.
  const isIos =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as { standalone?: boolean }).standalone === true;
  return {
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
    isIos,
    standalone,
  };
}

export function getPushAvailability(): PushAvailability {
  return resolvePushAvailability(detectPushEnvironment());
}

// ---------------------------------------------------------------- keys

/**
 * `applicationServerKey` wants raw bytes; the server hands out the key in the
 * URL-safe base64 VAPID keys are generated in. Chrome accepts the string form,
 * Safari does not, so everything goes through the bytes.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

// ------------------------------------------------------------ subscription

/**
 * `getRegistration`, never `serviceWorker.ready`: in dev (and in any build
 * where the worker failed to register) `ready` is a promise that simply never
 * settles, and an await that never returns is a hang, not an answer.
 */
async function getRegistrationOrNull(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) {
    return null;
  }
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  const registration = await getRegistrationOrNull();
  if (!registration) {
    return null;
  }
  try {
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

export type EnablePushResult =
  | "enabled"
  /** The user said no (or already had); the page cannot ask again. */
  | "denied"
  /** No worker / no server keys / subscribe refused — nothing to retry here. */
  | "unavailable";

/**
 * Subscribe this browser and register the subscription with the API.
 * MUST be called from a user gesture — see the module comment.
 */
export async function enablePush(): Promise<EnablePushResult> {
  if (getPushAvailability() !== "available") {
    return "unavailable";
  }
  const config = await getPushConfig();
  if (!config.enabled || !config.publicKey) {
    return "unavailable";
  }
  const registration = await getRegistrationOrNull();
  if (!registration) {
    return "unavailable";
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return "denied";
  }

  let subscription: PushSubscription;
  try {
    subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        // Required — every push must raise a visible notification, which is
        // also what the service worker's push handler guarantees.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(
          config.publicKey,
        ) as unknown as BufferSource,
      }));
  } catch {
    // Safari inside a just-installed PWA can refuse the first attempt; the
    // caller renders this as "couldn't subscribe", not as a crash.
    return "unavailable";
  }

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    return "unavailable";
  }
  try {
    await apiFetch("/api/push/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      }),
    });
  } catch (error) {
    // The server never learned about this subscription, so nothing will ever
    // arrive on it — keeping it would show "on" while delivering nothing.
    await subscription.unsubscribe().catch(() => {});
    throw error;
  }
  return "enabled";
}

/**
 * Tear down both halves. Server first: once the row is gone nothing new is
 * sent, so a failure to unsubscribe locally costs a dead subscription the
 * vendor will eventually 410, not a phantom notification.
 */
export async function disablePush(): Promise<void> {
  const subscription = await getCurrentPushSubscription();
  if (!subscription) {
    return;
  }
  try {
    await apiFetch(
      `/api/push/subscriptions?endpoint=${encodeURIComponent(subscription.endpoint)}`,
      { method: "DELETE" },
    );
  } catch {
    // The 410 prune on the next send is the backstop; still unsubscribe.
  }
  await subscription.unsubscribe().catch(() => {});
}
