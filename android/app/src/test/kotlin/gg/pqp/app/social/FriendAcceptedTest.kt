package gg.pqp.app.social

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FriendAcceptedTest {

    private fun friend(id: String) = Friend(id = id, displayName = "F$id")
    private fun request(id: String) = FriendRequestEntry(id = id, displayName = "R$id")

    @Test
    fun `the first snapshot is a baseline, never news`() {
        assertEquals(emptyList<Friend>(), FriendsDiff.newlyAccepted(null, FriendsResponse(friends = listOf(friend("a")))))
    }

    @Test
    fun `somebody who accepted a request this account sent is news`() {
        val before = FriendsResponse(friends = listOf(friend("a")), outgoing = listOf(request("b")))
        val after = FriendsResponse(friends = listOf(friend("a"), friend("b")))
        assertEquals(listOf("b"), FriendsDiff.newlyAccepted(before, after).map { it.id })
    }

    @Test
    fun `somebody this account accepted itself is not news to it`() {
        val before = FriendsResponse(incoming = listOf(request("c")))
        val after = FriendsResponse(friends = listOf(friend("c")))
        assertEquals(emptyList<Friend>(), FriendsDiff.newlyAccepted(before, after))
    }

    @Test
    fun `nothing changing is nothing`() {
        val same = FriendsResponse(friends = listOf(friend("a")))
        assertEquals(emptyList<Friend>(), FriendsDiff.newlyAccepted(same, same))
    }

    @Test
    fun `an offer goes stale`() {
        val offer = FriendAccepted(PublicUser("a", "A"), at = 1_000L)
        assertFalse(FriendsDiff.isStale(offer, 1_000L + FriendsDiff.STALE_AFTER_MS))
        assertTrue(FriendsDiff.isStale(offer, 1_001L + FriendsDiff.STALE_AFTER_MS))
    }
}
