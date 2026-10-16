package gg.pqp.app.core

import gg.pqp.app.protocol.RepoSources
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two frames addressed to the account itself. The rules are the web's (`client/src/App.tsx`
 * for `server-removed`, `client/src/hooks/use-status.ts` for `own-status`), and the contract tests
 * read the shared schemas so a reason or a status added on the server fails here first.
 */
class AccountFramesTest {

    private fun frame(json: String): JsonObject = PqpJson.decodeFromString(JsonObject.serializer(), json)

    private fun server(id: String, name: String = "Sala", role: String? = "member") =
        ServerSummary(id = id, name = name, ownerId = "o", role = role, createdAt = "2026-10-01T00:00:00Z")

    // --- contract ---

    @Test
    fun `the removal reasons are the shared ones`() {
        val source = RepoSources.read("packages/shared/src/moderation.ts")
        val body = Regex("""type:\s*z\.literal\("server-removed"\),[^}]*?reason:\s*z\.enum\(\[([^\]]*)]""", RegexOption.DOT_MATCHES_ALL)
            .find(source)!!.groupValues[1]
        val shared = Regex(""""([a-z]+)"""").findAll(body).map { it.groupValues[1] }.toList()
        assertEquals(shared, ServerRemovedReason.entries.map { it.wire })
    }

    @Test
    fun `the manual statuses are the shared ones`() {
        assertEquals(RepoSources.enumValues("packages/shared/src/status.ts", "manualStatusSchema"), OwnStatus.CHOICES)
        assertEquals(RepoSources.stringConstant("packages/shared/src/status.ts", "DEFAULT_MANUAL_STATUS"), OwnStatus.DEFAULT)
    }

    // --- server-removed ---

    @Test
    fun `a removal frame names a server and a known reason, nothing else is one`() {
        val ok = AccountFrames.serverRemoved(frame("""{"type":"server-removed","serverId":"s1","reason":"banned"}"""))
        assertEquals(ServerRemoved("s1", ServerRemovedReason.Banned), ok)
        assertNull(AccountFrames.serverRemoved(frame("""{"type":"server-removed","serverId":"s1","reason":"vanished"}""")))
        assertNull(AccountFrames.serverRemoved(frame("""{"type":"server-removed","reason":"kicked"}""")))
        assertNull(AccountFrames.serverRemoved(frame("""{"type":"server-removed","serverId":"","reason":"kicked"}""")))
        assertNull(AccountFrames.serverRemoved(frame("""{"type":"channels-update","serverId":"s1","reason":"kicked"}""")))
    }

    @Test
    fun `a removal drops the server from the list and says which, in the order it was`() {
        val held = listOf(server("a"), server("b", "Dois"), server("c"))
        val (rest, gone) = AccountFrames.apply(held, ServerRemoved("b", ServerRemovedReason.Kicked))!!
        assertEquals(listOf("a", "c"), rest.map { it.id })
        assertEquals(ServerGone("b", "Dois", ServerRemovedReason.Kicked, quiet = false), gone)
    }

    @Test
    fun `a server the phone does not hold is not news`() {
        assertNull(AccountFrames.apply(listOf(server("a")), ServerRemoved("zzz", ServerRemovedReason.Deleted)))
        assertNull(AccountFrames.apply(emptyList(), ServerRemoved("a", ServerRemovedReason.Banned)))
    }

    @Test
    fun `the ids are matched without regard to case, as a link's are`() {
        val (rest, _) = AccountFrames.apply(listOf(server("AbC")), ServerRemoved("abc", ServerRemovedReason.Banned))!!
        assertTrue(rest.isEmpty())
    }

    @Test
    fun `only the owner's own delete is quiet`() {
        val owned = listOf(server("a", role = "owner"))
        assertTrue(AccountFrames.apply(owned, ServerRemoved("a", ServerRemovedReason.Deleted))!!.second.quiet)
        // A member told their community was deleted is told.
        assertFalse(AccountFrames.apply(listOf(server("a")), ServerRemoved("a", ServerRemovedReason.Deleted))!!.second.quiet)
        // A kick or a ban is never quiet, whoever it lands on.
        assertFalse(AccountFrames.apply(owned, ServerRemoved("a", ServerRemovedReason.Banned))!!.second.quiet)
    }

    // --- own-status ---

    @Test
    fun `an own-status frame carries a manual status this build knows`() {
        assertEquals("dnd", AccountFrames.ownStatus(frame("""{"type":"own-status","status":"dnd"}""")))
        assertEquals("invisible", AccountFrames.ownStatus(frame("""{"type":"own-status","status":"invisible"}""")))
        assertNull(AccountFrames.ownStatus(frame("""{"type":"own-status","status":"busy"}""")))
        // `idle` is what others are told, not something an account chooses.
        assertNull(AccountFrames.ownStatus(frame("""{"type":"own-status","status":"idle"}""")))
        assertNull(AccountFrames.ownStatus(frame("""{"type":"own-status"}""")))
        assertNull(AccountFrames.ownStatus(frame("""{"type":"profile-update","status":"dnd"}""")))
    }

    @Test
    fun `a stored status reads as online unless it is one this build knows`() {
        assertEquals("online", OwnStatus.read(null))
        assertEquals("online", OwnStatus.read("busy"))
        assertEquals("away", OwnStatus.read("away"))
    }

    @Test
    fun `frames held during a save need a read back only when one of them disagrees`() {
        assertFalse(OwnStatus.needsReadBack("dnd", emptyList()))
        // The echo of our own write, however many times it arrives.
        assertFalse(OwnStatus.needsReadBack("dnd", listOf("dnd", "dnd")))
        // Another device wrote at once: the server's copy decides, not arrival order.
        assertTrue(OwnStatus.needsReadBack("dnd", listOf("dnd", "away")))
        assertTrue(OwnStatus.needsReadBack("dnd", listOf("online")))
    }

    @Test
    fun `the preferences blob decodes a status and tolerates its absence`() {
        val with = PqpJson.decodeFromString(MePreferences.serializer(), """{"status":"away","unknown":1}""")
        assertEquals("away", with.status)
        assertNull(PqpJson.decodeFromString(MePreferences.serializer(), "{}").status)
    }
}
