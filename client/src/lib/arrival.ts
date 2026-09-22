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

// ------------------------------------------------------------ which banner

/**
 * What the banner says, chosen from what is on screen.
 *
 * - `owner`: the account made this server in this session and nobody else is
 *   in it yet. The one thing that changes that is the invite, so the banner
 *   carries a copy button instead of advice about saying hi to nobody.
 * - `text`: a text channel is open. Say something in it.
 * - `voice`: a voice channel is open and they are not in the call. The strip
 *   says to press the button that is right there; once they are in the call it
 *   has nothing left to say and goes (`null`).
 * - `home`: the community home (Baú) is open, which is where a server with it
 *   on lands a new member. It names a text channel to start in.
 * - `generic`: anything else (a watch party, a forum). The old copy.
 */
export type ArrivalVariant = "owner" | "text" | "voice" | "home" | "generic";

export type ArrivalSurface = "text" | "voice" | "home" | "other";

export function arrivalVariant({
  createdHere,
  memberCount,
  surface,
  inCall,
}: {
  /** This account created the server during this session. */
  createdHere: boolean;
  /** Members as the app knows them. Null while the list has not loaded. */
  memberCount: number | null;
  surface: ArrivalSurface;
  /** Connected to the call of the voice channel that is open. */
  inCall: boolean;
}): ArrivalVariant | null {
  // An unknown count is treated as alone: the owner just made the room, and
  // the list loading a beat later must not flash the member copy first.
  if (createdHere && (memberCount === null || memberCount <= 1)) {
    return "owner";
  }
  if (createdHere) {
    // They made it and somebody came. Nothing left to point at.
    return null;
  }
  switch (surface) {
    case "text":
      return "text";
    case "voice":
      return inCall ? null : "voice";
    case "home":
      return "home";
    default:
      return "generic";
  }
}

// ------------------------------------------------------------ one burst

const CONFETTI_KEY = "pqp:confetti-spent";

/**
 * Confetti fires once per account per tab session, wherever the arrival
 * happens. Session storage because the moment is this visit: a reload two
 * seconds later must not re-run it, and next week's visit is not an arrival.
 */
export function confettiSpent(
  storage: Pick<Storage, "getItem"> | null,
  userId: string,
): boolean {
  if (!storage) {
    return true;
  }
  try {
    return storage.getItem(CONFETTI_KEY) === userId;
  } catch {
    return true;
  }
}

export function spendConfetti(
  storage: Pick<Storage, "setItem"> | null,
  userId: string,
): void {
  try {
    storage?.setItem(CONFETTI_KEY, userId);
  } catch {
    // Denied. At worst a second burst on a reload.
  }
}

/** The tab's session store, or null where there is not one to use. */
export function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
