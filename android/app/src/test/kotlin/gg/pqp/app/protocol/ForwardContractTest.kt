package gg.pqp.app.protocol

import gg.pqp.app.forward.CreateForwardRequest
import gg.pqp.app.forward.FORWARD_COMMENT_MAX
import gg.pqp.app.forward.FORWARD_FALLBACK_PREFIX
import gg.pqp.app.forward.FORWARD_KIND_BAU_POST
import gg.pqp.app.forward.FORWARD_KIND_MESSAGE
import gg.pqp.app.forward.FORWARD_MAX_TARGETS
import gg.pqp.app.forward.FORWARD_VERSION
import gg.pqp.app.forward.ForwardLinks
import gg.pqp.app.forward.ForwardRefusal
import gg.pqp.app.forward.ForwardSource
import gg.pqp.app.forward.ForwardTargetRef
import gg.pqp.app.forward.MessageForward
import kotlinx.serialization.descriptors.elementNames
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Encaminhar's Kotlin half against `packages/shared/src/forward.ts` and the
 * server's route table. A rename or a changed limit there fails here, not as a
 * card that quietly stops drawing.
 *
 * The one-way rule of `ModelShapeTest`: every field Kotlin names must exist on
 * the schema, because a renamed key decodes to a default with no error.
 */
class ForwardContractTest {

    private val shared = "packages/shared/src/forward.ts"

    private fun source() = RepoSources.stripComments(RepoSources.read(shared))

    private fun constant(name: String): String =
        Regex("""export const $name\s*=\s*([^;]+);""").find(source())?.groupValues?.get(1)?.trim()
            ?: error("No `export const $name` in $shared")

    @Test
    fun `MessageForward names only fields messageForwardSchema has`() {
        val schema = RepoSources.objectKeys(shared, "messageForwardSchema").toSet()
        assertEquals(
            emptySet<String>(),
            MessageForward.serializer().descriptor.elementNames.toSet() - schema,
        )
    }

    @Test
    fun `the request names only fields the schemas have`() {
        assertEquals(
            emptySet<String>(),
            CreateForwardRequest.serializer().descriptor.elementNames.toSet() -
                RepoSources.objectKeys(shared, "createForwardSchema").toSet(),
        )
        assertEquals(
            emptySet<String>(),
            ForwardSource.serializer().descriptor.elementNames.toSet() -
                RepoSources.objectKeys(shared, "forwardSourceSchema").toSet(),
        )
        // A target is `{ channelId }` or `{ userId }`, each its own strict object.
        val text = source()
        for (key in ForwardTargetRef.serializer().descriptor.elementNames) {
            assertTrue("forwardTargetSchema has no `$key`", text.contains("z.object({ $key: z.string().uuid() })"))
        }
    }

    @Test
    fun `the limits are the schema's`() {
        assertEquals(FORWARD_MAX_TARGETS.toString(), constant("FORWARD_MAX_TARGETS"))
        assertEquals(FORWARD_COMMENT_MAX.toString(), constant("FORWARD_COMMENT_MAX"))
        assertEquals(FORWARD_VERSION.toString(), constant("FORWARD_VERSION"))
    }

    @Test
    fun `the fallback prefix and cut are the schema's`() {
        assertEquals("\"$FORWARD_FALLBACK_PREFIX\"", constant("FORWARD_FALLBACK_PREFIX"))
        // Not exported, so read out of the file: `const FORWARD_FALLBACK_TEXT_MAX = 140;`.
        val cut = Regex("""const FORWARD_FALLBACK_TEXT_MAX\s*=\s*(\d+);""").find(source())?.groupValues?.get(1)
        assertEquals("140", cut)
    }

    @Test
    fun `the kinds are the schema's`() {
        val kinds = Regex("""forwardKindSchema\s*=\s*z\.enum\(\[([^\]]*)]""").find(source())?.groupValues?.get(1)
            ?.let { Regex("\"([^\"]+)\"").findAll(it).map { m -> m.groupValues[1] }.toList() }
        assertEquals(listOf(FORWARD_KIND_BAU_POST, FORWARD_KIND_MESSAGE), kinds)
    }

    @Test
    fun `every refusal reason the schema names is one this build knows`() {
        val block = Regex("""forwardRefusalReasonSchema\s*=\s*z\.enum\(\[([^\]]*)]""").find(source())?.groupValues?.get(1)
            ?: error("No forwardRefusalReasonSchema in $shared")
        val reasons = Regex("\"([^\"]+)\"").findAll(block).map { it.groupValues[1] }.toList()
        assertEquals(reasons, ForwardRefusal.entries.map { it.wire })
    }

    @Test
    fun `the message jump link is the schema's`() {
        // forwardMessagePath builds `/app/server/<s>/channel/<c>/message/<m>`.
        assertTrue(
            source().contains("/app/server/\${encodeURIComponent(serverId)}/channel/\${encodeURIComponent("),
        )
        assertTrue(source().contains("/message/\${encodeURIComponent(messageId)}"))
        assertEquals("/app/server/s/channel/c/message/m", ForwardLinks.messagePath("s", "c", "m"))
    }

    @Test
    fun `the server answers the two routes this build calls`() {
        val api = RepoSources.read("server/src/api/index.ts")
        assertTrue(api.contains("router.get(\"/api/forwards/config\""))
        assertTrue(api.contains("router.post(\"/api/forwards\""))
    }

    @Test
    fun `forward rides on both message shapes`() {
        assertTrue(RepoSources.objectKeys("packages/shared/src/api.ts", "messageSchema").contains("forward"))
        assertTrue(
            RepoSources.objectKeys("packages/shared/src/chat.ts", "broadcastMessageSchema").contains("forward"),
        )
    }
}
