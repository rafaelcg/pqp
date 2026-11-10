package gg.pqp.app.activities

import gg.pqp.app.activities.bridge.ActivityPeople
import gg.pqp.app.activities.bridge.ActivityTransport
import gg.pqp.app.activities.bridge.ActivityTransportError
import gg.pqp.app.activities.bridge.BridgeHost
import gg.pqp.app.activities.bridge.SeatSnapshot
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val SEAT_A = "seatAAAAAAAAAAAAAAAA"
private const val SEAT_B = "seatBBBBBBBBBBBBBBBB"
private const val USER_A = "11111111-1111-4111-8111-111111111111"
private const val USER_B = "22222222-2222-4222-8222-222222222222"

/**
 * The phone's bridge host against the contract in `packages/shared/src/apps/bridge.ts`:
 * what it answers, what it refuses and, above all, what it never says. The app is
 * untrusted, so each of these is a property a hostile bundle would test.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class BridgeHostTest {

    private class FakeTransport(
        var snapshot: SeatSnapshot,
    ) : ActivityTransport {
        var handlers: ActivityTransport.Handlers? = null
        val patches = mutableListOf<Pair<JsonElement, Long?>>()
        val events = mutableListOf<Pair<String, JsonElement>>()
        var ended = 0
        var left = 0
        var patchError: String? = null
        var nextRev = 5L

        override suspend fun join(asSpectator: Boolean): SeatSnapshot = snapshot
        override fun leave() { left += 1 }
        override suspend fun patchState(patch: JsonElement, baseRev: Long?): Long {
            patches += patch to baseRev
            patchError?.let { throw ActivityTransportError(it) }
            return nextRev++
        }
        override fun sendEvent(name: String, data: JsonElement) { events += name to data }
        override suspend fun end() { ended += 1 }
        override fun subscribe(handlers: ActivityTransport.Handlers): () -> Unit {
            this.handlers = handlers
            return { this.handlers = null }
        }
    }

    private class FakePeople(val avatars: Map<String, String?> = emptyMap(), val names: Map<String, String> = emptyMap()) : ActivityPeople {
        override suspend fun describe(userId: String): ActivityPeople.Person? =
            names[userId]?.let { ActivityPeople.Person(it, avatars[userId]) }
    }

    private class Env(var locale: String = "pt-BR") : BridgeHost.Env {
        var theme: Map<String, String> = mapOf("--color-accent" to "#bbec4c", "--pqp-color-scheme" to "dark")
        override fun locale() = locale
        override fun theme() = theme
        override fun reducedMotion() = false
    }

    private fun app(
        state: ActivityStateCaps? = ActivityStateCaps(maxBytes = 200, maxWritesPerSecond = 10, writers = "participants"),
        events: ActivityEventCaps? = ActivityEventCaps(maxPerSecond = 10, maxBytes = 64),
    ) = ActivityApp(id = "pqp-eco", version = "1.0.2", state = state, events = events)

    private fun snapshot(isHost: Boolean = true, role: String = "player", stateValue: JsonElement = JsonNull) = SeatSnapshot(
        sessionId = "00000000-0000-4000-8000-000000000001",
        seatId = SEAT_A,
        role = role,
        isHost = isHost,
        stateRev = 0,
        stateValue = stateValue,
        participants = listOf(
            SeatParticipant(SEAT_A, USER_A, role, isHost, "present", null),
            SeatParticipant(SEAT_B, USER_B, "player", false, "reconnecting", "appuseridappuseridappuserid"),
        ),
    )

    private class Rig(
        val transport: FakeTransport,
        val posted: MutableList<JsonObject>,
        val bridge: BridgeHost,
        val violations: MutableList<Unit>,
        val ended: MutableList<ActivityEndReason>,
        val clock: LongArray,
    ) {
        fun send(raw: String) = bridge.onPortMessage(raw)
        fun send(obj: JsonObject) = bridge.onPortMessage(obj.toString())
        fun answers(id: String): List<JsonObject> = posted.filter { it["id"]?.jsonPrimitive?.contentOrNull == id }
        fun answer(id: String): JsonObject = answers(id).single()
        fun pushes(type: String) = posted.filter { it["type"]?.jsonPrimitive?.contentOrNull == type && !it.containsKey("id") }
    }

    private fun TestScope.rig(
        app: ActivityApp = app(),
        snapshot: SeatSnapshot = snapshot(),
        people: ActivityPeople = FakePeople(names = mapOf(USER_A to "Ana", USER_B to "Beto")),
        env: Env = Env(),
    ): Rig {
        val transport = FakeTransport(snapshot)
        val posted = mutableListOf<JsonObject>()
        val violations = mutableListOf<Unit>()
        val ended = mutableListOf<ActivityEndReason>()
        val clock = longArrayOf(1_000_000L)
        val bridge = BridgeHost(
            app = app,
            transport = transport,
            people = people,
            env = env,
            post = { posted += Json.parseToJsonElement(it).jsonObject },
            scope = this,
            hooks = BridgeHost.Hooks(
                fullscreen = { it },
                onViolation = { violations += Unit },
                onEnded = { ended += it },
            ),
            now = { clock[0] },
        )
        return Rig(transport, posted, bridge, violations, ended, clock)
    }

    private suspend fun TestScope.started(r: Rig, asSpectator: Boolean = false): Rig {
        r.bridge.start(asSpectator)
        r.bridge.attach()
        advanceUntilIdle()
        return r
    }

    private fun req(id: String, type: String, block: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {}) =
        buildJsonObject {
            put("id", id)
            put("type", type)
            block()
        }

    // --- hello and what the app is never told ---

    @Test
    fun `hello carries the seat the session gave and nothing pqp-internal`() = runTest {
        val r = started(rig())
        val hello = r.posted.first { it["type"]?.jsonPrimitive?.content == "hello" }
        assertEquals(1, hello["platformApi"]!!.jsonPrimitive.content.toInt())
        assertEquals("pqp-eco", hello["app"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals("pt-BR", hello["locale"]!!.jsonPrimitive.content)
        assertEquals(SEAT_A, hello["self"]!!.jsonObject["seatId"]!!.jsonPrimitive.content)
        assertEquals("player", hello["self"]!!.jsonObject["role"]!!.jsonPrimitive.content)
        assertEquals(true, hello["self"]!!.jsonObject["isHost"]!!.jsonPrimitive.booleanOrNull)
        assertEquals("online", hello["connection"]!!.jsonPrimitive.content)
        assertEquals("#bbec4c", hello["theme"]!!.jsonObject["--color-accent"]!!.jsonPrimitive.content)
    }

    @Test
    fun `no message to the app ever carries a pqp user id or any forbidden key`() = runTest {
        val r = started(rig())
        r.send(req("p1", "participants.get"))
        r.send(req("s1", "state.get"))
        advanceUntilIdle()
        val forbidden = setOf("userId", "user_id", "email", "token", "serverId", "channelId")
        fun walk(e: JsonElement) {
            when (e) {
                is JsonObject -> e.forEach { (k, v) ->
                    assertFalse("a message to the app carries `$k`", k in forbidden)
                    walk(v)
                }
                is JsonArray -> e.forEach(::walk)
                is JsonPrimitive -> {
                    assertFalse("a pqp user id reached the app", e.contentOrNull == USER_A || e.contentOrNull == USER_B)
                }
            }
        }
        r.posted.forEach(::walk)
    }

    @Test
    fun `participants are built from scratch with a clean name and a seat id`() = runTest {
        val people = FakePeople(
            names = mapOf(USER_A to "  ‮Ana\u0007 ", USER_B to "\u0000‎"),
            avatars = mapOf(USER_A to "data:image/png;base64,AAAA"),
        )
        val r = started(rig(people = people))
        r.send(req("p1", "participants.get"))
        advanceUntilIdle()
        val list = r.answer("p1")["result"]!!.jsonObject["participants"]!!.jsonArray.map { it.jsonObject }
        assertEquals(2, list.size)
        assertEquals("Ana", list[0]["displayName"]!!.jsonPrimitive.content)
        assertEquals("data:image/png;base64,AAAA", list[0]["avatar"]!!.jsonPrimitive.content)
        assertEquals(SEAT_A, list[0]["seatId"]!!.jsonPrimitive.content)
        // a name that is all control and bidi characters is "?", never empty
        assertEquals("?", list[1]["displayName"]!!.jsonPrimitive.content)
        assertTrue(list[1]["avatar"] is JsonNull)
        assertEquals("reconnecting", list[1]["connection"]!!.jsonPrimitive.content)
        assertEquals("appuseridappuseridappuserid", list[1]["appUserId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a name is capped at 64 units without splitting a pair`() {
        val long = "a".repeat(63) + "😀" + "b"
        val cleaned = BridgeHost.cleanDisplayName(long)
        assertEquals(63, cleaned.length)
        assertEquals("?", BridgeHost.cleanDisplayName(null))
        assertEquals("?", BridgeHost.cleanDisplayName("   "))
    }

    @Test
    fun `a roster past the avatar budget drops the largest pictures first`() {
        fun p(i: Int, size: Int) = BridgeHost.BridgeParticipant(
            seatId = "s".repeat(16) + i, displayName = "n$i", avatar = "x".repeat(size).takeIf { size > 0 },
            role = "player", isHost = false, connection = "present", appUserId = null,
        )
        val big = BridgeHost.AVATAR_BUDGET_CHARS / 2 + 10
        val fit = BridgeHost.fitAvatarBudget(listOf(p(0, 100), p(1, big), p(2, big)))
        assertEquals(100, fit[0].avatar!!.length)
        // the largest go first, and of two the same size the earlier one: dropping it is enough
        assertNull(fit[1].avatar)
        assertEquals(big, fit[2].avatar!!.length)
    }

    // --- strictness ---

    @Test
    fun `an unknown key, a bad id or a wrong kind is a rejection, and an unusable id is dropped`() = runTest {
        val r = started(rig())
        r.send(req("a1", "state.get") { put("extra", 1) })
        r.send(req("a2", "ui.resize") { put("height", 50) })
        r.send(req("a3", "ui.resize") { put("height", 400.5) })
        r.send(req("a4", "ui.fullscreen") { put("on", "yes") })
        r.send(req("a5", "events.send") { put("name", "Bad Name"); put("data", 1) })
        r.send(req("a6", "state.patch") { put("patch", 1); put("baseRev", -1) })
        r.send(req("a7", "ui.activity") { put("state", "sleeping") })
        r.send(req("a8", "no.such.request"))
        r.send(buildJsonObject { put("type", "state.get") }) // no id: nothing to answer
        r.send(buildJsonObject { put("id", "x".repeat(33)); put("type", "state.get") }) // id too long
        r.send("not json")
        r.send("[1,2]")
        advanceUntilIdle()
        for (id in listOf("a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8")) {
            val a = r.answer(id)
            assertEquals("$id", false, a["ok"]!!.jsonPrimitive.booleanOrNull)
            assertEquals("$id", "invalid", a["error"]!!.jsonPrimitive.content)
        }
        assertEquals("only the eight rejections were answered", 8, r.posted.count { it.containsKey("id") })
    }

    @Test
    fun `a successful answer echoes the request type`() = runTest {
        val r = started(rig())
        r.send(req("s1", "state.get"))
        r.send(req("u1", "ui.resize") { put("height", 400) })
        r.send(req("f1", "ui.fullscreen") { put("on", true) })
        r.send(req("t1", "ui.activity") { put("state", "playing") })
        advanceUntilIdle()
        assertEquals("state.get", r.answer("s1")["type"]!!.jsonPrimitive.content)
        assertEquals("ui.resize", r.answer("u1")["type"]!!.jsonPrimitive.content)
        assertEquals(true, r.answer("f1")["result"]!!.jsonObject["on"]!!.jsonPrimitive.booleanOrNull)
        assertTrue(r.answer("t1")["result"] is JsonNull)
    }

    // --- state and events ---

    @Test
    fun `a state patch reaches the transport and answers with its revision`() = runTest {
        val r = started(rig())
        r.send(req("w1", "state.patch") { put("patch", buildJsonObject { put("count", 1) }); put("baseRev", 0) })
        advanceUntilIdle()
        assertEquals(5L, r.answer("w1")["result"]!!.jsonObject["rev"]!!.jsonPrimitive.content.toLong())
        assertEquals(0L, r.transport.patches.single().second)
    }

    @Test
    fun `the state cap counts the merged value, not the patch`() = runTest {
        val r = started(rig(app = app(state = ActivityStateCaps(maxBytes = 30, maxWritesPerSecond = 10)), snapshot = snapshot(stateValue = buildJsonObject { put("a", "x".repeat(20)) })))
        r.send(req("w1", "state.patch") { put("patch", buildJsonObject { put("b", "y".repeat(20)) }) })
        // a null deletes a key, so this one fits again
        r.send(req("w2", "state.patch") { put("patch", buildJsonObject { put("a", JsonNull); put("b", "y".repeat(20)) }) })
        advanceUntilIdle()
        assertEquals("too-large", r.answer("w1")["error"]!!.jsonPrimitive.content)
        assertEquals(true, r.answer("w2")["ok"]!!.jsonPrimitive.booleanOrNull)
    }

    @Test
    fun `a host-only app refuses a participant's write and a transport refusal maps to a bridge code`() = runTest {
        val hostOnly = app(state = ActivityStateCaps(maxBytes = 100, writers = "host"))
        val guest = started(rig(app = hostOnly, snapshot = snapshot(isHost = false)))
        guest.send(req("w1", "state.patch") { put("patch", 1) })
        advanceUntilIdle()
        assertEquals("not-host", guest.answer("w1")["error"]!!.jsonPrimitive.content)

        val r = started(rig())
        r.transport.patchError = "stale-rev"
        r.send(req("w2", "state.patch") { put("patch", 1) })
        advanceUntilIdle()
        assertEquals("stale-rev", r.answer("w2")["error"]!!.jsonPrimitive.content)
    }

    @Test
    fun `state writes are rate limited by the manifest`() = runTest {
        val r = started(rig(app = app(state = ActivityStateCaps(maxBytes = 100, maxWritesPerSecond = 2))))
        repeat(4) { r.send(req("w$it", "state.patch") { put("patch", it) }) }
        advanceUntilIdle()
        val codes = (0..3).map { r.answer("w$it")["error"]?.jsonPrimitive?.contentOrNull }
        assertEquals(listOf(null, null, "rate-limited", "rate-limited"), codes)
    }

    @Test
    fun `events respect the manifest's size and rate, and zero means none`() = runTest {
        val r = started(rig())
        r.send(req("e1", "events.send") { put("name", "ping"); put("data", buildJsonObject { put("n", 1) }) })
        r.send(req("e2", "events.send") { put("name", "ping"); put("data", "z".repeat(100)) })
        advanceUntilIdle()
        assertEquals(true, r.answer("e1")["ok"]!!.jsonPrimitive.booleanOrNull)
        assertEquals("too-large", r.answer("e2")["error"]!!.jsonPrimitive.content)
        assertEquals(1, r.transport.events.size)

        val none = started(rig(app = app(events = ActivityEventCaps(maxPerSecond = 0, maxBytes = 0))))
        none.send(req("e3", "events.send") { put("name", "ping"); put("data", 1) })
        advanceUntilIdle()
        assertEquals("not-allowed", none.answer("e3")["error"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a string with a null character is refused rather than stored`() = runTest {
        val r = started(rig())
        r.send(req("w1", "state.patch") { put("patch", buildJsonObject { put("k", "a\u0000b") }) })
        advanceUntilIdle()
        assertEquals("invalid", r.answer("w1")["error"]!!.jsonPrimitive.content)
        assertTrue(r.transport.patches.isEmpty())
    }

    // --- what a phone is not ---

    @Test
    fun `a pane share is not allowed on a phone and only the host ends a session`() = runTest {
        val host = started(rig())
        host.send(req("s1", "share.request") { put("on", true) })
        host.send(req("x1", "session.end"))
        advanceUntilIdle()
        assertEquals("not-allowed", host.answer("s1")["error"]!!.jsonPrimitive.content)
        assertEquals(1, host.transport.ended)
        assertEquals(true, host.answer("x1")["ok"]!!.jsonPrimitive.booleanOrNull)

        val guest = started(rig(snapshot = snapshot(isHost = false)))
        guest.send(req("x2", "session.end"))
        advanceUntilIdle()
        assertEquals("not-host", guest.answer("x2")["error"]!!.jsonPrimitive.content)
        assertEquals(0, guest.transport.ended)
    }

    // --- the session's own news ---

    @Test
    fun `a revision never goes backwards and a duplicate is not pushed twice`() = runTest {
        val r = started(rig())
        r.transport.handlers!!.onState(3, buildJsonObject { put("v", 3) })
        r.transport.handlers!!.onState(2, buildJsonObject { put("v", 2) })
        r.transport.handlers!!.onState(3, buildJsonObject { put("v", 3) })
        advanceUntilIdle()
        val revs = r.pushes("state").map { it["rev"]!!.jsonPrimitive.content.toLong() }
        // the snapshot's own revision is the app's first state.get; pushes start after hello
        assertEquals(listOf(3L), revs)
    }

    @Test
    fun `losing the link is told to the app and writes wait for it`() = runTest {
        val r = started(rig())
        r.transport.handlers!!.onConnection(false)
        r.send(req("w1", "state.patch") { put("patch", 1) })
        advanceUntilIdle()
        assertEquals("reconnecting", r.pushes("connection").single()["status"]!!.jsonPrimitive.content)
        assertEquals("unavailable", r.answer("w1")["error"]!!.jsonPrimitive.content)
        r.transport.handlers!!.onConnection(true)
        assertEquals("online", r.pushes("connection").last()["status"]!!.jsonPrimitive.content)
    }

    @Test
    fun `an ended session is pushed once, tells the screen, and answers ended after`() = runTest {
        val r = started(rig())
        r.transport.handlers!!.onEnded(ActivityEndReason.Host)
        r.transport.handlers!!.onEnded(ActivityEndReason.Idle)
        r.send(req("s1", "state.get"))
        advanceUntilIdle()
        assertEquals("host", r.pushes("session.ended").single()["reason"]!!.jsonPrimitive.content)
        assertEquals(listOf(ActivityEndReason.Host), r.ended)
        assertEquals("ended", r.answer("s1")["error"]!!.jsonPrimitive.content)
        r.bridge.leave()
        assertEquals("a session that ended has no seat to release", 0, r.transport.left)
    }

    @Test
    fun `a flood is answered rate-limited and reported once it keeps going`() = runTest {
        val r = started(rig())
        repeat(1_000) { r.send(req("f$it", "state.get")) }
        advanceUntilIdle()
        assertTrue(r.posted.any { it["error"]?.jsonPrimitive?.contentOrNull == "rate-limited" })
        assertEquals(1, r.violations.size)
    }

    @Test
    fun `a screen that goes away mid-join releases the seat it just got`() = runTest {
        val r = rig()
        r.bridge.detach()
        r.bridge.start(false)
        assertEquals(1, r.transport.left)
        assertNull(r.transport.handlers)
    }

    @Test
    fun `a theme push goes out only when the theme differs`() = runTest {
        val env = Env()
        val r = started(rig(env = env))
        r.bridge.refreshTheme()
        assertTrue(r.pushes("theme").isEmpty())
        env.theme = mapOf("--color-accent" to "#5f8a28", "--pqp-color-scheme" to "light")
        r.bridge.refreshTheme()
        r.bridge.refreshTheme()
        assertEquals(1, r.pushes("theme").size)
        assertEquals("light", r.pushes("theme").single()["theme"]!!.jsonObject["--pqp-color-scheme"]!!.jsonPrimitive.content)
    }

    @Test
    fun `an invalid locale falls back to english`() = runTest {
        val r = started(rig(env = Env(locale = "not a locale!")))
        assertEquals("en", r.posted.first { it["type"]?.jsonPrimitive?.content == "hello" }["locale"]!!.jsonPrimitive.content)
    }
}
