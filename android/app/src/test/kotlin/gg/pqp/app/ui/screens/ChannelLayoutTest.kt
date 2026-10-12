package gg.pqp.app.ui.screens

import gg.pqp.app.core.ApiException
import gg.pqp.app.core.Channel
import gg.pqp.app.core.serverLocale
import gg.pqp.app.protocol.RepoSources
import gg.pqp.app.ui.screens.channels.ChannelLayoutPayload
import gg.pqp.app.ui.screens.channels.ChannelLayoutSaveResult
import gg.pqp.app.ui.screens.channels.ChannelOrganizer
import gg.pqp.app.ui.screens.channels.LayoutChannel
import gg.pqp.app.ui.screens.channels.LayoutIds
import gg.pqp.app.ui.screens.channels.LayoutTarget
import gg.pqp.app.ui.screens.channels.applyLayoutToChannels
import gg.pqp.app.ui.screens.channels.buildSidebarLayout
import gg.pqp.app.ui.screens.channels.channelLayoutRefusal
import gg.pqp.app.ui.screens.channels.createChannelBody
import gg.pqp.app.ui.screens.channels.layoutToPayload
import gg.pqp.app.ui.screens.channels.mixedLayoutOf
import gg.pqp.app.ui.screens.channels.moveInLayout
import gg.pqp.app.ui.screens.channels.normalizedCategoryName
import gg.pqp.app.ui.screens.channels.stepInLayout
import java.io.File
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The mixed channel list on Android: the port of
 * `packages/shared/src/channel-layout.ts` run against the SAME fixture the
 * web and iOS run (`packages/shared/fixtures/channel-layout-cases.json`), the
 * organizer's staged moves, and the wire shapes of the layout endpoints.
 */
class ChannelLayoutTest {

    @Serializable
    private data class Row(
        override val id: String,
        override val type: String,
        override val parentId: String? = null,
        override val position: Double,
    ) : LayoutChannel

    @Serializable
    private data class BuildCase(
        val name: String,
        val server: String,
        val mixed: Boolean,
        val hideWatchParty: Boolean,
        val expect: LayoutIds,
    )

    @Serializable
    private data class MoveCase(
        val name: String,
        val server: String,
        val id: String,
        val to: LayoutTarget,
        val expect: LayoutIds?,
    )

    @Serializable
    private data class StepCase(
        val name: String,
        val server: String,
        val id: String,
        val direction: Int,
        val target: LayoutTarget?,
        val expect: LayoutIds?,
    )

    @Serializable
    private data class PayloadCase(
        val name: String,
        val server: String,
        val mixed: Boolean,
        val hideWatchParty: Boolean,
        val baseVersion: Int,
        val expect: ChannelLayoutPayload,
    )

    @Serializable
    private data class Fixture(
        val version: Int,
        val servers: Map<String, List<Row>>,
        val build: List<BuildCase>,
        val move: List<MoveCase>,
        val step: List<StepCase>,
        val payload: List<PayloadCase>,
    )

    private val json = Json { ignoreUnknownKeys = true }

    private val fixture: Fixture by lazy {
        val file = File(RepoSources.root, "packages/shared/fixtures/channel-layout-cases.json")
        json.decodeFromString(Fixture.serializer(), file.readText())
    }

    private fun rows(server: String): List<Row> = fixture.servers.getValue(server)

    @Test
    fun `the fixture is the version this port was written against`() {
        // A new version may add rules this port does not have. Read the
        // fixture's `about`, port the change, then bump this.
        assertEquals(1, fixture.version)
    }

    @Test
    fun `every build case`() {
        assertTrue(fixture.build.isNotEmpty())
        fixture.build.forEach { case ->
            val layout = buildSidebarLayout(rows(case.server), case.mixed, case.hideWatchParty)
            assertEquals(case.name, case.expect, layout.ids)
        }
    }

    @Test
    fun `every move case`() {
        assertTrue(fixture.move.isNotEmpty())
        fixture.move.forEach { case ->
            val start = buildSidebarLayout(rows(case.server), mixed = true)
            assertEquals(case.name, case.expect, moveInLayout(start, case.id, case.to)?.ids)
        }
    }

    @Test
    fun `every step case`() {
        assertTrue(fixture.step.isNotEmpty())
        fixture.step.forEach { case ->
            val start = buildSidebarLayout(rows(case.server), mixed = true)
            val stepped = stepInLayout(start, case.id, case.direction)
            assertEquals(case.name, case.target, stepped?.second)
            assertEquals(case.name, case.expect, stepped?.first?.ids)
        }
    }

    @Test
    fun `every payload case`() {
        assertTrue(fixture.payload.isNotEmpty())
        fixture.payload.forEach { case ->
            val layout = buildSidebarLayout(rows(case.server), case.mixed, case.hideWatchParty)
            assertEquals(case.name, case.expect, layoutToPayload(layout, case.baseVersion))
        }
    }

    // --- Organizar canais ---

    private fun guris() = ChannelOrganizer(buildSidebarLayout(rows("guris"), mixed = true))

    private val gurisItems = listOf(
        "c:t-avisos", "c:v-afk", "c:w-filme", "c:t-regras",
        "h:cat-canais", "c:t-general", "c:v-lobby", "c:f-duvidas",
        "h:cat-jogos", "c:t-clipes", "c:v-squad", "c:t-lfg",
        "h:cat-cinema", "e:cat-cinema",
    )

    @Test
    fun `the flat list is loose, then each heading with its channels, and a placeholder when empty`() {
        assertEquals(gurisItems, guris().items.map { it.key })
    }

    /** The mock: Lobby dragged from Canais to between clipes and Squad. */
    @Test
    fun `a channel dropped inside another category joins it there`() {
        val organizer = guris()
        // A drag reads the destination with the row already moved: Lobby (6)
        // ends up at 9, right above Squad.
        assertTrue(organizer.move(from = 6, to = 9))
        assertEquals(listOf("t-general", "f-duvidas"), organizer.layout.ids.categories[0].children)
        assertEquals(listOf("t-clipes", "v-lobby", "v-squad", "t-lfg"), organizer.layout.ids.categories[1].children)
        assertTrue(organizer.hasChanges)
    }

    @Test
    fun `a channel dropped above the first heading becomes loose`() {
        val organizer = guris()
        assertTrue(organizer.move(from = 5, to = 0))
        assertEquals(listOf("t-general", "t-avisos", "v-afk", "w-filme", "t-regras"), organizer.layout.ids.loose)
    }

    @Test
    fun `a channel dropped under an empty category goes into it`() {
        val organizer = guris()
        assertTrue(organizer.move(from = 11, to = gurisItems.size - 1))
        assertEquals(listOf("t-lfg"), organizer.layout.ids.categories[2].children)
        assertFalse(organizer.items.any { it.key == "e:cat-cinema" })
    }

    @Test
    fun `a heading carries its channels and lands among the categories`() {
        val organizer = guris()
        assertTrue(organizer.move(from = 8, to = 4))
        assertEquals(listOf("cat-jogos", "cat-canais", "cat-cinema"), organizer.layout.ids.categories.map { it.id })
        assertEquals(listOf("t-clipes", "v-squad", "t-lfg"), organizer.layout.ids.categories[0].children)
    }

    @Test
    fun `a heading dropped among its own channels stays put, and the placeholder never moves`() {
        val organizer = guris()
        assertFalse(organizer.move(from = 8, to = 9))
        assertFalse(organizer.move(from = 13, to = 0))
        assertFalse(organizer.hasChanges)
        assertEquals(gurisItems, organizer.items.map { it.key })
    }

    @Test
    fun `moving back is no change, and reset forgets the staged order`() {
        val organizer = guris()
        organizer.move(from = 6, to = 9)
        organizer.move(from = 9, to = 6)
        assertEquals(gurisItems, organizer.items.map { it.key })
        assertFalse(organizer.hasChanges)
        organizer.move(from = 0, to = 2)
        assertTrue(organizer.hasChanges)
        organizer.reset(buildSidebarLayout(rows("single"), mixed = true))
        assertFalse(organizer.hasChanges)
        assertEquals(listOf("h:cat-a", "c:t-x"), organizer.items.map { it.key })
    }

    @Test
    fun `accessibility steps cross category borders`() {
        val organizer = guris()
        assertFalse(organizer.canStep("t-avisos", -1))
        assertEquals(LayoutTarget(null, 4), organizer.step("t-general", -1))
        assertEquals("t-general", organizer.layout.ids.loose.last())
        assertTrue(organizer.hasChanges)
        assertNull(organizer.step("cat-cinema", 1))
    }

    @Test
    fun `a category created mid session is not a staged change`() {
        val organizer = guris()
        organizer.appendCategory(Row("cat-new", "category", null, 3.0))
        assertFalse(organizer.hasChanges)
        assertEquals(listOf("h:cat-new", "e:cat-new"), organizer.items.takeLast(2).map { it.key })
        organizer.replaceCategory(Row("cat-new", "category", null, 3.0))
        assertFalse(organizer.hasChanges)
    }

    // --- Applying a saved order locally ---

    @Test
    fun `apply rewrites parent and position and leaves watch party rooms alone`() {
        val channels = listOf(
            Channel(id = "cat", name = "cat", type = "category"),
            Channel(id = "a", name = "a", type = "text", parentId = "cat", position = 0.0),
            Channel(id = "b", name = "b", type = "voice", parentId = "cat", position = 1.0),
            Channel(id = "wp", name = "wp", type = "watch_party", position = 7.0),
        )
        val layout = mixedLayoutOf(channels)
        assertEquals(listOf("a", "b"), layout.ids.categories.single().children)
        val moved = moveInLayout(layout, "b", LayoutTarget(null, 0))!!
        val applied = applyLayoutToChannels(channels, moved).associateBy { it.id }
        assertNull(applied.getValue("b").parentId)
        assertEquals(0.0, applied.getValue("b").position, 0.0)
        assertEquals("cat", applied.getValue("a").parentId)
        assertEquals(7.0, applied.getValue("wp").position, 0.0)
        assertEquals(moved.ids, mixedLayoutOf(applied.values.toList()).ids)
    }

    /** The rollback after a refused save: the staged order goes back, a channel that arrived meanwhile stays. */
    @Test
    fun `rolling back puts the old order on the latest list and keeps new channels`() {
        val before = listOf(
            Channel(id = "cat", name = "cat", type = "category", position = 0.0),
            Channel(id = "a", name = "a", type = "text", parentId = "cat", position = 0.0),
            Channel(id = "b", name = "b", type = "text", parentId = "cat", position = 1.0),
        )
        val staged = applyLayoutToChannels(before, moveInLayout(mixedLayoutOf(before), "b", LayoutTarget(null, 0))!!)
        val latest = staged + Channel(id = "n", name = "n", type = "text", parentId = "cat", position = 2.0)
        val rolledBack = applyLayoutToChannels(latest, mixedLayoutOf(before)).associateBy { it.id }
        assertEquals("cat", rolledBack.getValue("b").parentId)
        assertEquals(1.0, rolledBack.getValue("b").position, 0.0)
        assertEquals("cat", rolledBack.getValue("n").parentId)
        assertEquals(2.0, rolledBack.getValue("n").position, 0.0)
        assertEquals(4, rolledBack.size)
    }

    // --- Wire shapes ---

    @Test
    fun `the loose group sends an explicit null parent`() {
        val payload = ChannelLayoutPayload(
            baseVersion = 3,
            categoryIds = listOf("c1"),
            groups = listOf(ChannelLayoutPayload.Group(null, listOf("a")), ChannelLayoutPayload.Group("c1", emptyList())),
        ).toJson()
        val groups = payload.getValue("groups").jsonArray
        assertEquals(JsonNull, groups[0].jsonObject["parentId"])
        assertEquals("c1", groups[1].jsonObject.getValue("parentId").jsonPrimitive.content)
        assertEquals(3, payload.getValue("baseVersion").jsonPrimitive.content.toInt())
    }

    /** A missing `parentId` is how the server spots an OLDER client. This build always says. */
    @Test
    fun `create always says where a channel goes, and never for a category`() {
        assertEquals(JsonNull, createChannelBody("a", "text", false, null)["parentId"])
        assertEquals("c1", createChannelBody("a", "voice", false, "c1").getValue("parentId").jsonPrimitive.content)
        assertFalse(createChannelBody("Salas de voz", "category", false, null).containsKey("parentId"))
    }

    private fun refusal(status: Int, body: String): ApiException {
        val parsed = json.parseToJsonElement(body).jsonObject
        return ApiException(status, parsed["error"]?.jsonPrimitive?.content, null, parsed)
    }

    private val channelJson =
        """{"id":"c1","serverId":"s1","kind":"server","name":"general","type":"text","position":0,"isPrivate":false,"topic":null,"parentId":null}"""

    @Test
    fun `a stale order carries the fresh list and version`() {
        val result = channelLayoutRefusal(
            refusal(409, """{"error":"channel_layout_stale","channels":[$channelJson],"version":12}"""),
        )
        result as ChannelLayoutSaveResult.Stale
        assertEquals(listOf("c1"), result.channels.map { it.id })
        assertEquals(12, result.version)
    }

    @Test
    fun `the mixed list switched off, a refused body, and a status with no answer`() {
        assertEquals(
            ChannelLayoutSaveResult.Off,
            channelLayoutRefusal(refusal(409, """{"error":"channel_layout_off","version":4}""")),
        )
        assertEquals(
            ChannelLayoutSaveResult.Invalid("Every category must be listed"),
            channelLayoutRefusal(refusal(400, """{"error":"Every category must be listed"}""")),
        )
        assertNull(channelLayoutRefusal(refusal(403, """{"error":"Forbidden"}""")))
    }

    // --- Names and locale ---

    @Test
    fun `category names are labels up to 32 units`() {
        assertEquals("Salas de voz", normalizedCategoryName("  Salas de voz "))
        assertEquals("Jogos & Música", normalizedCategoryName("Jogos & Música"))
        assertNull(normalizedCategoryName("   "))
        assertEquals(32, normalizedCategoryName("a".repeat(32))?.length)
        assertNull(normalizedCategoryName("a".repeat(33)))
        assertNull(normalizedCategoryName("a\u0007b"))
    }

    @Test
    fun `a new server is named in the app's language`() {
        assertEquals("pt-BR", serverLocale("pt"))
        assertEquals("es", serverLocale("es"))
        assertEquals("en", serverLocale("en"))
        assertEquals("en", serverLocale("fr"))
    }
}
