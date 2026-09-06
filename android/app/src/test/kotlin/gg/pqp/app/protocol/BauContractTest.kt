package gg.pqp.app.protocol

import gg.pqp.app.bau.BauComment
import gg.pqp.app.bau.BauMedia
import gg.pqp.app.bau.BauPost
import gg.pqp.app.bau.BauUnreadResponse
import gg.pqp.app.bau.CommunityHomeConfig
import java.io.File
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.elementNames
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * The Baú models against `packages/shared/src/community-home.ts`.
 *
 * Same one-way rule as `ModelShapeTest`: every field the Kotlin side names
 * must exist on the shared schema, because a rename there decodes to a
 * default here with no error anywhere. A locked post that quietly read as
 * unlocked would be the worst version of that.
 *
 * ASSUMED, NOT FAILED, WHILE THE FILE IS ABSENT. The shared module lands on
 * `main` with the Community Home branch (PR #176); this client shipped its
 * half first, against the staging API. `RepoSources` is right that a skipped
 * contract test reads as green, so the skip is loud in the test report and
 * the assumption goes away on its own the moment the file is in the checkout.
 */
class BauContractTest {

    private val shared = "packages/shared/src/community-home.ts"

    private fun assumeSharedModule() {
        assumeTrue(
            "$shared is not in this checkout yet (it arrives with PR #176), so the " +
                "Baú contract cannot be pinned here. Not a failure; the models were " +
                "written against the staging API's copy of that file.",
            File(RepoSources.root, shared).isFile,
        )
    }

    private fun assertSubsetOfSchema(serializer: KSerializer<*>, schemaName: String) {
        val schemaKeys = RepoSources.objectKeys(shared, schemaName).toSet()
        val kotlinKeys = serializer.descriptor.elementNames.toSet()
        assertEquals(
            "${serializer.descriptor.serialName} names fields that $schemaName in $shared does not have.",
            emptySet<String>(),
            kotlinKeys - schemaKeys,
        )
    }

    @Test
    fun `BauPost matches communityHomePostSchema`() {
        assumeSharedModule()
        assertSubsetOfSchema(BauPost.serializer(), "communityHomePostSchema")
    }

    @Test
    fun `BauMedia matches communityHomeMediaSchema`() {
        assumeSharedModule()
        assertSubsetOfSchema(BauMedia.serializer(), "communityHomeMediaSchema")
    }

    @Test
    fun `BauComment matches communityHomeCommentSchema`() {
        assumeSharedModule()
        assertSubsetOfSchema(BauComment.serializer(), "communityHomeCommentSchema")
    }

    @Test
    fun `CommunityHomeConfig matches communityHomeConfigSchema`() {
        assumeSharedModule()
        assertSubsetOfSchema(CommunityHomeConfig.serializer(), "communityHomeConfigSchema")
    }

    /**
     * The badge count. A rename here decodes to the default, which is 0, which
     * is a Baú that never has anything new in it and nothing to say so.
     */
    @Test
    fun `BauUnreadResponse matches communityHomeUnreadResponseSchema`() {
        assumeSharedModule()
        assertSubsetOfSchema(BauUnreadResponse.serializer(), "communityHomeUnreadResponseSchema")
    }

    /**
     * The words the card switches on. `BauMedia.isImage` and friends compare
     * against these literals, so a renamed kind would draw every post of that
     * kind as a file chip.
     */
    @Test
    fun `the media kinds and visibilities are the ones shared publishes`() {
        assumeSharedModule()
        assertEquals(
            listOf("image", "video", "youtube", "file"),
            RepoSources.enumValues(shared, "communityHomeMediaKindSchema"),
        )
        assertEquals(
            listOf("free", "members"),
            RepoSources.enumValues(shared, "communityHomeVisibilitySchema"),
        )
        assertEquals(
            listOf("owner", "staff"),
            RepoSources.enumValues(shared, "communityHomeAuthorBadgeSchema"),
        )
    }
}
