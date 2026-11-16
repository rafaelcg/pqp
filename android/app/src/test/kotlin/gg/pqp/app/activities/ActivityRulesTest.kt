package gg.pqp.app.activities

import gg.pqp.app.activities.ActivityRules.StripAction
import gg.pqp.app.activities.ActivityRules.StripFace
import gg.pqp.app.core.Permission
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val ME = "11111111-1111-4111-8111-111111111111"
private const val OTHER = "22222222-2222-4222-8222-222222222222"

private fun app(
    id: String = "pqp-eco",
    category: String = "tool",
    channelTypes: List<String> = listOf("text", "voice"),
    available: Boolean = true,
    reason: String? = null,
    max: Int = 8,
    spectators: Boolean = true,
    shareAllowed: Boolean = true,
    start: String = "USE_APPS",
) = ActivityApp(
    id = id,
    version = "1.0.0",
    category = category,
    name = "name",
    channelTypes = channelTypes,
    available = available,
    reason = reason,
    shareAllowed = shareAllowed,
    players = ActivityPlayers(1, max, spectators, 50),
    requires = ActivityRequires(start = start),
    i18n = mapOf(
        "pt-BR" to mapOf("name" to "Eco"),
        "en" to mapOf("name" to "Echo"),
    ),
)

private fun session(players: Int = 1, spectators: Int = 0, participants: List<ActivitySessionParticipant> = emptyList(), host: String? = OTHER) =
    ActivitySession(
        id = "s", appId = "pqp-eco", hostUserId = host, startedBy = host, players = players, spectators = spectators,
        participants = participants,
    )

/** The picker's tiles, the strip's faces and what a phone does inside an app, from data alone. */
class ActivityRulesTest {

    @Test
    fun `an app's own words come in the person's language, then english, then the other one`() {
        val a = app()
        assertEquals("Eco", a.displayName("pt-BR"))
        assertEquals("Eco", a.displayName("pt"))
        assertEquals("Echo", a.displayName("en-US"))
        assertEquals("Echo", a.displayName("es-MX")) // no es table here: english
        assertEquals("missing", a.textFor("missing", "en"))
    }

    // --- the picker ---

    @Test
    fun `a tile that cannot start stays, with the first reason in the order a person meets them`() {
        val config = ActivitiesConfig(
            enabled = true,
            origin = "https://apps.example",
            apps = listOf(
                app("voice-only", channelTypes = listOf("voice")),
                app("off", available = false, reason = "not-allowed-here"),
                app("community", available = false, reason = "community-locked"),
                app("down", available = false, reason = "no-origin"),
                app("manage", start = "MANAGE_CHANNELS"),
                app("fine"),
            ),
        )
        val tiles = ActivityRules.tiles(config, "text", live = null, canUseApps = true, canManageChannels = false)
        assertEquals(
            listOf(
                TileReason.VoiceOnly, TileReason.OffHere, TileReason.Community,
                TileReason.Unavailable, TileReason.NeedsManage, null,
            ),
            tiles.map { it.reason },
        )
        val noPerm = ActivityRules.tiles(config, "text", null, canUseApps = false, canManageChannels = false)
        assertEquals("a permission is asked after the app's own gates", TileReason.NoPermission, noPerm.last().reason)
        assertEquals("the channel's kind comes before everything", TileReason.VoiceOnly, noPerm.first().reason)
    }

    @Test
    fun `only text and voice channels have a launcher at all`() {
        val config = ActivitiesConfig(enabled = true, origin = "https://apps.example", apps = listOf(app()))
        assertTrue(ActivityRules.launcherVisible(config, "text"))
        assertTrue(ActivityRules.launcherVisible(config, "voice"))
        for (other in listOf("watch_party", "forum", "jam", "category")) {
            assertFalse(other, ActivityRules.launcherVisible(config, other))
            assertTrue(other, ActivityRules.tiles(config, other, null, true, true).isEmpty())
        }
    }

    @Test
    fun `off, no origin or nothing released means no launcher`() {
        val one = listOf(app())
        assertFalse(ActivityRules.launcherVisible(ActivitiesConfig(enabled = false, origin = "x", apps = one), "text"))
        assertFalse(ActivityRules.launcherVisible(ActivitiesConfig(enabled = true, origin = null, apps = one), "text"))
        assertFalse(ActivityRules.launcherVisible(ActivitiesConfig(enabled = true, origin = "x", apps = listOf(app(available = false, reason = "owner-off"))), "text"))
        assertFalse(ActivityRules.launcherVisible(ActivitiesConfig(enabled = true, origin = "x", apps = listOf(app(channelTypes = listOf("voice")))), "text"))
    }

    @Test
    fun `the tile that starts selected is the running one, then the first that can start`() {
        val tiles = listOf(
            ActivityTile(app("a", available = false), TileReason.OffHere, running = false),
            ActivityTile(app("b"), null, running = false),
            ActivityTile(app("c"), null, running = true),
        )
        assertEquals("c", ActivityRules.initialSelection(tiles))
        assertEquals("b", ActivityRules.initialSelection(tiles.map { it.copy(running = false) }))
        assertEquals("a", ActivityRules.initialSelection(listOf(tiles[0])))
        assertNull(ActivityRules.initialSelection(emptyList()))
    }

    @Test
    fun `the use-apps and manage bits are read off the channel's resolved bits`() {
        assertTrue(ActivityRules.mayUseApps(Permission.USE_APPS))
        assertFalse(ActivityRules.mayUseApps(Permission.MANAGE_CHANNELS))
        assertTrue(ActivityRules.mayManageChannels(Permission.MANAGE_CHANNELS or Permission.USE_APPS))
    }

    // --- the strip ---

    @Test
    fun `the strip's face and button for someone outside, inside, or at a full room`() {
        val eco = app()
        val open = ActivityRules.stripFace(session(players = 2), eco, ME)
        assertEquals(StripFace.Open(full = false, canWatch = true), open)
        assertEquals(StripAction.Join, ActivityRules.stripAction(eco, open))

        val full = ActivityRules.stripFace(session(players = 8), eco, ME)
        assertEquals(StripAction.Watch, ActivityRules.stripAction(eco, full))
        val fullNoWatch = ActivityRules.stripFace(session(players = 8), app(spectators = false), ME)
        assertEquals(StripAction.Full, ActivityRules.stripAction(app(spectators = false), fullNoWatch))

        val inside = ActivityRules.stripFace(
            session(participants = listOf(ActivitySessionParticipant(ME, "spectator", connection = "reconnecting")), host = ME),
            eco,
            ME,
        )
        assertEquals(StripFace.Inside(spectator = true, host = true, reconnecting = true), inside)
        assertEquals(StripAction.Back, ActivityRules.stripAction(eco, inside))
    }

    @Test
    fun `an app the config no longer lists has no way in`() {
        val face = ActivityRules.stripFace(session(), null, ME)
        assertEquals(StripAction.None, ActivityRules.stripAction(null, face))
    }

    // --- what a phone can do inside ---

    @Test
    fun `an emulator is watched on a phone and anything else is played`() {
        val locadora = app("pqp-locadora", category = "emulator")
        assertFalse(ActivityRules.phoneMayPlay(locadora))
        assertTrue(ActivityRules.phoneMayPlay(app()))
        val open = ActivityRules.stripFace(session(), locadora, ME)
        assertEquals(StripAction.Watch, ActivityRules.stripAction(locadora, open))
        // watching an emulator needs the share flag (D14): off, the phone is told it is a computer thing
        val noShare = app("pqp-locadora", category = "emulator", shareAllowed = false)
        assertEquals(StripAction.ComputerOnly, ActivityRules.stripAction(noShare, ActivityRules.stripFace(session(), noShare, ME)))
    }

    @Test
    fun `a seat is asked for as a spectator when the phone can only watch, chose to, or the room is full`() {
        val eco = app()
        val locadora = app("pqp-locadora", category = "emulator")
        assertTrue(ActivityRules.joinAsSpectator(locadora, session(), ME, chosenToWatch = false))
        assertTrue(ActivityRules.joinAsSpectator(eco, session(), ME, chosenToWatch = true))
        assertFalse(ActivityRules.joinAsSpectator(eco, session(players = 2), ME, chosenToWatch = false))
        assertTrue(ActivityRules.joinAsSpectator(eco, session(players = 8), ME, chosenToWatch = false))
        assertFalse("somebody already in keeps their seat's role", ActivityRules.joinAsSpectator(
            eco, session(players = 8, participants = listOf(ActivitySessionParticipant(ME))), ME, chosenToWatch = false,
        ))
    }

    // --- the channel row ---

    @Test
    fun `a row is marked only for a channel of this list with a live session, and only while on`() {
        val config = ActivitiesConfig(enabled = true, origin = "x", apps = listOf(app()))
        val sessions = mapOf("c1" to session(players = 2, spectators = 1), "elsewhere" to session())
        val rows = ActivityRules.rowSummaries(config, sessions, listOf("c1", "c2"), "pt-BR")
        assertEquals(setOf("c1"), rows.keys)
        assertEquals(ActivityRowSummary("Eco", 3), rows["c1"])
        assertTrue(ActivityRules.rowSummaries(config.copy(enabled = false), sessions, listOf("c1"), "pt-BR").isEmpty())
        // released and then turned off while it ran: the id stands in for the name rather than hiding it
        assertEquals("pqp-eco", ActivityRules.rowSummaries(config.copy(apps = emptyList()), sessions, listOf("c1"), "en")["c1"]!!.appName)
    }

    @Test
    fun `a member is named by nickname, then display name, and nobody by a blank`() {
        assertEquals("Apelido", ActivityRules.nameOf(gg.pqp.app.core.ServerMember("u", "Ana", nickname = "Apelido")))
        assertEquals("Ana", ActivityRules.nameOf(gg.pqp.app.core.ServerMember("u", "Ana", nickname = "  ")))
        assertNull(ActivityRules.nameOf(gg.pqp.app.core.ServerMember("u", " ")))
        assertNull(ActivityRules.nameOf(null))
    }
}
