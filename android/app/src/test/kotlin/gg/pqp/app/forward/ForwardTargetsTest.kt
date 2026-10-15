package gg.pqp.app.forward

import gg.pqp.app.core.Channel
import gg.pqp.app.core.Permission
import gg.pqp.app.core.PermissionsSnapshot
import gg.pqp.app.core.ServerSummary
import gg.pqp.app.social.DmSummary
import gg.pqp.app.social.Friend
import gg.pqp.app.social.PublicUser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What the picker offers, how it orders and searches it, and the cap of five. */
class ForwardTargetsTest {

    private fun server(id: String, name: String) =
        ServerSummary(id = id, name = name, ownerId = "o", createdAt = "2026-01-01T00:00:00.000Z")

    private fun channel(id: String, name: String, type: String = "text", position: Double = 0.0, isPrivate: Boolean = false) =
        Channel(id = id, serverId = "s", name = name, type = type, position = position, isPrivate = isPrivate)

    private val send = Permission.SEND_MESSAGES.toString()

    private fun snapshot(vararg writable: String, server: String = "0") =
        PermissionsSnapshot(version = 1, server = server, channels = writable.associateWith { send })

    // ---- channelsOf

    @Test
    fun `only text channels you may write in are offered`() {
        val group = ForwardTargets.channelsOf(
            server("s", "QG"),
            listOf(
                channel("a", "geral"),
                channel("b", "avisos"),
                channel("c", "voz", type = "voice"),
                channel("d", "Canais", type = "category"),
                channel("e", "foruns", type = "forum"),
                channel("f", "party", type = "watch_party"),
            ),
            snapshot("a"),
        )
        assertEquals(listOf("a"), group.channels.map { it.channelId })
        assertEquals("QG", group.channels.single().serverName)
    }

    @Test
    fun `a channel with no entry follows the server-wide bits`() {
        val perms = PermissionsSnapshot(version = 1, server = send, channels = emptyMap())
        val group = ForwardTargets.channelsOf(server("s", "QG"), listOf(channel("a", "geral")), perms)
        assertEquals(1, group.channels.size)
    }

    @Test
    fun `a channel entry of zero wins over a permissive server`() {
        val perms = PermissionsSnapshot(version = 1, server = send, channels = mapOf("a" to "0"))
        assertTrue(ForwardTargets.channelsOf(server("s", "QG"), listOf(channel("a", "geral")), perms).channels.isEmpty())
    }

    @Test
    fun `no permission answer offers every text channel and leaves the refusal to the server`() {
        val group = ForwardTargets.channelsOf(
            server("s", "QG"),
            listOf(channel("a", "geral"), channel("c", "voz", type = "voice")),
            permissions = null,
        )
        assertEquals(listOf("a"), group.channels.map { it.channelId })
    }

    @Test
    fun `channels keep the server's order and a private one is marked`() {
        val group = ForwardTargets.channelsOf(
            server("s", "QG"),
            listOf(channel("b", "dois", position = 2.0), channel("a", "um", position = 1.0, isPrivate = true)),
            snapshot("a", "b"),
        )
        assertEquals(listOf("a", "b"), group.channels.map { it.channelId })
        assertTrue(group.channels.first().isPrivate)
    }

    // ---- peopleOf

    private fun user(id: String, name: String) = PublicUser(id = id, displayName = name)

    private fun dm(channelId: String, vararg people: PublicUser, kind: String = "dm") =
        DmSummary(channelId = channelId, kind = kind, participants = people.toList())

    private fun friend(id: String, name: String) = Friend(id = id, displayName = name)

    @Test
    fun `a friend with a dm appears once, as that dm`() {
        val people = ForwardTargets.peopleOf(
            conversations = listOf(dm("d1", user("u1", "Ana"))),
            friends = listOf(friend("u1", "Ana"), friend("u2", "Bia")),
            selfId = "me",
            titleOf = { it.participants.joinToString { p -> p.displayName } },
        )
        assertEquals(listOf("c:d1", "u:u2"), people.map { it.key })
        assertTrue(people.first() is ForwardTarget.Conversation)
        assertTrue(people.last() is ForwardTarget.Person)
    }

    @Test
    fun `a group is a conversation and does not hide its members as friends`() {
        val people = ForwardTargets.peopleOf(
            conversations = listOf(dm("g1", user("u1", "Ana"), user("u2", "Bia"), kind = "group")),
            friends = listOf(friend("u1", "Ana")),
            selfId = "me",
            titleOf = { "Ana, Bia" },
        )
        assertEquals(listOf("c:g1", "u:u1"), people.map { it.key })
        assertTrue((people.first() as ForwardTarget.Conversation).isGroup)
        assertNull((people.first() as ForwardTarget.Conversation).avatarUrl)
    }

    @Test
    fun `you are not your own friend suggestion`() {
        val people = ForwardTargets.peopleOf(emptyList(), listOf(friend("me", "Eu")), selfId = "me", titleOf = { "" })
        assertTrue(people.isEmpty())
    }

    @Test
    fun `a target becomes the wire reference the server reads`() {
        assertEquals(ForwardTargetRef(channelId = "c"), ForwardTarget.InChannel("c", "n", "s", "S", null, false).toRef())
        assertEquals(ForwardTargetRef(channelId = "d"), ForwardTarget.Conversation("d", "t", false, null, "x").toRef())
        assertEquals(ForwardTargetRef(userId = "u"), ForwardTarget.Person("u", "N", null).toRef())
    }

    // ---- list

    private val general = ForwardTarget.InChannel("c1", "geral", "s1", "QG", null, false)
    private val avisos = ForwardTarget.InChannel("c2", "avisos", "s1", "QG", null, false)
    private val clips = ForwardTarget.InChannel("c3", "clips", "s2", "Clube do Acai", null, false)
    private val groups = listOf(
        ForwardServerGroup("s1", "QG", null, listOf(general, avisos)),
        ForwardServerGroup("s2", "Clube do Acai", null, listOf(clips)),
    )
    private val ana = ForwardTarget.Conversation("d1", "Ana", false, null, "u1")
    private val bia = ForwardTarget.Person("u2", "Bia", null)
    private val people = listOf<ForwardTarget>(ana, bia)

    @Test
    fun `with no search and no recents everything is listed by section`() {
        val list = ForwardTargets.list(groups, people, recents = emptyList(), query = "")
        assertTrue(list.recent.isEmpty())
        assertEquals(listOf("c:d1", "u:u2"), list.people.map { it.key })
        assertEquals(listOf("s1", "s2"), list.servers.map { it.serverId })
    }

    @Test
    fun `recent targets come first, newest first, and are not repeated below`() {
        val list = ForwardTargets.list(groups, people, recents = listOf("c:c3", "c:d1", "c:gone"), query = "")
        assertEquals(listOf("c:c3", "c:d1"), list.recent.map { it.key })
        assertEquals(listOf("u:u2"), list.people.map { it.key })
        assertEquals(listOf("c:c1", "c:c2"), list.servers.single().channels.map { it.key })
    }

    @Test
    fun `a server with every channel in recents drops out of the lower list`() {
        val list = ForwardTargets.list(groups, people, recents = listOf("c:c3"), query = "")
        assertEquals(listOf("s1"), list.servers.map { it.serverId })
    }

    @Test
    fun `search matches a channel or its server, ignoring case and accents`() {
        assertEquals(listOf("c:c3"), ForwardTargets.list(groups, people, emptyList(), "AÇAI").servers.flatMap { it.channels }.map { it.key })
        assertEquals(listOf("c:c1", "c:c2"), ForwardTargets.list(groups, people, emptyList(), "qg").servers.flatMap { it.channels }.map { it.key })
        assertEquals(listOf("c:c2"), ForwardTargets.list(groups, people, emptyList(), "  avi ").servers.flatMap { it.channels }.map { it.key })
    }

    @Test
    fun `search finds people by name and filters recents too`() {
        val list = ForwardTargets.list(groups, people, recents = listOf("c:c3", "c:d1"), query = "ana")
        assertEquals(listOf("c:d1"), list.recent.map { it.key })
        assertTrue(list.people.isEmpty())
        assertTrue(list.servers.isEmpty())
        assertEquals(listOf("u:u2"), ForwardTargets.list(groups, people, emptyList(), "bia").people.map { it.key })
    }

    @Test
    fun `a search with no match is empty`() {
        assertTrue(ForwardTargets.list(groups, people, emptyList(), "zzz").isEmpty)
    }

    @Test
    fun `a restricted source offers only its own server`() {
        val list = ForwardTargets.list(groups, people, recents = listOf("c:c3", "c:d1", "c:c2"), query = "", restrictedToServerId = "s1")
        assertEquals(listOf("c:c2"), list.recent.map { it.key })
        assertTrue(list.people.isEmpty())
        assertEquals(listOf("s1"), list.servers.map { it.serverId })
        assertEquals(listOf("c:c1"), list.servers.single().channels.map { it.key })
    }

    // ---- selection

    @Test
    fun `picking adds in order and picking again removes`() {
        val (one, capped) = ForwardTargets.toggle(emptyList(), "a")
        assertEquals(listOf("a"), one)
        assertFalse(capped)
        assertEquals(listOf("a", "b"), ForwardTargets.toggle(one, "b").first)
        assertEquals(listOf("b"), ForwardTargets.toggle(listOf("a", "b"), "a").first)
    }

    @Test
    fun `the sixth pick is refused and says so`() {
        val five = listOf("a", "b", "c", "d", "e")
        assertEquals(FORWARD_MAX_TARGETS, five.size)
        val (same, capped) = ForwardTargets.toggle(five, "f")
        assertEquals(five, same)
        assertTrue(capped)
        // Removing one is always allowed at the cap.
        assertEquals(listOf("b", "c", "d", "e"), ForwardTargets.toggle(five, "a").first)
    }

    // ---- recents

    @Test
    fun `what was just sent leads the recents, without repeats, capped`() {
        assertEquals(listOf("x", "y", "a", "b"), ForwardTargets.bumpRecents(listOf("a", "x", "b"), listOf("x", "y")))
        val many = (1..20).map { "k$it" }
        assertEquals(ForwardTargets.RECENTS_CAP, ForwardTargets.bumpRecents(many, listOf("new")).size)
        assertEquals("new", ForwardTargets.bumpRecents(many, listOf("new")).first())
    }
}
