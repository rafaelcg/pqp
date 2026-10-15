package gg.pqp.app.protocol

import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.Permission
import gg.pqp.app.follow.BauFollow
import gg.pqp.app.follow.BauFollowBlock
import gg.pqp.app.follow.BauFollowChannel
import gg.pqp.app.follow.BauFollowDestination
import gg.pqp.app.follow.BauFollowDestinations
import gg.pqp.app.follow.BauFollowRole
import gg.pqp.app.follow.BauFollowState
import gg.pqp.app.follow.BauFollower
import gg.pqp.app.follow.BauFollowers
import gg.pqp.app.follow.ChannelBauFollows
import gg.pqp.app.follow.CreateBauFollowRequest
import gg.pqp.app.follow.FOLLOW_MAX_PER_SERVER
import gg.pqp.app.follow.UpdateBauFollowConfigRequest
import gg.pqp.app.follow.UpdateBauFollowRequest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.elementNames
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Seguir's Kotlin half against `packages/shared/src/bau-follow.ts` and the
 * server's route table. A rename or a changed limit there fails here, not as a
 * follow that quietly stops loading.
 *
 * The one-way rule of `ModelShapeTest`: every field Kotlin names must exist on
 * the schema, because a renamed key decodes to a default with no error.
 */
class FollowContractTest {

    private val shared = "packages/shared/src/bau-follow.ts"

    private fun check(serializer: KSerializer<*>, schema: String) {
        assertEquals(
            "$schema has no such field",
            emptySet<String>(),
            serializer.descriptor.elementNames.toSet() - RepoSources.objectKeys(shared, schema).toSet(),
        )
    }

    @Test
    fun `every model names only fields its schema has`() {
        check(BauFollow.serializer(), "bauFollowSchema")
        check(BauFollowState.serializer(), "bauFollowStateSchema")
        check(BauFollowRole.serializer(), "bauFollowRoleOptionSchema")
        check(BauFollowChannel.serializer(), "bauFollowChannelOptionSchema")
        check(BauFollowDestination.serializer(), "bauFollowDestinationSchema")
        check(BauFollowDestinations.serializer(), "bauFollowDestinationsSchema")
        check(CreateBauFollowRequest.serializer(), "createBauFollowSchema")
        check(UpdateBauFollowRequest.serializer(), "updateBauFollowSchema")
        check(ChannelBauFollows.serializer(), "channelBauFollowsSchema")
        check(BauFollower.serializer(), "bauFollowerSchema")
        check(BauFollowBlock.serializer(), "bauFollowBlockSchema")
        check(BauFollowers.serializer(), "bauFollowersSchema")
        check(UpdateBauFollowConfigRequest.serializer(), "updateBauFollowConfigSchema")
    }

    @Test
    fun `the limit is the schema's`() {
        assertEquals(FOLLOW_MAX_PER_SERVER, RepoSources.numberConstant(shared, "BAU_FOLLOW_MAX_PER_SERVER"))
    }

    @Test
    fun `the statuses and pause reasons are the schema's`() {
        assertEquals(listOf("active", "paused"), RepoSources.enumValues(shared, "bauFollowStatusSchema"))
        assertEquals(listOf("permissions", "banned"), RepoSources.enumValues(shared, "bauFollowPausedReasonSchema"))
    }

    @Test
    fun `a resume goes out as a resume`() {
        // `encodeDefaults = false` would drop a field equal to its default; the
        // server answers 400 "Nothing to change" to an empty body.
        val body = PqpJson.encodeToString(UpdateBauFollowRequest.serializer(), UpdateBauFollowRequest(resume = true))
        assertEquals("""{"resume":true}""", body)
    }

    @Test
    fun `the switch goes out even when it is false`() {
        val body = PqpJson.encodeToString(
            UpdateBauFollowConfigRequest.serializer(),
            UpdateBauFollowConfigRequest(allowed = false),
        )
        assertEquals("""{"allowed":false}""", body)
    }

    @Test
    fun `a create without a role carries no null`() {
        val body = PqpJson.encodeToString(
            CreateBauFollowRequest.serializer(),
            CreateBauFollowRequest(channelId = "c"),
        )
        assertEquals("""{"channelId":"c"}""", body)
    }

    @Test
    fun `the bits the channel check reads are the server's`() {
        val permissions = RepoSources.read("packages/shared/src/permissions.ts")
        assertTrue(permissions.contains("MANAGE_WEBHOOKS: 1n << 20n"))
        assertEquals(1L shl 20, Permission.MANAGE_WEBHOOKS)
        val service = RepoSources.read("server/src/services/bau-follow.ts")
        assertTrue(service.contains("Permission.MANAGE_WEBHOOKS"))
        assertTrue(service.contains("Permission.MANAGE_CHANNELS"))
    }

    @Test
    fun `the server answers every route this build calls`() {
        val api = RepoSources.read("server/src/api/index.ts")
        for (route in listOf(
            "router.get(\n  \"/api/servers/:serverId/home/follow\"",
            "router.get(\n  \"/api/servers/:serverId/home/follow/destinations\"",
            "router.post(\n  \"/api/servers/:serverId/home/follow\"",
            "router.get(\n  \"/api/channels/:channelId/bau-follows\"",
            "router.patch(\n  \"/api/bau-follows/:followId\"",
            "router.delete(\n  \"/api/bau-follows/:followId\"",
            "router.patch(\n  \"/api/servers/:serverId/home/follow-config\"",
            "router.get(\n  \"/api/servers/:serverId/home/followers\"",
            "router.delete(\n  \"/api/servers/:serverId/home/followers/:followId\"",
            "router.delete(\n  \"/api/servers/:serverId/home/follow-blocks/:blockedServerId\"",
        )) {
            assertTrue("server has no $route", api.contains(route))
        }
    }

    @Test
    fun `the refusal sentences the client tells apart are the server's`() {
        val service = RepoSources.read("server/src/services/bau-follow.ts")
        // 403: "This Baú does not accept that server" (blocked) vs the channel one.
        assertTrue(service.contains("\"This Baú does not accept that server\""))
        // 409: the cap's sentence carries "at most"; the duplicate's does not.
        assertTrue(service.contains("A server can follow at most"))
        assertTrue(service.contains("\"That channel already follows this Baú\""))
    }
}
