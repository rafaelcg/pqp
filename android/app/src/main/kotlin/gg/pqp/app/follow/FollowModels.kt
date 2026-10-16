package gg.pqp.app.follow

import kotlinx.serialization.Serializable

/*
 * Seguir on the wire: `packages/shared/src/bau-follow.ts`.
 *
 * A follow is a row `source Baú -> text channel of another server`. Free posts
 * the source publishes land in that channel as a forward card, signed by the
 * source. The phone sets follows up, lists them and takes them down; the
 * delivery is the server's, and the card it posts already draws (Encaminhar).
 *
 * Every field is a hand copy of the schema, pinned by `FollowContractTest`.
 * Defaults are for a field an older server does not send, not for a field the
 * schema makes optional: the schema's are all required except the nullable
 * ones, which `explicitNulls = false` reads as null.
 */

/** Follows one destination SERVER may hold; the server sends the live number too. */
const val FOLLOW_MAX_PER_SERVER = 20

/** How many follower rows are drawn before "Show more" (web draws the same fifty). */
const val FOLLOWERS_PAGE = 50

/** The most rows one read of the followers may ask for (the server's own cap). */
const val FOLLOWERS_MAX_PAGE = 500

@Serializable
data class BauFollow(
    val id: String,
    val sourceServerId: String = "",
    val sourceServerName: String = "",
    val sourceServerIconUrl: String? = null,
    val targetServerId: String = "",
    val targetServerName: String = "",
    val targetChannelId: String = "",
    val targetChannelName: String = "",
    val rolePingId: String? = null,
    val rolePingName: String? = null,
    /** `active` or `paused`. */
    val status: String = "active",
    /** `permissions` or `banned`; null while active. */
    val pausedReason: String? = null,
    val pausedAt: String? = null,
    val createdAt: String = "",
    /** Whether the person asking set this follow up. */
    val mine: Boolean = false,
) {
    val isPaused: Boolean get() = status == "paused"
    val pausedBecauseBanned: Boolean get() = pausedReason == "banned"
}

/**
 * `GET /api/servers/:id/home/follow`. `enabled` is the `bau_follow` flag for this
 * source AND the owner's switch AND the viewer being allowed (a public community
 * for any member, an ordinary server for its staff). False means "draw no button".
 */
@Serializable
data class BauFollowState(
    val enabled: Boolean = false,
    val maxPerServer: Int = FOLLOW_MAX_PER_SERVER,
    /** Follows of this Baú the viewer created, newest first. */
    val mine: List<BauFollow> = emptyList(),
)

@Serializable
data class BauFollowRole(
    val id: String,
    val name: String = "",
    val color: String? = null,
)

@Serializable
data class BauFollowChannel(
    val id: String,
    val name: String = "",
    /** An active or paused follow of this source already points here. */
    val following: Boolean = false,
)

@Serializable
data class BauFollowDestination(
    val serverId: String,
    val serverName: String = "",
    val serverIconUrl: String? = null,
    val channels: List<BauFollowChannel> = emptyList(),
    /** Roles the viewer may ping from this server. */
    val roles: List<BauFollowRole> = emptyList(),
    /** Follows this server already holds, against `maxPerServer`. */
    val followCount: Int = 0,
) {
    /** Channels a new follow may still point at. */
    val freeChannels: List<BauFollowChannel> get() = channels.filter { !it.following }
}

/** `GET /api/servers/:id/home/follow/destinations`. */
@Serializable
data class BauFollowDestinations(
    val maxPerServer: Int = FOLLOW_MAX_PER_SERVER,
    val servers: List<BauFollowDestination> = emptyList(),
)

/** `POST /api/servers/:id/home/follow`. */
@Serializable
data class CreateBauFollowRequest(
    val channelId: String,
    val rolePingId: String? = null,
)

@Serializable
data class BauFollowResponse(val follow: BauFollow)

/**
 * `PATCH /api/bau-follows/:id`. At least one field must be present or the server
 * answers 400, and `encodeDefaults = false` drops a field equal to its default,
 * so [resume] is nullable with a null default: `true` is always encoded.
 */
@Serializable
data class UpdateBauFollowRequest(
    val resume: Boolean? = null,
    val rolePingId: String? = null,
)

/** `GET /api/channels/:id/bau-follows`. */
@Serializable
data class ChannelBauFollows(val follows: List<BauFollow> = emptyList())

/** A follower as the SOURCE's staff see it: server names, never people. */
@Serializable
data class BauFollower(
    val id: String,
    val targetServerId: String = "",
    val targetServerName: String = "",
    val targetServerIconUrl: String? = null,
    val targetChannelName: String = "",
    val status: String = "active",
    val createdAt: String = "",
) {
    val isPaused: Boolean get() = status == "paused"
}

@Serializable
data class BauFollowBlock(
    val serverId: String,
    val serverName: String = "",
    val createdAt: String = "",
)

/**
 * `GET /api/servers/:id/home/followers` (MANAGE_SERVER), and what
 * `PATCH .../follow-config` answers.
 */
@Serializable
data class BauFollowers(
    /** Followable right now: the flag, the Baú and the owner's switch, all on. */
    val enabled: Boolean = false,
    /** The `bau_follow` flag is on for this server: the switch is offered at all. */
    val flagOn: Boolean = false,
    /** The owner's own switch ("Permitir seguir"), default off. */
    val allowed: Boolean = false,
    /** A public community with an address: any member may follow it. */
    val publicCommunity: Boolean = false,
    /** Followers across every destination channel (a server with two channels counts twice). */
    val count: Int = 0,
    val followers: List<BauFollower> = emptyList(),
    /**
     * Pass back as `?cursor=` for the next page of [followers]; null on the last page and
     * absent from a server that does not page (it sends every row, up to 500, at once).
     */
    val nextCursor: String? = null,
    val blocked: List<BauFollowBlock> = emptyList(),
)

/** `PATCH /api/servers/:id/home/follow-config`. */
@Serializable
data class UpdateBauFollowConfigRequest(val allowed: Boolean)

/** `{ ok: true }`, and `removed` for the follower removal. */
@Serializable
data class FollowOk(val ok: Boolean = true, val removed: Int? = null)
