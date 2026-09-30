package gg.pqp.app.watch

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.PqpJson
import gg.pqp.app.social.getJson
import gg.pqp.app.social.postJson

/**
 * Watch party hosting, as endpoints. Mirrors `client/src/lib/watch-parties-api.ts`
 * and `client/src/hooks/use-hls-host-ack.ts`: extensions on [ApiClient] rather
 * than methods inside it, the same reasoning `SocialApi.kt` states -- the
 * plumbing these need (a fresh token, the cancellable call, an `ApiException`
 * that carries the server's own sentence) is already public on [ApiClient],
 * and this keeps a whole feature out of a file every other branch is also
 * editing.
 *
 * Every mutation here is a WRITE the server also broadcasts over
 * `watch-party-update`, so this client does not apply its own answer: the
 * caller reads the party back off [WatchLiveStore.parties] once the frame
 * lands, same as the web reads `watchParties.byChannel`. The returned value
 * exists for the create call, which needs the id before any frame can name
 * it, and so a refusal's own wording reaches the caller.
 *
 * Out of scope for this PR (see `SCREEN_SHARE_AND_HOSTING_REVIEW.md`):
 * co-host promote/demote, the stage/guests routes, `PATCH` for renaming or
 * the options a party carries. Those reuse this file's plumbing when built.
 */

/**
 * `POST /api/channels/:channelId/watch-parties`. No `startsAt`: this build
 * always creates an immediate `draft`, never a `scheduled` party -- one less
 * screen for a first cut, and a host who wants to announce ahead of time
 * still can from the web. See `WatchPartyHostController`.
 */
suspend fun ApiClient.createWatchParty(channelId: String, name: String): WatchPartyPayload? =
    postJson<WatchPartyResponse>(
        "/api/channels/$channelId/watch-parties",
        PqpJson.encodeToString(CreateWatchPartyRequest.serializer(), CreateWatchPartyRequest(name = name)),
    ).party

/**
 * `GET /api/channels/:channelId/watch-party`, this channel's current party
 * (any state), or null. Used by [WatchPartyHostController] to disambiguate
 * an unclear `setWatchPartyState` response: a thrown/lost response does not
 * say whether the server committed the transition before it was lost, and
 * this is the re-read that answers it directly rather than guessing.
 */
suspend fun ApiClient.fetchChannelWatchParty(channelId: String): WatchPartyPayload? =
    getJson<WatchPartyResponse>("/api/channels/$channelId/watch-party").party

/**
 * `POST /api/watch-parties/:id/state`. The target state, never a verb -- the
 * server owns the transition table (`canTransitionWatchParty`) and refuses a
 * move that is not in it. `lowLatency` only means anything alongside
 * `state = "live"`, matching the schema it is validated against.
 */
suspend fun ApiClient.setWatchPartyState(
    partyId: String,
    state: String,
    lowLatency: Boolean? = null,
): WatchPartyPayload? =
    postJson<WatchPartyResponse>(
        "/api/watch-parties/$partyId/state",
        PqpJson.encodeToString(
            WatchPartyStateRequest.serializer(),
            WatchPartyStateRequest(state = state, lowLatency = lowLatency),
        ),
    ).party

/**
 * `GET /api/live-hls/config?serverId=`, this server's own answer -- the same
 * route and the same fields the web reads for "may this server broadcast at
 * all" and "is low latency on offer here" (`docs/WATCH_PARTY.md`, "Widening
 * it is a click now"). Never inferred from a build flag on either platform.
 */
suspend fun ApiClient.liveHlsConfig(serverId: String): LiveHlsConfigPayload =
    getJson("/api/live-hls/config", mapOf("serverId" to serverId))

/**
 * The one-time "you're responsible for what you stream" gate (`hls_host_acks`),
 * per user and per server. `true` means it has not been shown and confirmed
 * yet for this server, mirroring `useHlsHostAck.checkNeedsAck` on web.
 */
suspend fun ApiClient.needsHlsHostAck(serverId: String): Boolean =
    !getJson<HlsHostAckPayload>("/api/voice/hls-host-ack/$serverId").acknowledged

/** Persist the ack so it never shows again for this user+server pair. */
suspend fun ApiClient.confirmHlsHostAck(serverId: String) {
    postJson<HlsHostAckPayload>("/api/voice/hls-host-ack/$serverId", "{}")
}
