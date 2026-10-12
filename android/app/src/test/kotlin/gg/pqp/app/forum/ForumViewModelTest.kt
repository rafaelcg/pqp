package gg.pqp.app.forum

import gg.pqp.app.core.Permission
import gg.pqp.app.core.PermissionsSnapshot
import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.RealtimeState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The forum screen's view model against a fake backend: page 1 and the read
 * that follows it, the two frames through the list reducer (in place at the
 * top, queued while scrolled, flushed on the way back), filters re-reading
 * page 1 and being remembered, and a reconnect merging instead of resetting.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ForumViewModelTest {

    private class FakeBackend : ForumBackend {
        override val viewerId: String? = "me"
        override val frames = MutableSharedFlow<JsonObject>(extraBufferCapacity = 16)
        override val connection = MutableStateFlow(RealtimeState.Ready)

        val pages = ArrayDeque<ForumPostListResponse>()
        val queries = mutableListOf<ForumQuery>()
        val reads = mutableListOf<String>()
        val joins = mutableListOf<String>()
        var settings = ForumSettings()
        var bits: Long = Permission.SEND_MESSAGES
        var enabled = true

        override suspend fun page(forumId: String, query: ForumQuery): ForumPostListResponse {
            queries += query
            return pages.removeFirstOrNull() ?: ForumPostListResponse()
        }
        override suspend fun tags(forumId: String) = listOf(ForumTag("t1", "Bug", position = 0))
        override suspend fun settings(forumId: String) = settings
        override suspend fun config(serverId: String) = ForumConfig(enabled)
        override suspend fun permissions(serverId: String) = PermissionsSnapshot(server = bits.toString())
        override fun join(forumId: String) {
            joins += forumId
        }
        override fun markRead(channelId: String) {
            reads += channelId
        }
    }

    private fun post(id: String, minute: Int, replies: Int = 0, author: String = "bob") = ForumPostSummary(
        id = id,
        forumId = "f",
        title = "Post $id",
        authorId = author,
        createdAt = "2026-10-11T10:%02d:00.000Z".format(minute),
        lastActivityAt = "2026-10-11T10:%02d:00.000Z".format(minute + replies),
        replyCount = replies,
    )

    private fun page(vararg posts: ForumPostSummary) = ForumPostListResponse(
        posts = posts.toList(),
        viewer = posts.map { ForumPostViewer(it.id) },
        counts = ForumCounts(posts.size, posts.size),
        forumPreviousReadAt = "2026-10-11T09:00:00.000Z",
    )

    private fun upsertFrame(post: ForumPostSummary): JsonObject = PqpJson.parseToJsonElement(
        """{"type":"forum-post-upsert","forumId":"f","post":${PqpJson.encodeToString(ForumPostSummary.serializer(), post)}}""",
    ).jsonObject

    private fun removedFrame(id: String): JsonObject =
        PqpJson.parseToJsonElement("""{"type":"forum-post-removed","forumId":"f","postId":"$id"}""").jsonObject

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun model(backend: FakeBackend, saved: SavedForumFilters? = null, onSaved: (SavedForumFilters) -> Unit = {}) =
        ForumViewModel(backend, "s", "f", saved, onSaved, searchDebounceMs = 0)

    @Test
    fun `page 1 loads, then the forum is marked read, and the forum takes its slot`() = runTest {
        val backend = FakeBackend().apply { pages += page(post("b", 2), post("a", 1)) }
        val vm = model(backend)
        val state = vm.state.value
        assertFalse(state.loading)
        assertEquals(listOf("b", "a"), state.list.posts.map { it.id })
        assertEquals(listOf("f"), backend.reads)
        assertEquals(listOf("f"), backend.joins)
        assertTrue(state.mayCreate)
        assertFalse(state.isStaff)
        assertEquals("no saved sort asks for the forum's default", null, backend.queries.single().sort)
    }

    @Test
    fun `frames go through the reducer, held while scrolled and flushed on the way back`() = runTest {
        val backend = FakeBackend().apply { pages += page(post("b", 2), post("a", 1)) }
        val vm = model(backend)

        backend.frames.emit(upsertFrame(post("c", 3)))
        assertEquals(listOf("c", "b", "a"), vm.state.value.list.posts.map { it.id })

        vm.setHold(true)
        backend.frames.emit(upsertFrame(post("d", 4)))
        assertEquals(listOf("c", "b", "a"), vm.state.value.list.posts.map { it.id })
        assertEquals(listOf("d"), vm.state.value.list.queued.map { it.id })

        vm.setHold(false)
        assertEquals(listOf("d", "c", "b", "a"), vm.state.value.list.posts.map { it.id })
        assertTrue(vm.state.value.list.queued.isEmpty())

        backend.frames.emit(removedFrame("b"))
        assertEquals(listOf("d", "c", "a"), vm.state.value.list.posts.map { it.id })
    }

    @Test
    fun `a frame for another forum is not this list's`() = runTest {
        val backend = FakeBackend().apply { pages += page(post("a", 1)) }
        val vm = model(backend)
        backend.frames.emit(upsertFrame(post("x", 5).copy(forumId = "other")))
        assertEquals(listOf("a"), vm.state.value.list.posts.map { it.id })
    }

    @Test
    fun `a filter re-reads page 1 and is remembered without the search`() = runTest {
        val backend = FakeBackend().apply {
            pages += page(post("b", 2), post("a", 1))
            pages += page(post("a", 1))
        }
        var saved: SavedForumFilters? = null
        val vm = model(backend) { saved = it }
        vm.toggleTag("t1")
        assertEquals(listOf("t1"), backend.queries.last().tagIds)
        assertEquals(listOf("a"), vm.state.value.list.posts.map { it.id })
        assertEquals(listOf("t1"), saved?.filters?.tagIds)
        assertFalse(saved!!.sortExplicit)

        vm.setSort(ForumSort.Created)
        assertEquals(ForumSort.Created, backend.queries.last().sort)
        assertTrue(saved!!.sortExplicit)

        vm.setQuery("tela azul")
        assertEquals("tela azul", backend.queries.last().q)
        assertEquals("", saved!!.filters.q)
    }

    @Test
    fun `the forum's default sort is adopted when the reader never chose one`() = runTest {
        val backend = FakeBackend().apply {
            settings = ForumSettings(defaultSort = "created")
            pages += page(post("a", 1))
        }
        val vm = model(backend)
        assertEquals(ForumSort.Created, vm.state.value.filters.sort)
        assertEquals(1, backend.queries.size)
    }

    @Test
    fun `staff, and the paused flag`() = runTest {
        val backend = FakeBackend().apply {
            bits = Permission.SEND_MESSAGES or Permission.MANAGE_MESSAGES
            enabled = false
            pages += page()
        }
        val vm = model(backend)
        assertTrue(vm.state.value.isStaff)
        assertFalse(vm.state.value.mayCreate)
        assertTrue(vm.state.value.forumEmpty)
    }

    @Test
    fun `a reconnect merges page 1 instead of resetting`() = runTest {
        val backend = FakeBackend().apply { pages += page(post("b", 2), post("a", 1)) }
        val vm = model(backend)
        vm.setHold(true)
        backend.frames.emit(upsertFrame(post("q", 9)))
        // Read after this visit moved the cursor: "Novo" still measures from before the visit.
        backend.pages += page(post("c", 3), post("b", 2)).copy(forumPreviousReadAt = "2026-10-11T12:00:00.000Z")
        backend.connection.value = RealtimeState.Reconnecting
        backend.connection.value = RealtimeState.Ready
        assertEquals(listOf("c", "b"), vm.state.value.list.posts.map { it.id })
        assertEquals("2026-10-11T09:00:00.000Z", vm.state.value.list.forumPreviousReadAt)
        assertEquals("still queued for the pill", listOf("q"), vm.state.value.list.queued.map { it.id })
        assertEquals(listOf("f", "f"), backend.joins)
    }

    @Test
    fun `coming back from a post marks it read on the card`() = runTest {
        val backend = FakeBackend().apply { pages += page(post("a", 1, replies = 2)) }
        val vm = model(backend)
        vm.setOpenPost("a")
        vm.setOpenPost(null)
        assertEquals(ForumUnread.Read, ForumList.unread(vm.state.value.list.posts[0], vm.state.value.list.viewer["a"], "me", null))
    }

    @Test
    fun `a frame that lands while page 1 is out survives the page's answer`() = runTest {
        val gate = kotlinx.coroutines.CompletableDeferred<ForumPostListResponse>()
        val fake = FakeBackend()
        val backend = object : ForumBackend by fake {
            override suspend fun page(forumId: String, query: ForumQuery) = gate.await()
        }
        val vm = ForumViewModel(backend, "s", "f", searchDebounceMs = 0)
        fake.frames.emit(upsertFrame(post("c", 3)))
        gate.complete(page(post("b", 2), post("a", 1)))
        assertEquals(listOf("c", "b", "a"), vm.state.value.list.posts.map { it.id })
    }

    @Test
    fun `a failed page 1 says so, and a retry recovers`() = runTest {
        val backend = object : ForumBackend by FakeBackend() {
            var fail = true
            override suspend fun page(forumId: String, query: ForumQuery): ForumPostListResponse {
                if (fail) error("offline")
                return ForumPostListResponse(posts = listOf(post("a", 1)))
            }
        }
        val vm = ForumViewModel(backend, "s", "f", searchDebounceMs = 0)
        assertTrue(vm.state.value.loadError)
        backend.fail = false
        vm.reload()
        assertFalse(vm.state.value.loadError)
        assertNull(vm.state.value.list.nextCursor)
        assertEquals(1, vm.state.value.list.posts.size)
    }
}
