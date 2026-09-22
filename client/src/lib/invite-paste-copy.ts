import { createInvite } from "@/lib/api";
import {
  shareInviteText,
  shareInviteUrl,
  type InviteRef,
} from "@/lib/share-invite";

/**
 * "Copy the invite" from anywhere that is not the invite dialog: mint a 7-day
 * link if this tab has not already got one for the server, and put the short
 * paste ("Vem pra pqp: <link> #vemprapqp") on the clipboard.
 *
 * Three surfaces share it: the lone-presenter nudge (`bring-friends-hint`),
 * the owner's arrival banner and the owner's empty channel. Before it was one
 * routine, the nudge minted a fresh invite on every press; now a press reuses
 * the code the wizard's "Sala pronta" step (or an earlier press) already made,
 * so an owner who copies three times does not leave three live links behind.
 *
 * `createInvite` is permission-checked by the API; a member who cannot make
 * invites gets a rejection, which the caller shows as "couldn't copy".
 */

const DEFAULT_EXPIRY_HOURS = 168;

/** Server id → invite code minted this session. Memory only, on purpose. */
const minted = new Map<string, string>();

/** Seed the cache with an invite made elsewhere (the wizard's ready step). */
export function rememberInviteCode(serverId: string, code: string): void {
  minted.set(serverId, code);
}

export async function inviteCodeFor(serverId: string): Promise<string> {
  const cached = minted.get(serverId);
  if (cached) {
    return cached;
  }
  const { invite } = await createInvite(serverId, {
    expiresInHours: DEFAULT_EXPIRY_HOURS,
  });
  minted.set(serverId, invite.code);
  return invite.code;
}

/** Mint (or reuse) and copy the short paste. Throws when either fails. */
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
}
