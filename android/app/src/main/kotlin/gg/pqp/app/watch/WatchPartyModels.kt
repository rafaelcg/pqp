package gg.pqp.app.watch

import gg.pqp.app.core.PqpJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * The wire shapes hosting needs, and nothing more.
 *
 * `watchPartySchema` in `packages/shared/src/watch-party-session.ts` carries
 * cohosts, the stage, guests, options, scheduling -- everything the web's
 * setup surface and options dialog draw. This build draws neither: per the
 * hosting review's Android spec, co-host promote/demote, Convidados and
 * scheduling are out of scope for the first PR. So [WatchPartyPayload] reads
 * only the fields this client's host flow actually uses; every other key on
 * the object is read and discarded by `ignoreUnknownKeys` on [PqpJson]
 * rather than modelled and ignored twice.
 */

/**
 * `WatchParty`, trimmed. The one object the server answers with on
 * `POST /api/channels/:id/watch-parties`, `POST /api/watch-parties/:id/state`,
 * and the `party` field of a `watch-party-update` frame -- one schema on the
 * wire, so one class decodes all three call sites rather than three
 * hand-trimmed copies that can drift apart.
 */
@Serializable
data class WatchPartyPayload(
    val id: String,
    val channelId: String,
    val name: String,
    /** `draft` | `scheduled` | `live` | `ended` | `cancelled` (`WATCH_PARTY_PHASES`). */
    val state: String,
    val hostUserId: String,
    val hostDisplayName: String,
    /** This account's own standing, resolved server side: `host`, `cohost`, `manager` or `viewer`. */
    val viewerRole: String = "viewer",
) {
    val isHost: Boolean get() = viewerRole == "host"
    val isLive: Boolean get() = state == "live"
    val isPreLive: Boolean get() = state == "draft" || state == "scheduled"
}

/** `POST /api/channels/:channelId/watch-parties`. Name only: see [WatchPartyPayload]'s doc. */
@Serializable
data class CreateWatchPartyRequest(val name: String)

/**
 * `POST /api/watch-parties/:id/state`. The state named, never a verb -- the
 * server owns `canTransitionWatchParty` and refuses a move that is not in it.
 */
@Serializable
data class WatchPartyStateRequest(val state: String, val lowLatency: Boolean? = null)

/** The `{party: ...}` envelope every mutation route answers with. */
@Serializable
data class WatchPartyResponse(val party: WatchPartyPayload? = null)

/**
 * `GET /api/live-hls/config`, trimmed to what the host flow reads: whether
 * this server may broadcast at all, and whether "Baixa latência" is on offer.
 * Mirrors `LiveHlsConfig` in `server/src/voice/hls-egress.ts`.
 */
@Serializable
data class LiveHlsConfigPayload(
    val enabled: Boolean = false,
    val lowLatency: LiveHlsLowLatencyPayload = LiveHlsLowLatencyPayload(),
)

@Serializable
data class LiveHlsLowLatencyPayload(val available: Boolean = false)

/** `GET`/`POST /api/voice/hls-host-ack/:serverId`. */
@Serializable
data class HlsHostAckPayload(val acknowledged: Boolean = false)

/**
 * Read a `watch-party-update` frame's full `party` object.
 *
 * A companion to [decodeWatchPartySeat], which reads the same frame for the
 * narrower seat rule; this is what the host's own UI reads to know the
 * party's name, state and who is running it. `null` for a `party: null`
 * frame or a frame this build cannot make sense of -- never throws, matching
 * every other decoder in this package: a server that grew a field must not
 * turn into a host screen that crashes.
 */
fun decodeWatchPartyPayload(frame: JsonObject): WatchPartyPayload? {
    val party = runCatching { frame["party"]?.jsonObject }.getOrNull() ?: return null
    return runCatching {
        PqpJson.decodeFromJsonElement(WatchPartyPayload.serializer(), party)
    }.getOrNull()
}
