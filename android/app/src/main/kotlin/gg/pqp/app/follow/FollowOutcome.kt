package gg.pqp.app.follow

import gg.pqp.app.core.ApiException

/**
 * What a refused Seguir call means to the person who made it. The same mapping
 * the web keeps in `bauFollowErrorKey` (`client/src/components/community-home/bau-follow.tsx`),
 * because the server answers one status for several different refusals and the
 * sentence it carries is what tells them apart:
 *
 *  - 403: not allowed in that channel, OR the source does not take that server
 *    ("This Baú does not accept that server");
 *  - 409: the channel already follows it, OR the destination server is at its
 *    cap ("A server can follow at most 20 Baús");
 *  - 404: the Baú no longer accepts follows (the owner switched it off, the flag
 *    went off, or the channel is gone). One answer for every reason on purpose;
 *  - 400: the role cannot be pinged, or a Baú is not delivered into its own server;
 *  - 429: the route's own burst limit.
 */
enum class FollowFailure {
    /** 429. */
    Slow,

    /** 403, and the channel is not one this person may manage. */
    Forbidden,

    /** 403, and the source Baú does not accept that server. */
    Blocked,

    /** 409, and the destination server holds as many follows as it may. */
    Limit,

    /** 409, and that channel already follows this Baú. */
    Exists,

    /** 400. */
    Invalid,

    /** 404: the Baú no longer accepts follows. */
    Unavailable,

    /** A change (unfollow, resume, remove, block) that did not go through. */
    Action,

    /** Anything else: a lost connection, a 5xx. */
    Generic,
}

object FollowFailures {

    /** The refusal of a CREATE: the case with the most outcomes. */
    fun ofCreate(error: Throwable): FollowFailure {
        if (error !is ApiException) return FollowFailure.Generic
        val said = error.serverMessage.orEmpty()
        return when (error.status) {
            429 -> FollowFailure.Slow
            403 -> if (Regex("accept", RegexOption.IGNORE_CASE).containsMatchIn(said)) {
                FollowFailure.Blocked
            } else {
                FollowFailure.Forbidden
            }
            409 -> if (Regex("most", RegexOption.IGNORE_CASE).containsMatchIn(said)) {
                FollowFailure.Limit
            } else {
                FollowFailure.Exists
            }
            404 -> FollowFailure.Unavailable
            400 -> FollowFailure.Invalid
            else -> FollowFailure.Generic
        }
    }

    /** A change to a follow that already exists: one sentence, "that did not work". */
    fun ofAction(error: Throwable): FollowFailure =
        if (error is ApiException && error.status == 429) FollowFailure.Slow else FollowFailure.Action
}
