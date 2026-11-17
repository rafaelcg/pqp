package gg.pqp.app.protocol

import gg.pqp.app.activities.ActivityApp
import gg.pqp.app.activities.ActivityEndReason
import gg.pqp.app.activities.ActivityFrame
import gg.pqp.app.activities.ActivitySession
import gg.pqp.app.activities.ActivitySessionParticipant
import gg.pqp.app.activities.bridge.ActivityTheme
import gg.pqp.app.activities.bridge.BridgeHost
import gg.pqp.app.activities.web.ActivityHostPage
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.elementNames
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The activities the phone speaks against `packages/shared/src/apps/` and the web client's
 * bridge host, field by field and cap by cap: a rename on the server, or a request the
 * bridge learns, must fail here and not be a screen that quietly stops working.
 */
class ActivityContractTest {

    private val frames = "packages/shared/src/apps/frames.ts"
    private val bridge = "packages/shared/src/apps/bridge.ts"
    private val config = "packages/shared/src/apps/config.ts"
    private val common = "packages/shared/src/apps/common.ts"
    private val limits = "packages/shared/src/apps/limits.ts"
    private val manifest = "packages/shared/src/apps/manifest.ts"
    private val themeTokens = "client/src/lib/apps/theme-tokens.ts"

    private fun assertSubset(serializer: KSerializer<*>, file: String, schema: String) {
        val schemaKeys = RepoSources.objectKeys(file, schema).toSet()
        val kotlinKeys = serializer.descriptor.elementNames.toSet()
        assertEquals(
            "${serializer.descriptor.serialName} names fields $schema does not have",
            emptySet<String>(),
            kotlinKeys - schemaKeys,
        )
    }

    @Test
    fun `the models match the shared schemas`() {
        assertSubset(ActivityApp.serializer(), config, "appConfigEntrySchema")
        assertSubset(ActivitySession.serializer(), frames, "appSessionSummarySchema")
        assertSubset(ActivitySessionParticipant.serializer(), frames, "appSessionSummaryParticipantSchema")
    }

    @Test
    fun `the six server frames are the ones the phone decodes, and the four it sends are declared`() {
        val declared = RepoSources.frameTypeLiterals(frames)
        assertEquals(
            "apps/frames.ts and ActivityFrame disagree about the frames of a session",
            setOf("app-join", "app-leave", "app-state-patch", "app-event-send") + ActivityFrame.TYPES,
            declared,
        )
        // each is a member of the chat unions, which is what makes the server send it to a phone at all
        val server = RepoSources.serverFrameTypes()
        assertTrue(ActivityFrame.TYPES.all { it in server })
    }

    @Test
    fun `the request types the bridge knows are the ones the phone answers or the page answers for it`() {
        val source = RepoSources.stripComments(RepoSources.read(bridge))
        val types = Regex("""request\("([A-Za-z.]+)"""").findAll(source).map { it.groupValues[1] }.toSet()
        assertTrue("parsed too few request types out of $bridge: $types", types.size > 15)

        val nativeTypes = setOf(
            "participants.get", "state.get", "state.patch", "events.send", "ui.resize",
            "ui.fullscreen", "share.request", "session.end", "ui.activity",
        )
        val answeredByPage = ActivityHostPage.ANSWERED_HERE.keys
        assertEquals("a request type is answered twice", emptySet<String>(), nativeTypes.intersect(answeredByPage))
        assertEquals(
            "the bridge learned a request the phone neither answers nor refuses (or one was removed): " +
                "add it to BridgeHost.parseRequest or to ActivityHostPage.ANSWERED_HERE",
            types,
            nativeTypes + answeredByPage,
        )
    }

    @Test
    fun `the end reasons and app-error codes match shared`() {
        val shared = RepoSources.stripComments(RepoSources.read(common))
        val reasons = Regex("""APP_END_REASONS\s*=\s*\[([^\]]*)]""").find(shared)!!.groupValues[1]
        val reasonList = Regex(""""([^"]+)"""").findAll(reasons).map { it.groupValues[1] }.toSet()
        assertEquals(reasonList, ActivityEndReason.entries.filter { it != ActivityEndReason.Other }.map { it.wire }.toSet())

        val framesSource = RepoSources.stripComments(RepoSources.read(frames))
        val codes = Regex("""APP_ERROR_CODES\s*=\s*\[([^\]]*)]""").find(framesSource)!!.groupValues[1]
        val codeList = Regex(""""([^"]+)"""").findAll(codes).map { it.groupValues[1] }.toSet()
        // what the phone maps and what it passes through: every code is either mapped or falls to `unavailable`
        val mapped = setOf("not-allowed", "ended", "rate-limited", "too-large", "stale-rev")
        assertTrue("a new app-error code has no mapping decision: $codeList", codeList - mapped - setOf("full", "unavailable") == emptySet<String>())
        for (code in mapped) assertEquals(code, BridgeHost.mapTransportError(code, forEnd = false).takeIf { it != "unavailable" } ?: code)
        assertEquals("not-host", BridgeHost.mapTransportError("not-allowed", forEnd = true))
        assertEquals("unavailable", BridgeHost.mapTransportError("full", forEnd = false))
    }

    @Test
    fun `the caps match the platform's`() {
        assertEquals(RepoSources.numberConstant(manifest, "APP_STATE_MAX_BYTES"), BridgeHost.STATE_MAX_BYTES)
        assertEquals(RepoSources.numberConstant(manifest, "APP_EVENT_MAX_BYTES"), BridgeHost.EVENT_MAX_BYTES)
        assertEquals(RepoSources.numberConstant(manifest, "APP_EVENT_MAX_PER_SECOND"), BridgeHost.EVENT_MAX_PER_SECOND)
        assertEquals(RepoSources.numberConstant(manifest, "APP_STATE_MAX_WRITES_PER_SECOND"), BridgeHost.STATE_MAX_WRITES_PER_SECOND)
        assertEquals(RepoSources.numberConstant(manifest, "APP_PLATFORM_API"), BridgeHost.PLATFORM_API)
        assertEquals(RepoSources.numberConstant(limits, "APP_AVATAR_MAX_CHARS"), BridgeHost.AVATAR_MAX_CHARS)
        assertEquals(RepoSources.numberConstant(limits, "APP_DISPLAY_NAME_MAX_CHARS"), BridgeHost.DISPLAY_NAME_MAX_CHARS)
        assertEquals(RepoSources.numberConstant(limits, "APP_THEME_MAX_TOKENS"), BridgeHost.THEME_MAX_TOKENS)
        assertEquals(RepoSources.numberConstant(limits, "APP_UI_MIN_HEIGHT").toLong(), BridgeHost.UI_MIN_HEIGHT)
        assertEquals(RepoSources.numberConstant(limits, "APP_UI_MAX_HEIGHT").toLong(), BridgeHost.UI_MAX_HEIGHT)
        // 4 * 1024 * 1024
        assertEquals(4 * 1024 * 1024, BridgeHost.AVATAR_BUDGET_CHARS)
        assertTrue(RepoSources.read(limits).contains("APP_PARTICIPANTS_AVATAR_BUDGET_CHARS = 4 * 1024 * 1024"))
    }

    @Test
    fun `the theme tokens are the web host's allowlist, no more`() {
        val source = RepoSources.stripComments(RepoSources.read(themeTokens))
        val list = Regex("""APP_THEME_TOKENS\s*=\s*\[([^\]]*)]""").find(source)!!.groupValues[1]
        val web = Regex(""""(--[a-z0-9-]+)"""").findAll(list).map { it.groupValues[1] }.toSet()
        assertTrue("parsed too few tokens: $web", web.size > 20)
        val palette = ActivityTheme.Palette(
            dark = true, background = 0, surface = 0, surfaceRaised = 0, chrome = 0, border = 0, onSurface = 0,
            onSurfaceVariant = 0, primary = 0, primaryHover = 0, onPrimary = 0, danger = 0, onDanger = 0, warning = 0, success = 0,
        )
        val phone = ActivityTheme.tokens(palette).keys - ActivityTheme.COLOR_SCHEME_TOKEN
        assertEquals("the phone sends a token the web host does not (or lacks one it does)", web, phone)
    }

    @Test
    fun `the bundle's frame-ancestors still admit the origin the wrapper claims`() {
        // The wrapper page loads with this base URL so the bundles' `frame-ancestors` (which lists pqp's own
        // origins) accepts it without a change to tools/apps-build. If that list moves, this is the test that says so.
        val headers = RepoSources.read("tools/apps-build/src/headers.mts")
        assertTrue(
            "${ActivityHostPage.BASE_ORIGIN} is no longer in FRAME_ANCESTORS: the Android wrapper would be refused",
            headers.contains("\"${ActivityHostPage.BASE_ORIGIN}\""),
        )
    }
}
