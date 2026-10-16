package gg.pqp.app.communities

import kotlinx.serialization.Serializable

/*
 * A server's PUBLIC state, on the wire: `communitySettingsSchema` and
 * `updateCommunitySchema` in `packages/shared/src/communities.ts`.
 *
 * Two switches, and the names are the web's even though the second one reads
 * oddly next to the first:
 *
 *   isCommunity  the public ADDRESS, `pqp.gg/c/<slug>`. Whoever holds the link
 *                joins with one tap, no invite. Manage Server may set it.
 *   isListed     the DIRECTORY. Any signed-in account can find the room without
 *                being sent anything. Owner only, and it needs the address.
 *
 * A read-only subset: the tagline, about text, links, featured media, category
 * and language are the web's editor and stay there. What this client needs is
 * whether the room is open to strangers and the power to close it.
 */

/** `GET /api/communities/config`. Off on any doubt: the section is simply not drawn. */
@Serializable
data class CommunitiesConfig(val enabled: Boolean = false)

@Serializable
data class CommunitySettings(
    val isCommunity: Boolean = false,
    /**
     * Absent from a server built before the split, where an addressed community
     * WAS a listed one. The schema defaults it to the address for the same
     * reason: defaulting to false would claim a live listing is down.
     */
    val isListed: Boolean? = null,
    val slug: String? = null,
    /** Set by the instance operator. The room is as it was; the page and listing are gone. */
    val suspended: Boolean = false,
) {
    val listed: Boolean get() = isCommunity && (isListed ?: isCommunity)
}

@Serializable
data class CommunitySettingsResponse(val community: CommunitySettings)

/**
 * `PATCH /api/servers/:id/community`. Every field is optional and absent means
 * "leave it alone", so a switch sends exactly the one thing it moved.
 */
@Serializable
data class UpdateCommunityBody(
    val isCommunity: Boolean? = null,
    val isListed: Boolean? = null,
    val slug: String? = null,
)
