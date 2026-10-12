package gg.pqp.app.ui.screens

import gg.pqp.app.core.Channel
import gg.pqp.app.core.VoiceParticipant
import gg.pqp.app.ui.screens.channels.ChannelUnread
import gg.pqp.app.ui.screens.channels.FoldedSummary
import gg.pqp.app.ui.screens.channels.LOOSE_SECTION
import gg.pqp.app.ui.screens.channels.RowEmphasis
import gg.pqp.app.ui.screens.channels.ServerActivity
import gg.pqp.app.ui.screens.channels.TEXT_SECTION
import gg.pqp.app.ui.screens.channels.UnreadLedger
import gg.pqp.app.ui.screens.channels.VOICE_SECTION
import gg.pqp.app.ui.screens.channels.channelsInCategory
import gg.pqp.app.ui.screens.channels.foldedSummary
import gg.pqp.app.ui.screens.channels.mutedChannelIds
import gg.pqp.app.ui.screens.channels.occupantSummary
import gg.pqp.app.ui.screens.channels.rowBadge
import gg.pqp.app.ui.screens.channels.sectionsOf
import gg.pqp.app.ui.screens.channels.serverActivity
import gg.pqp.app.ui.screens.channels.bumped
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
        assertEquals(ChannelUnread("a", 3, 1), bumped(ChannelUnread("a", 2, 1), "a", mention = false))
        assertEquals(ChannelUnread("b", 1, 1), bumped(null, "b", mention = true))
    }

    @Test
    fun `frames during a request are a floor, never added twice`() {
        val ledger = UnreadLedger()
        var ticket = ledger.begin()
        ledger.activity("a", mention = true)
        // The answer predates the frame: the frame survives.
        assertEquals(ChannelUnread("a", 1, 1), ledger.snapshot(ticket, emptyMap())?.counts?.get("a"))
        ticket = ledger.begin()
        ledger.activity("a", mention = false)
        // The answer already includes the frame: it is not counted again.
        assertEquals(ChannelUnread("a", 2, 1), ledger.snapshot(ticket, mapOf("a" to ChannelUnread("a", 2, 1)))?.counts?.get("a"))
    }

    @Test
    fun `an answer from before the frame does not roll a busy channel back`() {
        val ledger = UnreadLedger()
        ledger.snapshot(ledger.begin(), mapOf("a" to ChannelUnread("a", 5, 0)))
        val ticket = ledger.begin()
        assertEquals(6, ledger.activity("a", mention = false).count)
        assertEquals(6, ledger.snapshot(ticket, mapOf("a" to ChannelUnread("a", 5, 0)))?.counts?.get("a")?.count)
    }

    @Test
    fun `frames are not buffered once no request is pending`() {
        val ledger = UnreadLedger()
        val ticket = ledger.begin()
        ledger.abandon(ticket)
        assertEquals(ChannelUnread("a", 1, 0), ledger.activity("a", mention = false))
        val next = ledger.begin()
        // Read elsewhere meanwhile: the server's zero wins, nothing stale is replayed.
        assertEquals(0, ledger.snapshot(next, mapOf("a" to ChannelUnread("a", 0, 0)))?.counts?.get("a")?.count)
    }

    @Test
    fun `an older snapshot is dropped once a newer request started`() {
        val ledger = UnreadLedger()
        val old = ledger.begin()
        val fresh = ledger.begin()
        assertEquals(null, ledger.snapshot(old, mapOf("a" to ChannelUnread("a", 9, 0))))
        assertEquals(1, ledger.snapshot(fresh, mapOf("a" to ChannelUnread("a", 1, 0)))?.counts?.get("a")?.count)
    }

    @Test
    fun `a frame during the request asks for one settling re-read`() {
        val ledger = UnreadLedger()
        ledger.snapshot(ledger.begin(), mapOf("a" to ChannelUnread("a", 2, 0)))
        val ticket = ledger.begin()
        ledger.activity("a", mention = false)
        // A stale 5 that may or may not include the frame: a floor, not the truth.
        val first = ledger.snapshot(ticket, mapOf("a" to ChannelUnread("a", 5, 0)))
        assertEquals(5, first?.counts?.get("a")?.count)
        assertEquals(true, first?.unsettled)
        // The settling read has nothing in flight, so its answer is taken as is.
        val settle = ledger.begin()
        val second = ledger.snapshot(settle, mapOf("a" to ChannelUnread("a", 6, 0)))
        assertEquals(6, second?.counts?.get("a")?.count)
        assertEquals(false, second?.unsettled)
    }

    @Test
    fun `a newer request keeps the frames an older one buffered`() {
        val ledger = UnreadLedger()
        ledger.snapshot(ledger.begin(), mapOf("a" to ChannelUnread("a", 5, 0)))
        val older = ledger.begin()
        ledger.activity("a", mention = true)
        val newer = ledger.begin()
        assertEquals(null, ledger.snapshot(older, mapOf("a" to ChannelUnread("a", 5, 0))))
        // The newer answer is just as stale: the frame from the older window survives.
        val answer = ledger.snapshot(newer, mapOf("a" to ChannelUnread("a", 5, 0)))
        assertEquals(ChannelUnread("a", 6, 1), answer?.counts?.get("a"))
        assertEquals(true, answer?.unsettled)
    }

    @Test
    fun `unread is bold, muted never is, and a mute hides mentions too`() {
        assertEquals(RowEmphasis.Quiet, rowBadge(null, muted = false).emphasis)
        assertEquals(RowEmphasis.Quiet, rowBadge(ChannelUnread("a", 0, 0), muted = false).emphasis)
        assertEquals(RowEmphasis.Unread, rowBadge(ChannelUnread("a", 4, 0), muted = false).emphasis)
        assertEquals(3, rowBadge(ChannelUnread("a", 4, 3), muted = false).mentions)
        val muted = rowBadge(ChannelUnread("a", 9, 2), muted = true)
        assertEquals(RowEmphasis.Muted, muted.emphasis)
        assertEquals(0, muted.mentions)
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
        assertTrue(three.overflowFaces.isEmpty() && three.overflowCount == 0)
    }

    @Test
    fun `past three, two keep their lines and the rest fold into one`() {
        val five = occupantSummary((1..5).map { person("$it") })
        assertEquals(listOf("1", "2"), five.listed.map { it.userId })
        assertEquals(listOf("3", "4", "5"), five.overflowFaces.map { it.userId })
        assertEquals(5, five.total)
    }

    @Test
    fun `the person holding the phone is never folded away`() {
        val summary = occupantSummary((1..5).map { person("$it") }, selfUserId = "5")
        assertEquals(listOf("5", "1"), summary.listed.map { it.userId })
        assertEquals(listOf("2", "3", "4"), summary.overflowFaces.map { it.userId })
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
    fun `a category is one section, every type mixed in its own order`() {
        val all = listOf(
            ch("cat", "category", pos = 0.0),
            ch("geral", "text", parent = "cat", pos = 1.0),
            ch("avisos", "text", parent = "cat", pos = 0.0),
            ch("lobby", "voice", parent = "cat", pos = 3.0),
            ch("party", "watch_party", parent = "cat"),
            ch("ajuda", "forum", parent = "cat", pos = 2.0),
            ch("mystery", "something-new", parent = "cat"),
            ch("top", "text"),
            ch("top-forum", "forum", pos = 1.0),
        )
        val sections = sectionsOf(all)
        assertEquals(listOf("text", "cat-cat"), sections.map { it.key })
        assertEquals(listOf("top", "top-forum"), sections[0].channels.map { it.id })
        // No text half and voice half: the voice room sits where it was put.
        assertEquals(listOf("avisos", "geral", "ajuda", "lobby"), sections[1].channels.map { it.id })
        assertEquals(null, sections[0].categoryId)
        assertEquals("cat", sections[1].category?.id)
        assertEquals(
            listOf("avisos", "geral", "ajuda", "lobby"),
            channelsInCategory(sections, "cat").map { it.id },
        )
    }

    @Test
    fun `a voice room between two text channels stays between them`() {
        val all = listOf(
            ch("cat", "category"),
            ch("clipes", "text", parent = "cat", pos = 0.0),
            ch("squad", "voice", parent = "cat", pos = 1.0),
            ch("lfg", "text", parent = "cat", pos = 2.0),
        )
        assertEquals(listOf("clipes", "squad", "lfg"), sectionsOf(all).single().channels.map { it.id })
        assertEquals(listOf("clipes", "squad", "lfg"), sectionsOf(all, mixed = true).single().channels.map { it.id })
    }

    @Test
    fun `old list - texto, then the categories, then voz, each with a heading that folds`() {
        val all = listOf(
            ch("cat", "category", pos = 0.0),
            ch("debug", "text", parent = "cat"),
            ch("geral", "text"),
            ch("lobby", "voice", pos = 1.0),
        )
        val sections = sectionsOf(all, textTitle = "Texto", voiceTitle = "Voz")
        assertEquals(listOf("text", "cat-cat", "voice"), sections.map { it.key })
        assertEquals(listOf(TEXT_SECTION, "cat", VOICE_SECTION), sections.map { it.categoryId })
        assertEquals(listOf("Texto", "cat", "Voz"), sections.map { it.title })
        assertEquals(listOf("lobby"), channelsInCategory(sections, VOICE_SECTION).map { it.id })
    }

    @Test
    fun `mixed list - loose channels on top in one order with no heading, then every category`() {
        val all = listOf(
            ch("canais", "category", pos = 0.0),
            ch("cinema", "category", pos = 1.0),
            ch("general", "text", parent = "canais"),
            ch("afk", "voice", pos = 0.0),
            ch("regras", "text", pos = 1.0),
            ch("filme", "watch_party", pos = 2.0),
        )
        val sections = sectionsOf(all, textTitle = "Texto", voiceTitle = "Voz", mixed = true)
        assertEquals(listOf(LOOSE_SECTION, "cat-canais"), sections.map { it.key })
        assertEquals(listOf("afk", "regras"), sections[0].channels.map { it.id })
        assertEquals("", sections[0].title)
        assertEquals(null, sections[0].categoryId)
        // An empty category only for someone who can put a channel in it.
        val manager = sectionsOf(all, mixed = true, keepEmptyCategories = true)
        assertEquals(listOf(LOOSE_SECTION, "cat-canais", "cat-cinema"), manager.map { it.key })
        assertTrue(manager.last().channels.isEmpty())
    }
}
