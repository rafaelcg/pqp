/**
 * "You just landed in here" — remembered per server, on this device.
 *
 * WHAT IT IS FOR. Joining an invite drops you straight into `#general`, and
 * `#general` on a young server is the same screen its owner sees when they made
 * it: a heading that says "Start the thread" and two lines of markdown syntax.
 * Nothing on it names the server you just joined, says who else is in it, or
 * suggests the one action that makes a stranger into a member — saying
 * something. So the first thing an invited person meets is a cold transcript and
 * a blinking cursor, and the most common next move is to close the tab.
 *
 * WHY LOCALSTORAGE AND NOT A PREFERENCE. This is the only piece of first-run
 * state in the app that is deliberately device-local, so the reasoning matters.
 * It is keyed *per server*, and preferences are one JSONB blob that merges
 * shallowly and can never have a key removed — so storing it there would grow
 * the blob by one permanent key per server anybody ever joins, on the object that
 * rides down with every `/api/me`. It is also worth nothing on a second device:
 * a banner orienting you in a room you joined last week on your laptop is not
 * orientation, it is clutter. And it must survive a page load with no round trip,
 * because it has to be right on the very first paint of the channel.
 *
 * Every function here is safe when storage is denied (Safari private mode, an
 * embedded webview). Failing closed means the banner does not show, which is the
 * correct way to fail: a missing hint costs less than a hint that cannot be
 * dismissed.
 */

const KEY = "pqp:arrived-servers";

/**
 * Server ids this device has already been welcomed to.
 *
 * Tolerates every shape the key could hold, because it is user-writable storage:
 * absent, invalid JSON, an object where an array was expected, an array with
 * numbers in it. Anything unreadable is treated as "no record", which shows one
 * extra banner at worst.
 */
export function readArrivals(storage: Pick<Storage, "getItem"> | null): string[] {
  if (!storage) {
    return [];
  }
  try {
    const raw = storage.getItem(KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((one): one is string => typeof one === "string");
  } catch {
    return [];
  }
}

/**
 * Has this device already welcomed the account into this server?
 *
 * A null id is "no server open", which is not a server anybody can be welcomed
 * to — answering `true` keeps the caller from having to null-check before asking.
 */
export function hasArrived(
  storage: Pick<Storage, "getItem"> | null,
  serverId: string | null,
): boolean {
  if (!serverId) {
    return true;
  }
  return readArrivals(storage).includes(serverId);
}

/**
 * Record the welcome, and cap the list.
 *
 * The cap is not paranoia about size — it is what stops a key that only ever
 * grows from sitting in localStorage forever. Newest first and truncated, so the
 * ids that fall off the end are the oldest joins, which are the ones least
 * likely to ever need the answer again. Dropping one costs a single repeated
 * banner years later.
 */
export function rememberArrival(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  serverId: string,
  limit = 50,
): string[] {
  const next = [serverId, ...readArrivals(storage).filter((one) => one !== serverId)]
    .slice(0, limit);
  if (storage) {
    try {
      storage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Quota or a denied store. The banner has already been shown and closed
      // for this session; the worst case is it returns on the next load.
    }
  }
  return next;
}

/** The browser's store, or null where there is not one to use. */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
