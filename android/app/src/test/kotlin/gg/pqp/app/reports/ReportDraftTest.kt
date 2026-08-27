package gg.pqp.app.reports

import gg.pqp.app.core.PqpJson
import gg.pqp.app.protocol.RepoSources
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What goes on the wire when somebody files a report.
 *
 * Two different kinds of check live here, and both matter for the same reason:
 * `POST /api/reports` refuses everything it cannot accept with a 404 or a 400
 * that says nothing specific, on purpose, so a body this client gets wrong is
 * indistinguishable from a subject that does not exist. Nothing about a
 * malformed report is diagnosable from the app.
 *
 * 1. The CONSTANTS are read out of `packages/shared/src/reports.ts` rather
 *    than restated, the same way `WireProtocolTest` reads the frame types. A
 *    reason string is a hand-copy and a mistyped one is a permanent 400.
 * 2. The BODY SHAPE is asserted as encoded JSON rather than as a Kotlin
 *    object, because `createReportSchema` is a discriminated union: each
 *    subject accepts a different set of keys, and a key that should have been
 *    absent is exactly what a data class with nullable fields hides.
 */
class ReportDraftTest {

    private val shared = "packages/shared/src/reports.ts"

    /** `REPORT_REASONS` is a plain `as const` array, not a `z.enum`. */
    private fun sharedReasons(): List<String> {
        val source = RepoSources.stripComments(RepoSources.read(shared))
        val block = Regex("""const\s+REPORT_REASONS\s*=\s*\[([^]]*)]""").find(source)
            ?: error("No REPORT_REASONS array in $shared")
        return Regex(""""([^"]+)"""").findAll(block.groupValues[1]).map { it.groupValues[1] }.toList()
    }

    private fun encode(target: ReportTarget, reason: ReportReason, details: String): JsonObject =
        PqpJson.encodeToString(
            CreateReportBody.serializer(),
            ReportDraft.body(target, reason, details),
        ).let { Json.parseToJsonElement(it) as JsonObject }

    @Test
    fun `the reasons are REPORT_REASONS, in order`() {
        assertEquals(
            "The wire values drifted from REPORT_REASONS. A reason the schema does not " +
                "know is a 400 that no amount of retrying fixes, and the reporter is told " +
                "nothing useful about why.",
            sharedReasons(),
            ReportReason.entries.map { it.wire },
        )
    }

    @Test
    fun `every reason has a label of its own`() {
        val labels = ReportReason.entries.map { it.label }
        assertEquals("Two reasons share a string resource", labels.size, labels.toSet().size)
    }

    @Test
    fun `the subject types are the ones the schema discriminates on`() {
        assertEquals(
            listOf("message", "user", "server"),
            RepoSources.enumValues(shared, "reportSubjectTypeSchema"),
        )
    }

    @Test
    fun `the details ceiling is the server's`() {
        assertEquals(
            RepoSources.numberConstant(shared, "REPORT_DETAILS_MAX_LENGTH"),
            ReportDraft.DETAILS_MAX_LENGTH,
        )
    }

    // --- details ---

    @Test
    fun `an empty or blank note is absent rather than empty`() {
        assertNull(ReportDraft.details(""))
        assertNull(ReportDraft.details("   \n\t "))
    }

    @Test
    fun `a note is trimmed the way the server trims it`() {
        assertEquals("ele mandou isso no privado", ReportDraft.details("  ele mandou isso no privado \n"))
    }

    @Test
    fun `a paste past the ceiling is cut here rather than refused there`() {
        val long = "a".repeat(ReportDraft.DETAILS_MAX_LENGTH + 500)
        assertEquals(ReportDraft.DETAILS_MAX_LENGTH, ReportDraft.details(long)?.length)
    }

    // --- body shape ---

    @Test
    fun `a message report names the message and nothing else`() {
        val body = encode(
            ReportTarget.Message(messageId = "m-1", authorName = "Alguém"),
            ReportReason.Harassment,
            "",
        )
        assertEquals(setOf("subjectType", "reason", "messageId"), body.keys)
        assertEquals("\"message\"", body.getValue("subjectType").toString())
        assertEquals("\"harassment\"", body.getValue("reason").toString())
        // The author's name is display-only. If it travelled, a client could
        // put words in somebody else's mouth inside a moderator's queue.
        assertFalse(body.toString().contains("Alguém"))
    }

    @Test
    fun `a user report with no server carries no server key at all`() {
        val body = encode(
            ReportTarget.Person(userId = "u-1", displayName = "Alguém"),
            ReportReason.Spam,
            "",
        )
        assertEquals(setOf("subjectType", "reason", "userId"), body.keys)
        assertEquals("\"user\"", body.getValue("subjectType").toString())
    }

    @Test
    fun `a user report filed from a server says which one`() {
        val body = encode(
            ReportTarget.Person(userId = "u-1", displayName = "Alguém", serverId = "s-1"),
            ReportReason.HateSpeech,
            "no canal geral",
        )
        assertEquals(setOf("subjectType", "reason", "userId", "serverId", "details"), body.keys)
        assertEquals("\"s-1\"", body.getValue("serverId").toString())
        assertEquals("\"no canal geral\"", body.getValue("details").toString())
    }

    @Test
    fun `a community report is its own subject type and not a user report`() {
        val body = encode(
            ReportTarget.Community(serverId = "s-1", name = "Comunidade"),
            ReportReason.IllegalContent,
            "",
        )
        assertEquals(setOf("subjectType", "reason", "serverId"), body.keys)
        // "server", not "community": the schema's discriminant is the storage
        // word. Sending "community" is a 400 the reporter cannot act on.
        assertEquals("\"server\"", body.getValue("subjectType").toString())
    }

    // --- where Report is offered ---

    @Test
    fun `only a listed community offers Report in the servers list`() {
        assertTrue(ReportDraft.canReportCommunity(true))
        assertFalse(ReportDraft.canReportCommunity(false))
    }
}
