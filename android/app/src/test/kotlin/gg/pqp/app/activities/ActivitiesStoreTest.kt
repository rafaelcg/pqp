package gg.pqp.app.activities

import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.ServerMember
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val SERVER = "srv-1"
private const val CH_A = "00000000-0000-4000-8000-00000000000a"
private const val CH_B = "00000000-0000-4000-8000-00000000000b"
private const val S1 = "10000000-0000-4000-8000-000000000001"
private const val S2 = "10000000-0000-4000-8000-000000000002"
private const val ME = "11111111-1111-4111-8111-111111111111"

private fun session(id: String, app: String = "pqp-eco", players: Int = 1) = ActivitySession(
    id = id, appId = app, startedBy = ME, hostUserId = ME, startedAt = "2026-11-10T12:00:00.000Z",
    participants = listOf(ActivitySessionParticipant(ME)), players = players,
)

private fun on(vararg apps: ActivityApp) = ActivitiesConfig(enabled = true, origin = "http://localhost:5175", apps = apps.toList())

private fun frame(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

/** The live store: seeded by a read, kept right by `channel-app`, and quiet when activities are off. */
@OptIn(ExperimentalCoroutinesApi::class)
class ActivitiesStoreTest {

    private class Rig(scope: kotlinx.coroutines.CoroutineScope) {
        val frames = MutableSharedFlow<JsonObject>(extraBufferCapacity = 32)
        val state = MutableStateFlow(RealtimeState.Ready)
        var config: ActivitiesConfig? = on(ActivityApp("pqp-eco", "1.0.2", available = true))
        var sessions: List<ChannelSession> = emptyList()
        var sessionsGate: CompletableDeferred<Unit>? = null
        var configReads = 0
        var sessionReads = 0
        var memberReads = 0
        var members: List<ServerMember> = listOf(ServerMember(id = ME, displayName = "Ana"))
        var failSessions = false
        var clock = 1_000L
        val store = ActivitiesStore(
            scope = scope,
            frames = frames,
            realtimeState = state,
            fetchConfig = { configReads += 1; config },
            fetchSessions = {
                sessionReads += 1
                val gate = sessionsGate
                val answer = sessions
                gate?.await()
                if (failSessions) error("offline")
                answer
            },
            fetchMembers = { memberReads += 1; members },
            now = { clock },
        )
    }

    private fun TestScope.rig() = Rig(backgroundScope)

    @Test
    fun `a server with activities off draws nothing and asks for no sessions`() = runTest {
        val r = rig()
        r.config = ActivitiesConfig.Off
        r.sessions = listOf(ChannelSession(CH_A, session(S1)))
        r.store.watch(SERVER)
        runCurrent()
        assertFalse(r.store.config(SERVER).enabled)
        assertTrue(r.store.sessions.value.isEmpty())
        assertEquals(0, r.sessionReads)
    }

    @Test
    fun `a watched server is read once and its live sessions are kept by channel`() = runTest {
        val r = rig()
        r.sessions = listOf(ChannelSession(CH_A, session(S1)), ChannelSession(CH_B, null))
        r.store.watch(SERVER)
        r.store.watch(SERVER) // asked again at once: one read
        runCurrent()
        assertEquals(1, r.configReads)
        assertEquals(S1, r.store.session(CH_A)?.id)
        assertNull(r.store.session(CH_B))
        assertEquals("Ana", r.store.memberOf(SERVER, ME)?.displayName)
    }

    @Test
    fun `channel-app starts and ends a session live`() = runTest {
        val r = rig()
        r.store.watch(SERVER)
        runCurrent()
        r.frames.tryEmit(
            frame(
                """{"type":"channel-app","channelId":"$CH_A","session":{"id":"$S1","appId":"pqp-eco","appVersion":"1.0.2",
                "startedBy":"$ME","hostUserId":"$ME","startedAt":"2026-11-10T12:00:00.000Z","participants":[],"players":0,"spectators":0,"handoff":null}}""",
            ),
        )
        runCurrent()
        assertEquals(S1, r.store.session(CH_A)?.id)
        r.frames.tryEmit(frame("""{"type":"channel-app","channelId":"$CH_A","session":null}"""))
        runCurrent()
        assertNull(r.store.session(CH_A))
    }

    @Test
    fun `a frame that lands while a read is in flight wins over that read`() = runTest {
        val r = rig()
        r.sessions = listOf(ChannelSession(CH_A, session(S1)))
        r.sessionsGate = CompletableDeferred()
        r.store.watch(SERVER)
        runCurrent()
        // the read has its answer (A is live) but has not landed; meanwhile A ends
        r.frames.tryEmit(frame("""{"type":"channel-app","channelId":"$CH_A","session":null}"""))
        runCurrent()
        r.sessionsGate!!.complete(Unit)
        runCurrent()
        assertNull("a slow answer must not bring back a session that ended", r.store.session(CH_A))
    }

    @Test
    fun `a read retires a session that is gone and keeps the ones a frame just told`() = runTest {
        val r = rig()
        r.sessions = listOf(ChannelSession(CH_A, session(S1)))
        r.store.watch(SERVER)
        runCurrent()
        assertEquals(S1, r.store.session(CH_A)?.id)
        // the next read has nothing for A: it ended while the socket was away
        r.sessions = emptyList()
        r.clock += ActivitiesStore.CONFIG_TTL_MS + 1
        r.store.watch(SERVER)
        runCurrent()
        assertNull(r.store.session(CH_A))
    }

    @Test
    fun `a failed session read keeps what was on screen`() = runTest {
        val r = rig()
        r.sessions = listOf(ChannelSession(CH_A, session(S1)))
        r.store.watch(SERVER)
        runCurrent()
        r.failSessions = true
        r.store.refresh(SERVER)
        runCurrent()
        assertEquals(S1, r.store.session(CH_A)?.id)
    }

    @Test
    fun `app-ended clears the channel's strip even if the channel-app frame was lost`() = runTest {
        val r = rig()
        r.sessions = listOf(ChannelSession(CH_A, session(S1)))
        r.store.watch(SERVER)
        runCurrent()
        r.frames.tryEmit(
            frame("""{"type":"app-ended","sessionId":"$S1","channelId":"$CH_A","reason":"host","summary":{"participants":2,"durationSeconds":60}}"""),
        )
        runCurrent()
        assertNull(r.store.session(CH_A))
        // an ending for a session that is not the live one clears nothing
        r.store.adopt(CH_B, session(S2))
        r.frames.tryEmit(
            frame("""{"type":"app-ended","sessionId":"$S1","channelId":"$CH_B","reason":"host","summary":{"participants":0,"durationSeconds":0}}"""),
        )
        runCurrent()
        assertEquals(S2, r.store.session(CH_B)?.id)
    }

    @Test
    fun `a reconnect reads every watched server again, the first connect does not`() = runTest {
        val r = rig()
        r.store.watch(SERVER)
        runCurrent()
        val reads = r.sessionReads
        r.state.value = RealtimeState.Reconnecting
        runCurrent()
        r.state.value = RealtimeState.Ready
        runCurrent()
        assertEquals(reads + 1, r.sessionReads)
    }

    @Test
    fun `somebody who joined after the list was read is found, and a stranger costs one read`() = runTest {
        val r = rig()
        r.sessions = listOf(ChannelSession(CH_A, session(S1)))
        r.store.watch(SERVER)
        runCurrent()
        assertEquals(1, r.memberReads)
        // a member the cached list does not have: asked for, once, and then not again until the retry window
        r.members = listOf(ServerMember(id = ME, displayName = "Ana"), ServerMember(id = "bob", displayName = "Bob"))
        r.clock += ActivitiesStore.MEMBERS_RETRY_MS + 1
        assertEquals("Bob", r.store.resolveMember(SERVER, "bob")?.displayName)
        assertEquals(2, r.memberReads)
        assertNull(r.store.resolveMember(SERVER, "stranger"))
        assertNull(r.store.resolveMember(SERVER, "stranger"))
        assertEquals("a stranger inside the retry window costs no read", 2, r.memberReads)
        r.clock += ActivitiesStore.MEMBERS_RETRY_MS + 1
        assertNull(r.store.resolveMember(SERVER, "stranger"))
        assertNull(r.store.resolveMember(SERVER, "stranger"))
        assertEquals("and one read once the window has passed", 3, r.memberReads)
    }

    @Test
    fun `sign-out forgets everything`() = runTest {
        val r = rig()
        r.sessions = listOf(ChannelSession(CH_A, session(S1)))
        r.store.watch(SERVER)
        runCurrent()
        r.store.clear()
        assertTrue(r.store.sessions.value.isEmpty())
        assertTrue(r.store.configs.value.isEmpty())
        assertNull(r.store.memberOf(SERVER, ME))
    }

    @Test
    fun `a frame decodes to the summary the strip reads`() {
        val decoded = ActivityFrame.decode(
            frame(
                """{"type":"channel-app","channelId":"$CH_A","session":{"id":"$S1","appId":"pqp-eco","appVersion":"1.0.2","startedBy":"$ME",
                "hostUserId":"$ME","startedAt":"2026-11-10T12:00:00.000Z","participants":[{"userId":"$ME","role":"player","joinedAt":"2026-11-10T12:00:01.000Z","connection":"present"}],
                "players":1,"spectators":2,"handoff":{"toUserId":null,"at":"2026-11-10T12:02:00.000Z"},"unknown":"dropped"}}""",
            ),
        ) as ActivityFrame.ChannelApp
        val s = decoded.session!!
        assertEquals(3, s.total)
        assertTrue(s.isSeated(ME))
        assertNull(s.handoff?.toUserId)
        assertNull("a frame the phone cannot read is waited out", ActivityFrame.decode(frame("""{"type":"channel-app"}""")))
        assertNull(ActivityFrame.decode(frame("""{"type":"message-broadcast"}""")))
    }

    @Test
    fun `a lookup that did not answer is not an off answer and is asked again`() = runTest {
        val r = rig()
        r.sessions = listOf(ChannelSession(CH_A, session(S1)))
        r.store.watch(SERVER)
        runCurrent()
        assertEquals(S1, r.store.session(CH_A)?.id)
        // the next read gets no answer at all: what was known stays, and the server is not marked fresh
        r.config = null
        r.clock += ActivitiesStore.CONFIG_TTL_MS + 1
        r.store.watch(SERVER)
        runCurrent()
        assertTrue(r.store.config(SERVER).enabled)
        assertEquals(S1, r.store.session(CH_A)?.id)
        val reads = r.configReads
        r.config = on(ActivityApp("pqp-eco", "1.0.2", available = true))
        r.store.watch(SERVER) // still stale, so it asks again at once instead of waiting out a TTL
        runCurrent()
        assertEquals(reads + 1, r.configReads)
    }

    @Test
    fun `a session that ended while the socket was down is retired by the read that follows`() = runTest {
        val r = rig()
        r.store.knowChannels(SERVER, listOf(CH_A))
        r.store.watch(SERVER)
        runCurrent()
        // it arrived as a frame (never in a read), and its end frame is lost
        r.frames.tryEmit(
            frame(
                """{"type":"channel-app","channelId":"$CH_A","session":{"id":"$S1","appId":"pqp-eco","appVersion":"1.0.2",
                "startedBy":"$ME","hostUserId":"$ME","startedAt":"2026-11-10T12:00:00.000Z","participants":[],"players":0,"spectators":0,"handoff":null}}""",
            ),
        )
        runCurrent()
        assertEquals(S1, r.store.session(CH_A)?.id)
        r.state.value = RealtimeState.Reconnecting
        runCurrent()
        r.state.value = RealtimeState.Ready
        runCurrent()
        assertNull(r.store.session(CH_A))
    }

    @Test
    fun `the roster is read only when something is running, and one read serves every asker`() = runTest {
        val r = rig()
        r.store.watch(SERVER)
        runCurrent()
        assertEquals("nothing running, no roster", 0, r.memberReads)
        r.members = listOf(ServerMember(id = ME, displayName = "Ana"), ServerMember(id = "u2", displayName = "Bia"), ServerMember(id = "u3", displayName = "Caio"))
        r.clock += ActivitiesStore.MEMBERS_RETRY_MS + 1
        val a = backgroundScope.async { r.store.resolveMember(SERVER, "u2") }
        val b = backgroundScope.async { r.store.resolveMember(SERVER, "u3") }
        val c = backgroundScope.async { r.store.resolveMember(SERVER, ME) }
        runCurrent()
        assertEquals("Bia", a.await()?.displayName)
        assertEquals("Caio", b.await()?.displayName)
        assertEquals("Ana", c.await()?.displayName)
        assertEquals(1, r.memberReads)
    }

    @Test
    fun `only the latest few servers keep a roster`() = runTest {
        val r = rig()
        for (i in 1..6) {
            r.sessions = listOf(ChannelSession("c$i", session("10000000-0000-4000-8000-00000000000$i")))
            r.store.watch("srv-$i")
            runCurrent()
        }
        val held = (1..6).count { r.store.memberOf("srv-$it", ME) != null }
        assertEquals(ActivitiesStore.MEMBERS_SERVERS_KEPT, held)
        assertNull("the oldest went first", r.store.memberOf("srv-1", ME))
        assertTrue(r.store.memberOf("srv-6", ME) != null)
    }
}
