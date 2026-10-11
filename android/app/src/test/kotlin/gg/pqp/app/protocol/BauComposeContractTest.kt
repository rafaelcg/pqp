package gg.pqp.app.protocol

import gg.pqp.app.bau.BAU_BODY_MAX
import gg.pqp.app.bau.BAU_MAX_BYTES
import gg.pqp.app.bau.BAU_PICKER_MIME_TYPES
import gg.pqp.app.bau.BAU_TITLE_MAX
import gg.pqp.app.bau.ClaimBauMediaRequest
import gg.pqp.app.bau.CreateBauPostRequest
import gg.pqp.app.bau.MintBauMediaRequest
import gg.pqp.app.core.Permission
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.elementNames
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The composer's hand-copied rules against `packages/shared`. A limit that
 * drifted would not crash: it would be a draft the phone calls fine and the
 * server calls a 400, or the other way round, a post the phone refuses that the
 * web would have taken.
 */
class BauComposeContractTest {

    private val shared = "packages/shared/src/community-home.ts"

    private fun assertSubset(serializer: KSerializer<*>, schema: String) {
        assertEquals(
            "${serializer.descriptor.serialName} names fields $schema does not have.",
            emptySet<String>(),
            serializer.descriptor.elementNames.toSet() - RepoSources.objectKeys(shared, schema).toSet(),
        )
    }

    @Test
    fun `the requests only name fields the schemas have`() {
        assertSubset(CreateBauPostRequest.serializer(), "createCommunityHomePostSchema")
        assertSubset(MintBauMediaRequest.serializer(), "createCommunityHomeMediaUploadSchema")
        assertSubset(ClaimBauMediaRequest.serializer(), "claimCommunityHomeMediaSchema")
    }

    @Test
    fun `the limits are the shared ones`() {
        assertEquals(BAU_TITLE_MAX, RepoSources.numberConstant(shared, "COMMUNITY_HOME_TITLE_MAX"))
        assertEquals(BAU_BODY_MAX, RepoSources.numberConstant(shared, "COMMUNITY_HOME_BODY_MAX"))
        assertTrue(
            RepoSources.read(shared).contains("COMMUNITY_HOME_MAX_BYTES = 100 * 1024 * 1024"),
        )
        assertEquals(100L * 1024 * 1024, BAU_MAX_BYTES)
    }

    @Test
    fun `every type the picker offers is one the server will sign`() {
        val source = RepoSources.stripComments(RepoSources.read(shared))
        val list = Regex("""COMMUNITY_HOME_MIME_ALLOWLIST\s*=\s*\[([^\]]*)]""").find(source)!!.groupValues[1]
        val allowed = Regex(""""([^"]+)"""").findAll(list).map { it.groupValues[1] }.toSet()
        assertEquals(emptySet<String>(), BAU_PICKER_MIME_TYPES.toSet() - allowed)
    }

    @Test
    fun `manage server is the bit the server publishes on`() {
        val source = RepoSources.stripComments(RepoSources.read("packages/shared/src/permissions.ts"))
        assertTrue(Regex("""MANAGE_SERVER:\s*1n\s*<<\s*5n""").containsMatchIn(source))
        assertEquals(1L shl 5, Permission.MANAGE_SERVER)
    }
}
