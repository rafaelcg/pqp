package gg.pqp.app.attachments

import gg.pqp.app.protocol.RepoSources
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android attachment constants against `packages/shared`, which owns them.
 *
 * Read `RepoSources` first for why these compare against the TypeScript on disk
 * rather than against a Kotlin constant. The specific hazard here: every value
 * in `Attachments.kt` is a hand-copy, nothing generates them, and each one is
 * enforced on the far side by a `400` that arrives in a mint response no user
 * ever sees. A widened allowlist that this client does not know about is a file
 * type nobody on Android can send; a narrowed one is a picker that offers a
 * file the server then refuses. Neither fails a compile on either side.
 */
class AttachmentContractTest {

    private val shared = "packages/shared/src/attachments.ts"
    private val chat = "packages/shared/src/chat.ts"

    /**
     * The `as const` array, read off the source.
     *
     * `RepoSources.enumValues` cannot be used: `ATTACHMENT_MIME_ALLOWLIST` is a
     * plain const array that `z.enum` is built *from*, not a `z.enum` literal.
     */
    private fun sharedAllowlist(): List<String> {
        val source = RepoSources.stripComments(RepoSources.read(shared))
        val block = Regex(
            """ATTACHMENT_MIME_ALLOWLIST\s*=\s*\[(.*?)]""",
            RegexOption.DOT_MATCHES_ALL,
        ).find(source) ?: error("No ATTACHMENT_MIME_ALLOWLIST in $shared")
        return Regex(""""([^"]+)"""")
            .findAll(block.groupValues[1])
            .map { it.groupValues[1] }
            .toList()
    }

    @Test
    fun `the allowlist parser still finds something`() {
        // A guard on the regex, not on the contract. Without it every
        // assertion below would pass vacuously the day the file is reformatted.
        assertTrue("Parsed no MIME types out of $shared", sharedAllowlist().size > 5)
    }

    @Test
    fun `the allowlist matches the server's, exactly and in order`() {
        assertEquals(sharedAllowlist(), ATTACHMENT_MIME_ALLOWLIST)
    }

    @Test
    fun `no alias maps onto something the server does not accept`() {
        // The aliases exist because Android reports types the allowlist does
        // not use. What they must never do is smuggle in a type the server
        // refuses, so every value one produces is checked against the source of
        // truth rather than against our own copy of it.
        val allowed = sharedAllowlist().toSet()
        for (type in ATTACHMENT_MIME_ALLOWLIST) {
            assertTrue("$type is not on the server's allowlist", type in allowed)
        }
        for (candidate in listOf(
            "image/jpg", "audio/mp3", "audio/x-wav", "video/quicktime", "application/x-pdf",
        )) {
            val resolved = attachmentContentTypeFor(candidate, "file.bin")
            assertTrue("$candidate resolved to $resolved, which the server refuses", resolved in allowed)
        }
    }

    @Test
    fun `every extension guess lands on the allowlist`() {
        val allowed = sharedAllowlist().toSet()
        for (name in listOf(
            "a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.avif", "a.mp4",
            "a.webm", "a.mp3", "a.ogg", "a.wav", "a.pdf", "a.txt",
        )) {
            val resolved = attachmentContentTypeFor(null, name)
            assertTrue("$name resolved to $resolved", resolved != null && resolved in allowed)
        }
    }

    @Test
    fun `the per-message ceiling matches`() {
        assertEquals(
            RepoSources.numberConstant(shared, "MAX_ATTACHMENTS_PER_MESSAGE"),
            MAX_ATTACHMENTS_PER_MESSAGE,
        )
    }

    @Test
    fun `the filename length limit matches`() {
        assertEquals(
            RepoSources.numberConstant(shared, "ATTACHMENT_FILENAME_MAX_LENGTH"),
            ATTACHMENT_FILENAME_MAX_LENGTH,
        )
    }

    @Test
    fun `the dimension ceiling matches`() {
        assertEquals(
            RepoSources.numberConstant(shared, "ATTACHMENT_MAX_DIMENSION"),
            ATTACHMENT_MAX_DIMENSION,
        )
    }

    @Test
    fun `the default byte ceiling matches`() {
        val source = RepoSources.stripComments(RepoSources.read(shared))
        val match = Regex(
            """DEFAULT_MAX_ATTACHMENT_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)""",
        ).find(source) ?: error("DEFAULT_MAX_ATTACHMENT_BYTES is no longer a product in $shared")
        val expected = match.groupValues
            .drop(1)
            .fold(1L) { total, part -> total * part.toLong() }
        assertEquals(expected, DEFAULT_MAX_ATTACHMENT_BYTES)
    }

    /**
     * The frame this client sends is still the frame the server parses.
     *
     * `message-create` carries the ids and nothing else, and the body floor of
     * one character comes off precisely so an attachment can carry a message on
     * its own. If either fact changes, an Android send starts being dropped in
     * silence, because there is no ack and no error frame on this socket.
     */
    @Test
    fun `message-create still takes attachmentIds and still allows an empty body`() {
        val source = RepoSources.stripComments(RepoSources.read(chat))
        assertTrue(
            "message-create no longer declares attachmentIds",
            source.contains("attachmentIds"),
        )
        assertTrue(
            "The body-or-attachment rule is gone from $chat",
            source.contains("requireBodyOrAttachment"),
        )
    }

    /**
     * `POST /api/channels/:channelId/attachments` still takes the five fields
     * this client fills in, under these names.
     */
    @Test
    fun `the mint request shape matches`() {
        assertEquals(
            listOf("filename", "contentType", "byteSize", "width", "height"),
            RepoSources.objectKeys(shared, "createAttachmentSchema"),
        )
        assertEquals(
            listOf("attachmentId", "uploadUrl", "expiresAt"),
            RepoSources.objectKeys(shared, "createAttachmentResponseSchema"),
        )
    }
}
