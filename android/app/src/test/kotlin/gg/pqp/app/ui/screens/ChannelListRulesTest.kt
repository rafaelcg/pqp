package gg.pqp.app.ui.screens

import gg.pqp.app.core.Channel
import gg.pqp.app.core.VoiceParticipant
import gg.pqp.app.ui.screens.channels.ChannelUnread
import gg.pqp.app.ui.screens.channels.FoldedSummary
import gg.pqp.app.ui.screens.channels.RowEmphasis
import gg.pqp.app.ui.screens.channels.ServerActivity
import gg.pqp.app.ui.screens.channels.channelsInCategory
import gg.pqp.app.ui.screens.channels.foldedSummary
import gg.pqp.app.ui.screens.channels.mutedChannelIds
import gg.pqp.app.ui.screens.channels.occupantSummary
import gg.pqp.app.ui.screens.channels.rowBadge
import gg.pqp.app.ui.screens.channels.sectionsOf
import gg.pqp.app.ui.screens.channels.serverActivity
import gg.pqp.app.ui.screens.channels.withActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The "Lista viva" rules, without Compose. */
class ChannelListRulesTest {

    private fun ch(id: String, type: String, parent: String? = null, pos: Double = 0.0) =
        Channel(id = id, name = id, type = type, parentId = parent, position = pos)

    private fun person(peer: String, user: String = peer) =
        VoiceParticipant(peerId = peer, userId = user, displayName = user)

    @Test
    fun `activity adds one unread and counts a mention only when it is one`() {
        val start = mapOf("a" to ChannelUnread("a", count = 2, mentions = 1))
        val next = start.withActivity("a", mention = false).withActivity("b", mention = true)
        assertEquals(ChannelUnread("a", 3, 1), next["a"])
        assertEquals(ChannelUnread("b", 1, 1), next["b"])
    }

    @Test
    fun `unread is bold, muted never is, and a mention survives the mute`() {
        assertEquals(RowEmphasis.Quiet, rowBadge(null, muted = false).emphasis)
        assertEquals(RowEmphasis.Quiet, rowBadge(ChannelUnread("a", 0, 0), muted = false).emphasis)
        assertEquals(RowEmphasis.Unread, rowBadge(ChannelUnread("a", 4, 0), muted = false).emphasis)
        val muted = rowBadge(ChannelUnread("a", 9, 2), muted = true)
        assertEquals(RowEmphasis.Muted, muted.emphasis)
        assertEquals(2, muted.mentions)
    }

    @Test
    fun `only none mutes a channel`() {
        assertEquals(
            setOf("x"),
            mutedChannelIds(mapOf("x" to "none", "y" to "mentions", "z" to "all")),
        )
        assertEquals(emptySet<String>(), mutedChannelIds(null))
    }

    @Test
    fun `a folded category counts its channels and dots only unread that is not muted`() {
        val channels = listOf(ch("a", "text"), ch("b", "text"), ch("v", "voice"))
        val unread = mapOf("b" to ChannelUnread("b", 3, 0))
        assertEquals(FoldedSummary(3, true), foldedSummary(channels, unread, muted = emptySet()))
        assertEquals(FoldedSummary(3, false), foldedSummary(channels, unread, muted = setOf("b")))
    }

    @Test
    fun `up to three people get a line each`() {
        val three = occupantSummary(listOf(person("1"), person("2"), person("3")))
        assertEquals(3, three.listed.size)
        assertTrue(three.overflow.isEmpty())
    }

    @Test
    fun `past three, two keep their lines and the rest fold into one`() {
        val five = occupantSummary((1..5).map { person("$it") })
        assertEquals(listOf("1", "2"), five.listed.map { it.userId })
        assertEquals(listOf("3", "4", "5"), five.overflow.map { it.userId })
        assertEquals(5, five.total)
    }

    @Test
    fun `the person holding the phone is never folded away`() {
        val summary = occupantSummary((1..5).map { person("$it") }, selfUserId = "5")
        assertEquals(listOf("5", "1"), summary.listed.map { it.userId })
        assertEquals(listOf("2", "3", "4"), summary.overflow.map { it.userId })
    }

    @Test
    fun `one person on two devices is one person`() {
        val summary = occupantSummary(listOf(person("p1", "ana"), person("p2", "ana"), person("p3", "bia")))
        assertEquals(listOf("ana", "bia"), summary.listed.map { it.userId })
    }

    @Test
    fun `the banner counts people across this server's rooms and the live channels`() {
        val activity = serverActivity(
            voiceChannelIds = listOf("v1", "v2"),
            rooms = mapOf(
                "v1" to listOf(person("1", "ana"), person("2", "bia")),
                "v2" to listOf(person("3", "ana")),
                "elsewhere" to listOf(person("4", "caio")),
            ),
            liveChannelIds = listOf("w1"),
        )
        assertEquals(ServerActivity(inCall = 2, live = 1), activity)
        assertTrue(serverActivity(emptyList(), emptyMap(), emptyList()).isEmpty)
    }

    @Test
    fun `sections keep the three position groups apart and draw only text and voice`() {
        val all = listOf(
            ch("cat", "category", pos = 0.0),
            ch("geral", "text", parent = "cat", pos = 1.0),
            ch("avisos", "text", parent = "cat", pos = 0.0),
            ch("lobby", "voice", parent = "cat", pos = 0.0),
            ch("party", "watch_party", parent = "cat"),
            ch("forum", "forum", parent = "cat"),
            ch("top", "text"),
        )
        val sections = sectionsOf(all)
        assertEquals(listOf("top-text", "cat-cat-text", "cat-cat-voice"), sections.map { it.key })
        assertEquals(listOf("avisos", "geral"), sections[1].channels.map { it.id })
        assertEquals(listOf("lobby"), sections[2].channels.map { it.id })
        assertEquals(null, sections[0].categoryId)
        assertEquals(
            listOf("avisos", "geral", "lobby"),
            channelsInCategory(sections, "cat").map { it.id },
        )
    }
}
