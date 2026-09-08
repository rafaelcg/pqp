import type {
  CreateWatchPartyInput,
  UpdateWatchPartyInput,
  WatchParty,
  WatchPartyPhase,
} from "@pqp/shared";
import { apiFetch } from "./api";

/**
 * The watch party event routes. Thin wrappers, same reasoning as
 * `channel-sessions-api.ts`: this feature's HTTP surface stays reviewable on
 * its own rather than dissolving into `api.ts`.
 *
 * Everything here is a WRITE that the server will broadcast. The client does
 * not have to apply the answer itself: `watch-party-update` arrives on the
 * socket for every state change, including this one, so a component that
 * fires a mutation and does nothing with the response is correct rather than
 * lazy. The returned party is there for optimism and for the create call,
 * which needs the id before any frame can name it.
 */

export function createWatchParty(
  channelId: string,
  input: CreateWatchPartyInput,
): Promise<{ party: WatchParty | null }> {
  return apiFetch(`/api/channels/${channelId}/watch-parties`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchChannelWatchParty(
  channelId: string,
): Promise<{ party: WatchParty | null }> {
  return apiFetch(`/api/channels/${channelId}/watch-party`);
}

export function fetchServerWatchParties(
  serverId: string,
): Promise<{ parties: WatchParty[] }> {
  return apiFetch(`/api/servers/${serverId}/watch-parties`);
}

export function updateWatchParty(
  partyId: string,
  input: UpdateWatchPartyInput,
): Promise<{ party: WatchParty | null }> {
  return apiFetch(`/api/watch-parties/${partyId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/**
 * Ir ao vivo, Encerrar, Cancelar and publishing a draft, all one route.
 *
 * The client names the state it wants, never the verb: the server owns the
 * transition table (`packages/shared/src/watch-party-session.ts`) and will
 * refuse a move that is not in it, so there is nothing here to keep in sync.
 */
export function setWatchPartyState(
  partyId: string,
  state: Exclude<WatchPartyPhase, "draft">,
): Promise<{ party: WatchParty | null }> {
  return apiFetch(`/api/watch-parties/${partyId}/state`, {
    method: "POST",
    body: JSON.stringify({ state }),
  });
}

export function setWatchPartyCohost(
  partyId: string,
  userId: string,
  cohost: boolean,
): Promise<{ party: WatchParty | null }> {
  return apiFetch(`/api/watch-parties/${partyId}/cohosts`, {
    method: "POST",
    body: JSON.stringify({ userId, cohost }),
  });
}

/** The host hands the party to somebody. */
export function transferWatchPartyHost(
  partyId: string,
  userId: string,
): Promise<{ party: WatchParty | null }> {
  return apiFetch(`/api/watch-parties/${partyId}/host`, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

/** A co-host takes a party whose host dropped. Refused while the host is here. */
export function claimWatchPartyHost(
  partyId: string,
): Promise<{ party: WatchParty | null }> {
  return apiFetch(`/api/watch-parties/${partyId}/host`, {
    method: "POST",
    body: JSON.stringify({ claim: true }),
  });
}

/**
 * The stage: the host bringing somebody up or taking them down, and a viewer
 * raising or lowering their own hand. One route, two authorisations, which is
 * why the body is a union rather than one shape with an optional field.
 */
export function setWatchPartyStage(
  partyId: string,
  input:
    | { action: "invite" | "remove"; userId: string }
    | { action: "raise" | "lower" },
): Promise<{ party: WatchParty | null }> {
  return apiFetch(`/api/watch-parties/${partyId}/stage`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
