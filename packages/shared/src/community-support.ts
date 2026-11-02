/**
 * A community's SUPPORT link: where a creator says "this is where you pay me".
 *
 * Option A of the Baú creator hub (pqp never touches the money): the locked VIP
 * card sends a fan to the creator's OWN rail, and staff grant the VIP cargo by
 * hand afterwards. So this file is only validation. Nothing here fetches, pings
 * or resolves anything: an https link is checked against a host allowlist, and
 * a Pix key or "copia e cola" is TEXT that gets stored and copied, never turned
 * into a URL and never opened.
 *
 * It lives apart from `communities.ts` because it has no dependency on the rest
 * of that file, and because the allowlist is the one list people will want to
 * extend: one string in `COMMUNITY_SUPPORT_HOSTS`, one case in the test.
 */

/** Same cap as every other official link. */
const SUPPORT_URL_MAX_LENGTH = 500;

/**
 * A Pix "copia e cola" string. The EMV payload a bank app generates is well
 * under 400 characters for a static key; 600 leaves room for a long merchant
 * name and a reference without letting this become a free text box.
 */
export const COMMUNITY_SUPPORT_PIX_MAX_LENGTH = 600;

/**
 * THE ALLOWLIST. Hosts a `support` link may point at: the places a creator is
 * actually paid. Matching is exact or a subdomain (`creator.apoia.se` yes,
 * `apoia.se.evil.com` no), after dropping `www.`.
 *
 * Why an allowlist and not "any https" like the other chips: this link sits on
 * a card whose whole job is to send a fan to a payment page, so an account that
 * was taken over, or a moderator holding Manage Server who turns out to be a
 * bad actor, must not be able to aim it at a lookalike.
 *
 * Kick, Twitch and YouTube are here because that is where subs and memberships
 * live. PayPal is `paypal.me` only, not `paypal.com`, which is every phishing
 * page's favourite path.
 */
export const COMMUNITY_SUPPORT_HOSTS: readonly string[] = [
  "livepix.gg",
  "apoia.se",
  "patreon.com",
  "ko-fi.com",
  "buymeacoffee.com",
  "cafecito.app",
  "catarse.me",
  "kick.com",
  "twitch.tv",
  "youtube.com",
  "youtu.be",
  "paypal.me",
  "mercadopago.com.br",
  "mercadopago.com.ar",
  "mercadopago.com.mx",
  "mercadopago.com.co",
  "mercadopago.cl",
  "mercadopago.com.pe",
  "mercadopago.com.uy",
  "mpago.la",
  "mpago.li",
  "picpay.me",
  "streamelements.com",
  "streamlabs.com",
];

function bareHost(hostname: string): string {
  return hostname.replace(/^www\./, "").toLowerCase();
}

export function isCommunitySupportHost(hostname: string): boolean {
  const host = bareHost(hostname);
  return COMMUNITY_SUPPORT_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

/**
 * A host on the list is not a destination on the list: YouTube's
 * `/redirect?q=https://elsewhere` and `/attribution_link?u=...` bounce to any
 * address. Refused outright, and so is any link that carries another URL in its
 * query or fragment, which is what every open redirect needs. A payment page
 * has no reason to.
 */
function isOpenRedirect(url: URL): boolean {
  if (/^\/(redirect|attribution_link)(\/|$)/i.test(url.pathname)) {
    return true;
  }
  const carriesUrl = (value: string): boolean => {
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // Malformed escapes: judge the raw text.
    }
    return /(^|[^a-z0-9])(https?:)?\/\/|:\/\/|^https?%3a/i.test(decoded);
  };
  for (const value of url.searchParams.values()) {
    if (carriesUrl(value)) {
      return true;
    }
  }
  return carriesUrl(url.hash.slice(1));
}

/**
 * An https URL on the allowlist, normalised by `URL`, or null. No credentials,
 * no other scheme, no look-alike host.
 */
export function parseCommunitySupportUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > SUPPORT_URL_MAX_LENGTH) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.username || url.password) {
      return null;
    }
    if (!isCommunitySupportHost(url.hostname)) {
      return null;
    }
    if (isOpenRedirect(url)) {
      return null;
    }
    // `URL` may lengthen what was typed (percent-encoding): the stored form is
    // what the column and the schema cap.
    const normalised = url.toString();
    return normalised.length > SUPPORT_URL_MAX_LENGTH ? null : normalised;
  } catch {
    return null;
  }
}

/**
 * CRC16/CCITT-FALSE (poly 0x1021, init 0xFFFF), the checksum the Pix BR Code
 * ends with. Four uppercase hex digits.
 */
export function pixCrc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i += 1) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Is this a Pix "copia e cola"? The BR Code is an EMV string that starts with
 * the format indicator `000201`, names the `BR.GOV.BCB.PIX` scheme, and ends
 * with `6304` plus its own CRC. Checking the CRC is what catches the usual
 * mistake, a paste that lost its last characters.
 */
export function isPixCopiaECola(text: string): boolean {
  if (text.length < 30 || text.length > COMMUNITY_SUPPORT_PIX_MAX_LENGTH) {
    return false;
  }
  // Printable ASCII only: the spec's alphabet, and it keeps newlines, control
  // and bidi characters out of a string that gets rendered as text.
  if (!/^[\x20-\x7e]+$/.test(text)) {
    return false;
  }
  if (!text.startsWith("000201")) {
    return false;
  }
  if (!text.toUpperCase().includes("BR.GOV.BCB.PIX")) {
    return false;
  }
  const tail = text.slice(-8);
  if (!/^6304[0-9A-Fa-f]{4}$/.test(tail)) {
    return false;
  }
  return pixCrc16(text.slice(0, -4)) === text.slice(-4).toUpperCase();
}

const PIX_EMAIL = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,250}\.[A-Za-z]{2,}$/;
const PIX_CPF = /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/;
const PIX_CNPJ = /^[0-9A-Za-z]{2}\.?[0-9A-Za-z]{3}\.?[0-9A-Za-z]{3}\/?[0-9A-Za-z]{4}-?\d{2}$/;
const PIX_PHONE = /^\+55\d{10,11}$/;
const PIX_RANDOM_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A Pix key or a copia e cola, as the text to store, or null.
 *
 * Keys: CPF, CNPJ, e-mail, a Brazilian phone (`+55` and 10 or 11 digits, with
 * spaces, dashes and parentheses tolerated and removed) and the random key (a
 * UUID). Not checked against any bank: a key that has the right shape and does
 * not exist is the creator's typo, and the fan's bank app says so.
 *
 * The result is only ever rendered as text and copied. It is never an href.
 */
export function parsePixSupport(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > COMMUNITY_SUPPORT_PIX_MAX_LENGTH) {
    return null;
  }
  if (isPixCopiaECola(trimmed)) {
    return trimmed;
  }
  if (trimmed.length > 77) {
    return null;
  }
  if (PIX_EMAIL.test(trimmed)) {
    return trimmed;
  }
  if (PIX_CPF.test(trimmed) || PIX_CNPJ.test(trimmed) || PIX_RANDOM_KEY.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("+")) {
    const phone = `+${trimmed.slice(1).replace(/[\s().-]/g, "")}`;
    if (PIX_PHONE.test(phone)) {
      return phone;
    }
  }
  return null;
}
