import { z } from "zod";

/**
 * Free/consumer mail providers. Pointing a server's SSO domain at one of these
 * would not admit "your company" — it would admit anyone on the internet who
 * can register an address there, silently turning a private server public.
 *
 * Deliberately a short list of the obvious ones rather than an exhaustive
 * registry: it exists to catch an owner who has not thought it through, not to
 * be a security boundary. Someone determined to open their server up can still
 * use the invite link that already does exactly that, on purpose.
 */
export const PUBLIC_EMAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "googlemail.com",
  "hotmail.co.uk",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "yahoo.co.uk",
  "yahoo.com",
  "yandex.com",
  "ymail.com",
]);

/**
 * A hostname label: alphanumeric, inner hyphens allowed. Deliberately strict —
 * this string is compared for equality against a domain derived from a verified
 * address, so anything that could normalise two ways is a bug waiting to be a
 * bypass.
 */
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Normalise a domain for storage and comparison, or return null if it is not a
 * plausible one. Lowercases, strips a trailing dot, and requires at least two
 * labels so a bare TLD (`com`) can never be set.
 *
 * Both sides of the eventual comparison go through this, which is the point:
 * `ACME.com` typed by an owner and `acme.com` from a verified address must
 * converge on one representation, and anything that does not normalise cleanly
 * must be rejected rather than silently stored in a second form.
 */
export function normalizeEmailDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed || trimmed.length > 253) {
    return null;
  }
  const labels = trimmed.split(".");
  if (labels.length < 2) {
    return null;
  }
  if (!labels.every((label) => label.length <= 63 && LABEL.test(label))) {
    return null;
  }
  return trimmed;
}

/**
 * The domain part of an email address, normalised, or null. Rejects addresses
 * with more than one `@` rather than taking the last part — an input that
 * malformed should not be silently reinterpreted.
 */
export function emailDomainOf(email: string): string | null {
  const parts = email.trim().split("@");
  if (parts.length !== 2 || !parts[0]) {
    return null;
  }
  return normalizeEmailDomain(parts[1]!);
}

/**
 * Whether any of a user's verified domains admits them to a server advertising
 * `serverDomain`.
 *
 * Exact equality only. A suffix check here (`endsWith`) would admit
 * `evil-acme.com` and `acme.com.evil.test` alike.
 */
export function domainsMatch(
  userDomains: readonly string[] | null | undefined,
  serverDomain: string | null | undefined,
): boolean {
  if (!userDomains?.length || !serverDomain) {
    return false;
  }
  return userDomains.includes(serverDomain);
}

export const ssoEmailDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => normalizeEmailDomain(value) !== null, {
    message: "Enter a valid domain, like acme.com",
  })
  .refine(
    (value) => !PUBLIC_EMAIL_DOMAINS.has(normalizeEmailDomain(value)!),
    {
      message:
        "That is a public email provider — anyone could join. Use a domain your organisation controls.",
    },
  )
  .transform((value) => normalizeEmailDomain(value)!);
