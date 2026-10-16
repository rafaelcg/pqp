package gg.pqp.app.follow

import gg.pqp.app.core.ApiException
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The three Seguir view models, constructed and driven for real against a fake
 * backend. An unconfined Main reproduces `viewModelScope`'s eager start, the
 * thing that bit Encaminhar's picker (a field read in `init` before it was set).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class FollowViewModelsTest {

    @Before
    fun main() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun reset() = Dispatchers.resetMain()

    private fun follow(
        id: String,
        channel: String = "general",
        server: String = "Guild",
        status: String = "active",
        reason: String? = null,
    ) = BauFollow(
        id = id,
        sourceServerId = "src",
        sourceServerName = "Source",
        targetServerId = "t-$server",
        targetServerName = server,
        targetChannelId = "c-$channel",
        targetChannelName = channel,
        status = status,
        pausedReason = reason,
    )

    private class FakeBackend : FollowBackend {
        var state: BauFollowState = BauFollowState(enabled = true)
        var stateFails = false
        var destinations = BauFollowDestinations()
        var destinationsFail: Throwable? = null
        var createFails: Throwable? = null
        var updateFails: Throwable? = null
        var deleteFails: Throwable? = null
        var channelFollows: List<BauFollow> = emptyList()
        var channelFollowsFail: Throwable? = null
        var followers = BauFollowers(flagOn = true, allowed = false)
        var followersFail: Throwable? = null
        var setAllowedFails: Throwable? = null
        var removeFails: Throwable? = null

        val created = mutableListOf<CreateBauFollowRequest>()
        val updated = mutableListOf<Pair<String, UpdateBauFollowRequest>>()
        val deleted = mutableListOf<String>()
        val removed = mutableListOf<Pair<String, Boolean>>()
        val unblocked = mutableListOf<String>()
        var stateReads = 0
        var followerReads = 0

        override suspend fun state(serverId: String): BauFollowState {
            stateReads += 1
            if (stateFails) throw IOException("offline")
            return state
        }

        override suspend fun destinations(serverId: String): BauFollowDestinations {
            destinationsFail?.let { throw it }
            return destinations
        }

        override suspend fun create(serverId: String, request: CreateBauFollowRequest): BauFollow {
            createFails?.let { throw it }
            created += request
            return BauFollow(
                id = "new",
                targetServerName = "Guild",
                targetChannelName = "news",
                targetChannelId = request.channelId,
            )
        }

        var channelReads = 0
        var channelFollowsHook: (suspend (Int) -> List<BauFollow>)? = null

        override suspend fun channelFollows(channelId: String): List<BauFollow> {
            channelReads += 1
            channelFollowsFail?.let { throw it }
            channelFollowsHook?.let { return it(channelReads) }
            return channelFollows
        }

        override suspend fun update(followId: String, request: UpdateBauFollowRequest): BauFollow {
            updateFails?.let { throw it }
            updated += followId to request
            return BauFollow(id = followId, status = "active")
        }

        override suspend fun delete(followId: String) {
            deleteFails?.let { throw it }
            deleted += followId
        }

        /** Pages by cursor (`null` is the first), for a server that pages. */
        var pages: Map<String?, BauFollowers>? = null
        val followerRequests = mutableListOf<Pair<Int?, String?>>()

        override suspend fun followers(serverId: String, limit: Int?, cursor: String?): BauFollowers {
            followerReads += 1
            followerRequests += limit to cursor
            followersFail?.let { throw it }
            return pages?.get(cursor) ?: followers
        }

        override suspend fun setAllowed(serverId: String, allowed: Boolean): BauFollowers {
            setAllowedFails?.let { throw it }
            followers = followers.copy(allowed = allowed, enabled = allowed)
            return followers
        }

        override suspend fun removeFollower(serverId: String, followId: String, block: Boolean) {
            removeFails?.let { throw it }
            removed += followId to block
            val gone = followers.followers.firstOrNull { it.id == followId }
            followers = followers.copy(
                followers = followers.followers.filterNot {
                    it.id == followId || (block && gone != null && it.targetServerId == gone.targetServerId)
                },
                blocked = if (block && gone != null) {
                    followers.blocked + BauFollowBlock(gone.targetServerId, gone.targetServerName)
                } else {
                    followers.blocked
                },
            )
            followers = followers.copy(count = followers.followers.size)
        }

        override suspend fun unblock(serverId: String, blockedServerId: String) {
            unblocked += blockedServerId
            followers = followers.copy(blocked = followers.blocked.filterNot { it.serverId == blockedServerId })
        }
    }

    private fun destination(
        id: String,
        vararg channels: Pair<String, Boolean>,
        roles: List<BauFollowRole> = emptyList(),
        count: Int = 0,
    ) = BauFollowDestination(
        serverId = id,
        serverName = "Server $id",
        channels = channels.map { BauFollowChannel(it.first, "chan-${it.first}", it.second) },
        roles = roles,
        followCount = count,
    )

    // ---- the header's state

    @Test
    fun `the state is read on construction and a failure reads as not followable`() {
        val backend = FakeBackend()
        val model = BauFollowViewModel(backend, "src")
        assertEquals(true, model.state.value?.enabled)

        backend.stateFails = true
        model.refresh()
        assertNull(model.state.value)
    }

    @Test
    fun `the owner's side is read only once the screen says the viewer manages the server`() {
        val backend = FakeBackend()
        val model = BauFollowViewModel(backend, "src")
        assertEquals(0, backend.followerReads)
        assertFalse(model.staffMenu.value)

        model.setCanManage(true)
        assertEquals(1, backend.followerReads)
        assertTrue(model.staffMenu.value)
    }

    @Test
    fun `a failed owner read keeps what was known`() {
        val backend = FakeBackend()
        val model = BauFollowViewModel(backend, "src")
        model.setCanManage(true)
        backend.followersFail = IOException("offline")
        model.refreshAll()
        assertTrue(model.staffMenu.value)
    }

    @Test
    fun `a failed first owner read still offers the way in, an answer of off hides it`() {
        val backend = FakeBackend()
        backend.followersFail = IOException("offline")
        val model = BauFollowViewModel(backend, "src")
        model.setCanManage(true)
        assertTrue("the sheet has the retry, so the menu stays", model.staffMenu.value)

        backend.followersFail = null
        backend.followers = BauFollowers(flagOn = false)
        model.refreshAll()
        assertFalse(model.staffMenu.value)

        // Off was a real answer: a later failure does not bring the menu back.
        backend.followersFail = IOException("offline")
        model.refreshAll()
        assertFalse(model.staffMenu.value)
    }

    // ---- the picker

    @Test
    fun `opening the picker selects the first server and its first free channel`() {
        val backend = FakeBackend()
        backend.destinations = BauFollowDestinations(
            servers = listOf(
                destination("a", "c1" to true, "c2" to false, "c3" to false),
                destination("b", "c4" to false),
            ),
        )
        val model = BauFollowViewModel(backend, "src")
        model.openPicker()

        val picker = model.picker.value
        assertTrue(model.pickerOpen.value)
        assertEquals("a", picker.destinationId)
        assertEquals("c2", picker.channelId)
        assertEquals(listOf("c2", "c3"), picker.freeChannels.map { it.id })
        assertTrue(picker.canSubmit)
    }

    @Test
    fun `switching server re-picks a channel and drops a role that server does not have`() {
        val backend = FakeBackend()
        backend.destinations = BauFollowDestinations(
            servers = listOf(
                destination("a", "c1" to false, roles = listOf(BauFollowRole("r1", "mods"))),
                destination("b", "c2" to false),
            ),
        )
        val model = BauFollowViewModel(backend, "src")
        model.openPicker()
        model.pickRole("r1")
        assertEquals("r1", model.picker.value.roleId)

        model.pickDestination("b")
        assertEquals("c2", model.picker.value.channelId)
        assertEquals("", model.picker.value.roleId)
    }

    @Test
    fun `a server at its cap cannot submit`() {
        val backend = FakeBackend()
        backend.destinations = BauFollowDestinations(
            maxPerServer = 20,
            servers = listOf(destination("a", "c1" to false, count = 20)),
        )
        val model = BauFollowViewModel(backend, "src")
        model.openPicker()
        assertTrue(model.picker.value.full)
        assertFalse(model.picker.value.canSubmit)
        model.submit()
        assertTrue(backend.created.isEmpty())
    }

    @Test
    fun `a server whose channels all follow already offers none`() {
        val backend = FakeBackend()
        backend.destinations = BauFollowDestinations(servers = listOf(destination("a", "c1" to true)))
        val model = BauFollowViewModel(backend, "src")
        model.openPicker()
        assertTrue(model.picker.value.freeChannels.isEmpty())
        assertFalse(model.picker.value.canSubmit)
    }

    @Test
    fun `following sends the channel and the role and says where it will land`() {
        val backend = FakeBackend()
        backend.destinations = BauFollowDestinations(
            servers = listOf(destination("a", "c1" to false, roles = listOf(BauFollowRole("r1", "mods")))),
        )
        val model = BauFollowViewModel(backend, "src")
        model.openPicker()
        model.pickRole("r1")
        val readsBefore = backend.stateReads
        model.submit()

        assertEquals(listOf(CreateBauFollowRequest("c1", "r1")), backend.created)
        assertEquals(FollowedNotice("news", "Guild"), model.picker.value.notice)
        assertFalse(model.picker.value.busy)
        assertTrue("the header re-reads what it follows", backend.stateReads > readsBefore)
    }

    @Test
    fun `no role means a null ping`() {
        val backend = FakeBackend()
        backend.destinations = BauFollowDestinations(servers = listOf(destination("a", "c1" to false)))
        val model = BauFollowViewModel(backend, "src")
        model.openPicker()
        model.submit()
        assertNull(backend.created.single().rolePingId)
    }

    @Test
    fun `a refused follow says why and re-reads what is true`() {
        val backend = FakeBackend()
        backend.destinations = BauFollowDestinations(servers = listOf(destination("a", "c1" to false)))
        val model = BauFollowViewModel(backend, "src")
        model.openPicker()
        backend.createFails = ApiException(409, "A server can follow at most 20 Baús")
        val readsBefore = backend.stateReads
        model.submit()

        assertEquals(FollowFailure.Limit, model.picker.value.error)
        assertNull(model.picker.value.notice)
        assertFalse(model.picker.value.busy)
        assertTrue(backend.stateReads > readsBefore)
    }

    @Test
    fun `a 404 on the destinations says the Bau no longer accepts follows and drops the button`() {
        val backend = FakeBackend()
        val model = BauFollowViewModel(backend, "src")
        backend.destinationsFail = ApiException(404, "Not found")
        backend.state = BauFollowState(enabled = false)
        model.openPicker()

        assertEquals(PickerLoadError.Off, model.picker.value.loadError)
        assertEquals(false, model.state.value?.enabled)
    }

    @Test
    fun `any other failure on the destinations offers a retry`() {
        val backend = FakeBackend()
        val model = BauFollowViewModel(backend, "src")
        backend.destinationsFail = IOException("offline")
        model.openPicker()
        assertEquals(PickerLoadError.Failed, model.picker.value.loadError)

        backend.destinationsFail = null
        backend.destinations = BauFollowDestinations(servers = listOf(destination("a", "c1" to false)))
        model.retryLoad()
        assertNull(model.picker.value.loadError)
        assertEquals("a", model.picker.value.destinationId)
    }

    @Test
    fun `unfollow and resume go to the follow and refresh`() {
        val backend = FakeBackend()
        backend.destinations = BauFollowDestinations(servers = listOf(destination("a", "c1" to false)))
        val model = BauFollowViewModel(backend, "src")
        model.openPicker()
        val paused = follow("f1", status = "paused", reason = "permissions")

        model.resume(paused)
        assertEquals(listOf("f1" to UpdateBauFollowRequest(resume = true)), backend.updated)
        model.unfollow(paused)
        assertEquals(listOf("f1"), backend.deleted)
        assertNull(model.picker.value.rowBusy)
    }

    @Test
    fun `a failed unfollow says so`() {
        val backend = FakeBackend()
        backend.destinations = BauFollowDestinations(servers = listOf(destination("a", "c1" to false)))
        val model = BauFollowViewModel(backend, "src")
        model.openPicker()
        backend.deleteFails = ApiException(500, "boom")
        model.unfollow(follow("f1"))
        assertEquals(FollowFailure.Action, model.picker.value.error)
        assertNull(model.picker.value.rowBusy)
    }

    // ---- the staff's list

    private fun follower(id: String, server: String, channel: String = "general") = BauFollower(
        id = id,
        targetServerId = "t-$server",
        targetServerName = server,
        targetChannelName = channel,
    )

    @Test
    fun `the owner's switch sends the new value and keeps what the server answers`() {
        val backend = FakeBackend()
        var changed = 0
        val model = BauFollowersViewModel(backend, "src") { changed += 1 }
        assertEquals(false, model.state.value.data?.allowed)

        model.setAllowed(true)
        assertEquals(true, model.state.value.data?.allowed)
        assertEquals(1, changed)

        backend.setAllowedFails = ApiException(403, "no")
        val reads = backend.followerReads
        model.setAllowed(false)
        assertEquals(true, model.state.value.data?.allowed)
        assertTrue("a lost answer re-reads what is true", backend.followerReads > reads)
        assertEquals(FollowFailure.Action, model.state.value.error)
        assertNull(model.state.value.busyKey)
    }

    @Test
    fun `removing a follower drops the row and the count at once`() {
        val backend = FakeBackend()
        backend.followers = BauFollowers(
            flagOn = true,
            count = 2,
            followers = listOf(follower("f1", "A"), follower("f2", "B")),
        )
        val model = BauFollowersViewModel(backend, "src") {}
        model.remove(model.state.value.data!!.followers[0])

        assertEquals(listOf("f1" to false), backend.removed)
        assertEquals(listOf("f2"), model.state.value.data!!.followers.map { it.id })
        assertEquals(1, model.state.value.data!!.count)
    }

    @Test
    fun `blocking asks first, then removes every follow of that server and lists it as blocked`() {
        val backend = FakeBackend()
        backend.followers = BauFollowers(
            flagOn = true,
            count = 3,
            followers = listOf(follower("f1", "A", "x"), follower("f2", "A", "y"), follower("f3", "B")),
        )
        val model = BauFollowersViewModel(backend, "src") {}
        val target = model.state.value.data!!.followers[0]

        model.askBlock(target)
        assertEquals(target, model.state.value.confirmBlock)
        assertTrue("nothing is sent until it is confirmed", backend.removed.isEmpty())

        model.confirmBlock()
        assertEquals(listOf("f1" to true), backend.removed)
        val data = model.state.value.data!!
        assertEquals(listOf("f3"), data.followers.map { it.id })
        assertEquals(listOf("t-A"), data.blocked.map { it.serverId })
        assertEquals(1, data.count)
        assertNull(model.state.value.confirmBlock)
    }

    @Test
    fun `cancelling the block sends nothing`() {
        val backend = FakeBackend()
        backend.followers = BauFollowers(followers = listOf(follower("f1", "A")), count = 1)
        val model = BauFollowersViewModel(backend, "src") {}
        model.askBlock(model.state.value.data!!.followers[0])
        model.cancelBlock()
        model.confirmBlock()
        assertTrue(backend.removed.isEmpty())
    }

    @Test
    fun `unblocking drops the server from the blocked list`() {
        val backend = FakeBackend()
        backend.followers = BauFollowers(blocked = listOf(BauFollowBlock("t-A", "A")))
        val model = BauFollowersViewModel(backend, "src") {}
        model.unblock(model.state.value.data!!.blocked[0])
        assertEquals(listOf("t-A"), backend.unblocked)
        assertTrue(model.state.value.data!!.blocked.isEmpty())
    }

    @Test
    fun `a failed removal says so and re-reads`() {
        val backend = FakeBackend()
        backend.followers = BauFollowers(followers = listOf(follower("f1", "A")), count = 1)
        val model = BauFollowersViewModel(backend, "src") {}
        backend.removeFails = ApiException(500, "boom")
        val reads = backend.followerReads
        model.remove(model.state.value.data!!.followers[0])
        assertEquals(FollowFailure.Action, model.state.value.error)
        assertEquals(1, model.state.value.data!!.followers.size)
        assertTrue(backend.followerReads > reads)
    }

    @Test
    fun `a server that pages is asked fifty at a time and the next page follows the cursor`() {
        val backend = FakeBackend()
        fun f(id: String) = follower(id, "S$id")
        backend.pages = mapOf(
            null to BauFollowers(flagOn = true, count = 3, followers = listOf(f("1"), f("2")), nextCursor = "c1"),
            "c1" to BauFollowers(flagOn = true, count = 3, followers = listOf(f("2"), f("3")), nextCursor = null),
        )
        val model = BauFollowersViewModel(backend, "src") {}
        assertEquals(FOLLOWERS_PAGE to null, backend.followerRequests.first())
        assertTrue(model.hasMore)

        // Everything loaded is already drawn (2 < 50), so Show more goes to the server.
        model.showMore()
        assertEquals(FOLLOWERS_PAGE to "c1", backend.followerRequests.last())
        assertEquals(listOf("1", "2", "3"), model.state.value.data!!.followers.map { it.id })
        assertEquals(null, model.state.value.data!!.nextCursor)
        assertFalse("the last page ends the button", model.hasMore)
    }

    @Test
    fun `a server that does not page sends everything and the rows are revealed locally`() {
        val backend = FakeBackend()
        backend.followers = BauFollowers(
            flagOn = true,
            count = 60,
            followers = (1..60).map { follower("$it", "S$it") },
        )
        val model = BauFollowersViewModel(backend, "src") {}
        assertTrue(model.hasMore)
        model.showMore()
        assertEquals(1, backend.followerRequests.size)
        assertFalse(model.hasMore)
    }

    @Test
    fun `a reload after a change asks for as many rows as are on screen`() {
        val backend = FakeBackend()
        backend.followers = BauFollowers(
            flagOn = true,
            count = 120,
            followers = (1..120).map { follower("$it", "S$it") },
        )
        val model = BauFollowersViewModel(backend, "src") {}
        model.remove(model.state.value.data!!.followers[0])
        assertEquals(119, backend.followerRequests.last().first)
    }

    @Test
    fun `a failed next page says so and keeps the rows`() {
        val backend = FakeBackend()
        backend.pages = mapOf(
            null to BauFollowers(flagOn = true, count = 3, followers = listOf(follower("1", "A")), nextCursor = "c1"),
        )
        val model = BauFollowersViewModel(backend, "src") {}
        backend.followersFail = IOException("offline")
        model.showMore()
        assertEquals(FollowFailure.Action, model.state.value.error)
        assertEquals(1, model.state.value.data!!.followers.size)
        assertFalse(model.state.value.loadingMore)
    }

    @Test
    fun `a failed read is a retry, and the page grows by fifty`() {
        val backend = FakeBackend()
        backend.followersFail = IOException("offline")
        val model = BauFollowersViewModel(backend, "src") {}
        assertTrue(model.state.value.loadFailed)

        backend.followersFail = null
        backend.followers = BauFollowers(followers = (1..120).map { follower("$it", "S$it") }, count = 120)
        model.load()
        assertFalse(model.state.value.loadFailed)
        assertEquals(FOLLOWERS_PAGE, model.state.value.shown)
        model.showMore()
        assertEquals(2 * FOLLOWERS_PAGE, model.state.value.shown)
    }

    // ---- a channel

    @Test
    fun `a channel that follows nothing shows nothing`() {
        val model = ChannelFollowsViewModel(FakeBackend(), "c1")
        assertTrue(model.state.value.loaded)
        assertFalse(model.state.value.visible)
    }

    @Test
    fun `a channel that follows something shows it`() {
        val backend = FakeBackend()
        backend.channelFollows = listOf(follow("f1"))
        val model = ChannelFollowsViewModel(backend, "c1")
        assertTrue(model.state.value.visible)
    }

    @Test
    fun `404 and 403 are quiet, any other failure shows the retry`() {
        val backend = FakeBackend()
        backend.channelFollowsFail = ApiException(404, "Not found")
        assertFalse(ChannelFollowsViewModel(backend, "c1").state.value.visible)
        backend.channelFollowsFail = ApiException(403, "no")
        assertFalse(ChannelFollowsViewModel(backend, "c1").state.value.visible)

        backend.channelFollowsFail = IOException("offline")
        val model = ChannelFollowsViewModel(backend, "c1")
        assertTrue(model.state.value.failed)
        assertTrue(model.state.value.visible)

        backend.channelFollowsFail = null
        backend.channelFollows = listOf(follow("f1"))
        model.load()
        assertFalse(model.state.value.failed)
        assertEquals(1, model.state.value.follows.size)
    }

    @Test
    fun `unfollowing from the channel removes the row, resuming swaps in the answer`() {
        val backend = FakeBackend()
        backend.channelFollows = listOf(
            follow("f1"),
            follow("f2", status = "paused", reason = "banned"),
        )
        val model = ChannelFollowsViewModel(backend, "c1")

        model.resume(model.state.value.follows[1])
        assertEquals(listOf("f2" to UpdateBauFollowRequest(resume = true)), backend.updated)
        assertFalse(model.state.value.follows[1].isPaused)

        model.unfollow(model.state.value.follows[0])
        assertEquals(listOf("f1"), backend.deleted)
        assertEquals(listOf("f2"), model.state.value.follows.map { it.id })
        assertNull(model.state.value.busyId)
    }

    @Test
    fun `a failed unfollow from the channel says so and re-reads what is true`() {
        val backend = FakeBackend()
        backend.channelFollows = listOf(follow("f1"))
        val model = ChannelFollowsViewModel(backend, "c1")
        backend.deleteFails = ApiException(500, "boom")
        // The write committed and its answer was lost: the next read says it is gone.
        backend.channelFollows = emptyList()
        model.unfollow(model.state.value.follows[0])
        assertEquals(FollowFailure.Action, model.state.value.error)
        assertTrue(model.state.value.follows.isEmpty())
    }

    @Test
    fun `a read that left before an unfollow cannot bring the row back`() {
        val gate = CompletableDeferred<List<BauFollow>>()
        val backend = FakeBackend()
        backend.channelFollows = listOf(follow("f1"))
        // The first read answers at once; the second (a reload on opening the
        // sheet) is held until after the unfollow.
        backend.channelFollowsHook = { n -> if (n == 1) listOf(follow("f1")) else gate.await() }
        val model = ChannelFollowsViewModel(backend, "c1")
        model.load()
        model.unfollow(model.state.value.follows[0])
        assertTrue(model.state.value.follows.isEmpty())

        gate.complete(listOf(follow("f1")))
        assertTrue("the stale answer is ignored", model.state.value.follows.isEmpty())
    }

    @Test
    fun `a channel that stops being manageable clears what it showed`() {
        val backend = FakeBackend()
        backend.channelFollows = listOf(follow("f1"))
        val model = ChannelFollowsViewModel(backend, "c1")
        backend.channelFollowsFail = ApiException(403, "no")
        model.load()
        assertFalse(model.state.value.visible)
    }
}
