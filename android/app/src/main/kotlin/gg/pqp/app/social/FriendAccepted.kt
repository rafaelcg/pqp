package gg.pqp.app.social

/**
 * "Tu e Bia agora são amigos · Mandar um oi". A friendship is the moment
 * somebody is most likely to write, and the list the request was answered in
 * ends on a row with no way into a conversation. The web shows one card for it
 * (`friend-accepted-toast.tsx`); this is the phone's rule for who it is about.
 */
data class FriendAccepted(
    val person: PublicUser,
    /** When it was noticed ([android.os.SystemClock.elapsedRealtime]), so an old one is not shown late. */
    val at: Long,
)

object FriendsDiff {

    /** An offer is for a few seconds' worth of attention; past this it is stale, not news. */
    const val STALE_AFTER_MS = 2 * 60_000L

    /**
     * Who is a friend now that was not in [before], other than people this
     * account accepted itself (they were in `incoming`: not news to the person
     * who just tapped accept, and [SocialRepository.acceptFriend] says so
     * itself). The first snapshot is a baseline, never news.
     * Same rule as `newlyAcceptedFriends` on the web.
     */
    fun newlyAccepted(before: FriendsResponse?, after: FriendsResponse): List<Friend> {
        if (before == null) return emptyList()
        val known = before.friends.mapTo(HashSet()) { it.id }
        val iAccepted = before.incoming.mapTo(HashSet()) { it.id }
        return after.friends.filter { it.id !in known && it.id !in iAccepted }
    }

    fun isStale(offer: FriendAccepted, now: Long): Boolean = now - offer.at > STALE_AFTER_MS
}
