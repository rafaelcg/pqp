package gg.pqp.app.core

import com.clerk.api.session.Session
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * "Your session expired. Sign in again." used to appear all over the app while
 * Profile still offered Sign out: nothing above the screens ever noticed a
 * dead session, and nothing changed the phase. These pin the single door that
 * replaced that: the mapping from what the server and Clerk say to "dead", the
 * idempotent handler, the HTTP layer's report of a 401, and a sign-out that
 * does not need the session it is ending.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionExpiryTest {

    // --- pure rules ---

    @Test
    fun `only a 401 is a dead session in the probe`() {
        assertEquals(SessionProbe.Dead, SessionExpiry.classifyProbe(401))
        assertEquals(SessionProbe.Alive, SessionExpiry.classifyProbe(200))
        assertEquals(SessionProbe.Alive, SessionExpiry.classifyProbe(204))
        // Not being able to tell is never a reason to sign somebody out.
        assertEquals(SessionProbe.Unknown, SessionExpiry.classifyProbe(null))
        for (status in listOf(403, 429, 500, 503)) {
            assertEquals("$status", SessionProbe.Unknown, SessionExpiry.classifyProbe(status))
        }
    }

    @Test
    fun `a refused refresh is no session and a failed one is unavailable`() {
        for (code in listOf(401, 403, 404)) {
            assertEquals(TokenRefresh.NoSession, SessionExpiry.classifyRefreshFailure(code))
        }
        for (code in listOf(null, 429, 500, 502)) {
            assertEquals(TokenRefresh.Unavailable, SessionExpiry.classifyRefreshFailure(code))
        }
    }

    @Test
    fun `every ended Clerk status is the session being over`() {
        assertTrue(SessionExpiry.isOver(null))
        // REPLACED is what single session mode does to the phone when the same
        // account signs in on another device.
        for (status in listOf(
            Session.SessionStatus.ENDED,
            Session.SessionStatus.EXPIRED,
            Session.SessionStatus.REMOVED,
            Session.SessionStatus.REPLACED,
            Session.SessionStatus.REVOKED,
            Session.SessionStatus.ABANDONED,
        )) {
            assertTrue("$status", SessionExpiry.isOver(status))
        }
        assertFalse(SessionExpiry.isOver(Session.SessionStatus.ACTIVE))
        assertFalse(
            "a sign-in waiting on a step is unfinished, not over",
            SessionExpiry.isOver(Session.SessionStatus.PENDING),
        )
        assertFalse(SessionExpiry.isOver(Session.SessionStatus.UNKNOWN))
    }

    // --- the handler ---

    private class Rig(scope: CoroutineScope, answer: suspend () -> SessionProbe = { SessionProbe.Dead }) {
        var account = true
        val probes = AtomicInteger()
        val endings = AtomicInteger()
        val gate = SessionExpiryGate(
            scope = scope,
            hasAccount = { account },
            probe = {
                probes.incrementAndGet()
                answer()
            },
            endSession = {
                endings.incrementAndGet()
                account = false
            },
        )
    }

    @Test
    fun `many concurrent 401s make one transition`() = runTest {
        val release = CompletableDeferred<Unit>()
        val rig = Rig(this) {
            release.await()
            SessionProbe.Dead
        }
        val callers = List(50) { async { rig.gate.handle() } }
        runCurrent()
        // The first caller claimed it while the probe is still in the air.
        assertEquals(1, rig.probes.get())
        release.complete(Unit)
        callers.awaitAll()
        assertEquals(1, rig.probes.get())
        assertEquals(1, rig.endings.get())
    }

    @Test
    fun `a 401 reported by the http layer after the session ended is ignored`() = runTest {
        val rig = Rig(this)
        val begunBefore = rig.gate.currentEpoch()
        rig.gate.sessionEnded() // the person signed out, or the session ended
        rig.account = true // and somebody signed in after
        rig.gate.noteUnauthorized(begunBefore)
        runCurrent()
        assertEquals("a late refusal belongs to the previous session", 0, rig.probes.get())
        assertEquals(0, rig.endings.get())

        rig.gate.noteUnauthorized(rig.gate.currentEpoch())
        runCurrent()
        assertEquals(1, rig.endings.get())
    }

    @Test
    fun `an unknown answer never signs anybody out and the next 401 asks again`() = runTest {
        var answer = SessionProbe.Unknown
        val rig = Rig(this) { answer }
        rig.gate.handle()
        assertEquals(0, rig.endings.get())
        answer = SessionProbe.Alive
        rig.gate.handle()
        assertEquals("a live session stays", 0, rig.endings.get())
        answer = SessionProbe.Dead
        rig.gate.handle()
        assertEquals(3, rig.probes.get())
        assertEquals(1, rig.endings.get())
    }

    @Test
    fun `with nobody signed in there is nothing to confirm`() = runTest {
        val rig = Rig(this)
        rig.account = false
        rig.gate.handle()
        assertEquals(0, rig.probes.get())
    }

    @Test
    fun `a sign out during the probe wins`() = runTest {
        val release = CompletableDeferred<Unit>()
        val rig = Rig(this) {
            release.await()
            SessionProbe.Dead
        }
        val handling = async { rig.gate.handle() }
        runCurrent()
        rig.account = false // the person tapped Sign out while the probe was in the air
        release.complete(Unit)
        handling.await()
        assertEquals(0, rig.endings.get())
    }

    // --- the interceptor, against a real socket ---

    private fun withServer(status: Int, onRequest: () -> Unit = {}, body: (String) -> Unit) {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange: HttpExchange ->
            onRequest()
            val bytes = "{}".toByteArray()
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            body("http://127.0.0.1:${server.address.port}/api/me")
        } finally {
            server.stop(0)
        }
    }

    private fun interceptedClient(rig: Rig): OkHttpClient =
        OkHttpClient.Builder().addInterceptor(SessionExpiryInterceptor { rig.gate }).build()

    private fun OkHttpClient.fetch(url: String, bearer: Boolean, probe: Boolean = false) {
        val request = Request.Builder().url(url)
        if (bearer) request.header("Authorization", "Bearer t")
        if (probe) request.tag(SessionProbeRequest::class.java, SessionProbeRequest)
        newCall(request.build()).execute().close()
    }

    @Test
    fun `an authenticated 401 reaches the handler and nothing else does`() = runTest {
        val rig = Rig(this)
        val client = interceptedClient(rig)

        withServer(401) { url ->
            // No bearer token: a presigned URL or an image, not a session.
            client.fetch(url, bearer = false)
            runCurrent()
            assertEquals(0, rig.probes.get())

            // The confirmation request itself never reports back to its own handler.
            client.fetch(url, bearer = true, probe = true)
            runCurrent()
            assertEquals(0, rig.probes.get())

            client.fetch(url, bearer = true)
            runCurrent()
            assertEquals(1, rig.probes.get())
        }
        withServer(200) { url ->
            client.fetch(url, bearer = true)
            runCurrent()
            assertEquals("a 200 is not a refusal", 1, rig.probes.get())
        }
    }

    @Test
    fun `a request begun before the session ended and refused after it is ignored`() = runTest {
        val rig = Rig(this)
        val client = interceptedClient(rig)
        // The session ends while the request is still being answered.
        withServer(401, onRequest = { rig.gate.sessionEnded() }) { url ->
            client.fetch(url, bearer = true)
        }
        runCurrent()
        assertEquals(0, rig.probes.get())
    }

    // --- sign out with a dead session ---

    @Test
    fun `sign out changes the screen at once even when every network step hangs`() = runTest {
        assumeTrue(Backend.authMode == AuthMode.DevBypass)
        val store = SessionStore(backgroundScope)
        store.seedPhaseForTesting(SessionPhase.AgeGate)
        store.deviceCleanup = { awaitCancellation() }

        store.signOut()
        runCurrent()
        assertEquals("the screen does not wait on the network", SessionPhase.SignedOut, store.phase.value)
        assertFalse("a sign out the person chose is not a message", store.sessionExpired.value)
        assertTrue(store.userSignOutInProgress)

        // The hung step is given up on after a few seconds, not waited on forever.
        advanceTimeBy(SessionStore.NETWORK_STEP_MS + 1)
        runCurrent()
        assertFalse(store.userSignOutInProgress)
    }

    @Test
    fun `a second sign out while one is running does nothing`() = runTest {
        assumeTrue(Backend.authMode == AuthMode.DevBypass)
        val store = SessionStore(backgroundScope)
        store.seedPhaseForTesting(SessionPhase.AgeGate)
        val calls = AtomicInteger()
        store.deviceCleanup = {
            calls.incrementAndGet()
            awaitCancellation()
        }
        store.signOut()
        store.signOut()
        runCurrent()
        assertEquals(1, calls.get())
    }
}
