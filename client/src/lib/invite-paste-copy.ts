import { createInvite } from "@/lib/api";
import {
  shareInviteText,
  shareInviteUrl,
  type InviteRef,
} from "@/lib/share-invite";

/**
 * "Copy the invite" from anywhere that is not the invite dialog: mint a 7-day
 * link, or reuse one this tab minted a moment ago, and put the short paste
 * ("Vem pra pqp: <link> #vemprapqp") on the clipboard.
 *
 * Three surfaces share it: the lone-presenter nudge (`bring-friends-hint`),
 * the owner's arrival banner and the owner's empty channel. The reuse exists
 * so an owner pressing copy on the wizard's "Sala pronta", then the banner,
 * then the empty channel does not leave three live links behind; concurrent
 * presses share one request.
 *
 * WHY THE REUSE IS SHORT. `createInvite` is where the API checks that this
 * account may make invites for this server, and a cached code skips that
 * check. So a code is reused only for `REUSE_MS` after it was minted: long
 * enough to cover a first run, far shorter than the link's own 7 days, so a
 * permission taken away mid-session stops being bypassable within minutes
 * and nothing hands out a link close to expiry. The cache is also keyed by
 * account, so a second account in the same tab never sees the first one's.
 */

const DEFAULT_EXPIRY_HOURS = 168;
export const REUSE_MS = 10 * 60 * 1000;

interface Minted {
  code: string;
  at: number;
}

const minted = new Map<string, Minted>();
const inFlight = new Map<string, Promise<string>>();
let account: string | null = null;

/** Scope the cache to one account; a change forgets everything. */
export function setInviteCacheAccount(userId: string | null): void {
  if (userId !== account) {
    account = userId;
    minted.clear();
    inFlight.clear();
  }
}

/** Seed the cache with an invite made elsewhere (the wizard's ready step). */
export function rememberInviteCode(
  serverId: string,
  code: string,
  now: number = Date.now(),
): void {
  minted.set(serverId, { code, at: now });
}

export function inviteCodeFor(
  serverId: string,
  now: number = Date.now(),
): Promise<string> {
  const cached = minted.get(serverId);
  if (cached && now - cached.at < REUSE_MS) {
    return Promise.resolve(cached.code);
  }
  const pending = inFlight.get(serverId);
  if (pending) {
    return pending;
  }
  const request = createInvite(serverId, {
    expiresInHours: DEFAULT_EXPIRY_HOURS,
  })
    .then(({ invite }) => {
      minted.set(serverId, { code: invite.code, at: Date.now() });
      return invite.code;
    })
    .finally(() => {
      inFlight.delete(serverId);
    });
  inFlight.set(serverId, request);
  return request;
}

/** Mint (or briefly reuse) and copy the short paste. Throws when either fails. */
export async function copyInvitePaste({
  serverId,
  locale,
  inviteRef = "convite",
  clipboard = navigator.clipboard,
  origin = window.location.origin,
}: {
  serverId: string;
  locale: string;
  inviteRef?: InviteRef;
  clipboard?: Pick<Clipboard, "writeText">;
  origin?: string;
}): Promise<string> {
  const code = await inviteCodeFor(serverId);
  const text = shareInviteText(
    "short",
    locale,
    shareInviteUrl(origin, code, inviteRef),
  );
  await clipboard.writeText(text);
  return text;
}

/** Test seam: forget every cached code. */
export function resetInviteCodeCache(): void {
  minted.clear();
  inFlight.clear();
}
