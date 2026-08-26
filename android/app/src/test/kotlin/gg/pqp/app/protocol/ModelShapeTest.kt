package gg.pqp.app.protocol

import gg.pqp.app.core.Attachment
import gg.pqp.app.core.Channel
import gg.pqp.app.core.IceServer
import gg.pqp.app.core.Me
import gg.pqp.app.core.Message
import gg.pqp.app.core.Reaction
import gg.pqp.app.core.ReplyRef
import gg.pqp.app.core.ServerSummary
import gg.pqp.app.core.VoiceParticipant
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.elementNames
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Every field name in a Kotlin model against the zod schema that produces it.
 *
 * This client models a deliberate *subset* of the API, so the check that
 * matters runs one way: every field the Kotlin side names must exist on the
 * shared schema. That is what catches a **rename**, which is the failure with
 * no runtime symptom at all — `Message.authorName` quietly decodes to nothing
 * once the server calls it something else, `ChatViewModel.message()` swallows
 * the throw in `runCatching { }.getOrNull()`, and the message simply never
 * appears.
 *
 * The other direction (a field the server has and Kotlin does not) is a feature
 * gap by design and is not asserted, because asserting it would fail on every
 * server-side feature this client has not caught up with.
 *
 * The field names come from the serializer descriptor rather than from
 * reflection over the data class, so a `@SerialName` rename is what is checked,
 * which is what actually travels.
 */
class ModelShapeTest {

    private val api = "packages/shared/src/api.ts"
    private val signaling = "packages/shared/src/signaling.ts"
    private val attachments = "packages/shared/src/attachments.ts"

    private fun assertSubsetOfSchema(
        serializer: KSerializer<*>,
        relativePath: String,
        schemaName: String,
        /** Fields on the wire but deliberately absent from the shared schema. */
        knownExtras: Set<String> = emptySet(),
    ) {
        val schemaKeys = RepoSources.objectKeys(relativePath, schemaName).toSet()
        val kotlinKeys = serializer.descriptor.elementNames.toSet()
        val orphans = kotlinKeys - schemaKeys - knownExtras
        assertEquals(
            "${serializer.descriptor.serialName} names fields that $schemaName in " +
                "$relativePath does not have. Either the server renamed them (and this " +
                "model now decodes them to their defaults, silently) or they were never " +
                "on the wire.",
            emptySet<String>(),
            orphans,
        )
    }

    @Test
    fun `Me matches userSchema`() {
        assertSubsetOfSchema(Me.serializer(), api, "userSchema")
    }

    @Test
    fun `ServerSummary matches serverSchema`() {
        assertSubsetOfSchema(ServerSummary.serializer(), api, "serverSchema")
    }

    @Test
    fun `Channel matches channelSchema`() {
        assertSubsetOfSchema(Channel.serializer(), api, "channelSchema")
    }

    @Test
    fun `Message matches messageSchema`() {
        assertSubsetOfSchema(
            Message.serializer(),
            api,
            "messageSchema",
            // On the wire and absent from the schema on purpose: the server
            // adds it in `mapMessage` so a blocked author's row still travels
            // and paging stays correct. Decoded defensively, like iOS.
            knownExtras = setOf("blocked"),
        )
    }

    @Test
    fun `Reaction matches messageReactionSchema`() {
        assertSubsetOfSchema(Reaction.serializer(), api, "messageReactionSchema")
    }

    @Test
    fun `ReplyRef matches messageReplyRefSchema`() {
        assertSubsetOfSchema(ReplyRef.serializer(), api, "messageReplyRefSchema")
    }

    @Test
    fun `Attachment matches attachmentSchema`() {
        assertSubsetOfSchema(Attachment.serializer(), attachments, "attachmentSchema")
    }

    @Test
    fun `IceServer matches iceServerSchema`() {
        assertSubsetOfSchema(IceServer.serializer(), api, "iceServerSchema")
    }

    @Test
    fun `VoiceParticipant matches voiceParticipantSchema`() {
        assertSubsetOfSchema(VoiceParticipant.serializer(), signaling, "voiceParticipantSchema")
    }

    /**
     * The fields the roster cannot work without.
     *
     * `VoiceParticipant` is decoded inside `runCatching { }.getOrNull()`, so a
     * missing required field turns the whole roster into an empty list with no
     * log line. Naming them here means a rename fails the build instead.
     */
    @Test
    fun `the voice roster fields the call bar depends on are all modelled`() {
        val required = setOf("peerId", "userId", "displayName", "muted", "deafened", "sharingScreen")
        val modelled = VoiceParticipant.serializer().descriptor.elementNames.toSet()
        assertEquals("Roster fields no longer modelled", emptySet<String>(), required - modelled)

        val declared = RepoSources.objectKeys(signaling, "voiceParticipantSchema").toSet()
        assertEquals(
            "Roster fields the shared schema no longer declares",
            emptySet<String>(),
            required - declared,
        )
    }

    /**
     * The message fields a transcript row is drawn from, on both sides.
     *
     * `messageSchema` is the REST shape and `broadcastMessageSchema` is the
     * socket shape; the client decodes the same `Message` from both, so a field
     * that exists on only one of them is a row that renders from history and
     * not live, or the reverse.
     */
    @Test
    fun `the message fields a row is drawn from exist on both the REST and socket shapes`() {
        val required = setOf(
            "id", "channelId", "authorId", "authorName", "authorAvatarUrl", "body", "createdAt",
        )
        val rest = RepoSources.objectKeys(api, "messageSchema").toSet()
        val broadcast = RepoSources.objectKeys("packages/shared/src/chat.ts", "broadcastMessageSchema").toSet()
        val modelled = Message.serializer().descriptor.elementNames.toSet()

        assertEquals("Missing from messageSchema", emptySet<String>(), required - rest)
        assertEquals("Missing from broadcastMessageSchema", emptySet<String>(), required - broadcast)
        assertEquals("Missing from the Kotlin model", emptySet<String>(), required - modelled)
    }
}
