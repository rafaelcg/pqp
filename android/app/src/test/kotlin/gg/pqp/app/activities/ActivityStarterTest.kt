package gg.pqp.app.activities

import gg.pqp.app.core.RealtimeState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val CHANNEL = "00000000-0000-4000-8000-00000000000a"
private const val SESSION_ID = "10000000-0000-4000-8000-000000000001"
private val eco = ActivityApp("pqp-eco", "1.0.2", available = true, capabilities = ActivityCapabilities(identity = "display"))
private val liveEco = ActivitySession(id = SESSION_ID, appId = "pqp-eco", startedBy = "u1")

/**
 * Starting from a channel in as few taps as the rules allow: one tap when the app was
 * accepted before, the consent sheet first when it was not, one request at a time, and a
 * refusal in the server's own classes.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ActivityStarterTest {

    private class Rig(scope: kotlinx.coroutines.CoroutineScope, accepted: Boolean) {
        val store = ActivitiesStore(
            scope = scope,
            frames = MutableSharedFlow<JsonObject>(),
            realtimeState = MutableStateFlow(RealtimeState.Ready),
            fetchConfig = { ActivitiesConfig.Off },
            fetchSessions = { emptyList() },
        )
        var consentOnFile = accepted
        val accepts = mutableListOf<Pair<String, Boolean>>()
        var acceptFails = false
        val starts = mutableListOf<String>()
        var startGate: CompletableDeferred<Unit>? = null
        var startError: Throwable? = null
        val consents = ActivityConsents(
            read = { if (consentOnFile) listOf(ActivityConsent("pqp-eco")) else emptyList() },
            write = { app, identity ->
                if (acceptFails) error("offline")
                accepts += app to identity
                consentOnFile = true
            },
        )
        val starter = ActivityStarter(scope, store, consents, CHANNEL) { appId ->
            starts += appId
            startGate?.await()
            startError?.let { throw it }
            liveEco
        }
        val opened = mutableListOf<ActivityStarter.Started>()

        init {
            scope.launch { starter.started.collect { opened += it } }
        }
    }

    private fun TestScope.rig(accepted: Boolean) = Rig(backgroundScope, accepted)

    @Test
    fun `one tap starts it when the app was accepted before`() = runTest {
        val r = rig(accepted = true)
        r.starter.tap(eco)
        runCurrent()
        assertEquals(listOf("pqp-eco"), r.starts)
        assertNull("no sheet in the way", r.starter.state.value.consentFor)
        assertEquals(SESSION_ID, r.opened.single().session.id)
        assertEquals("the strip knows before the frame does", SESSION_ID, r.store.session(CHANNEL)?.id)
        assertNull(r.starter.state.value.starting)
    }

    @Test
    fun `the first time the consent sheet comes first and nothing starts until yes`() = runTest {
        val r = rig(accepted = false)
        r.starter.tap(eco)
        runCurrent()
        assertEquals("pqp-eco", r.starter.state.value.consentFor)
        assertTrue(r.starts.isEmpty())
        r.starter.dismissConsent()
        assertNull("agora não leaves everything as it was", r.starter.state.value.consentFor)
        assertTrue(r.starts.isEmpty())

        r.starter.tap(eco)
        runCurrent()
        r.starter.confirmConsent(eco, identityGranted = true)
        runCurrent()
        assertEquals(listOf("pqp-eco" to true), r.accepts)
        assertEquals(listOf("pqp-eco"), r.starts)
        assertEquals(1, r.opened.size)
        assertNull(r.starter.state.value.consentFor)
    }

    @Test
    fun `a consent that could not be saved says so and starts nothing`() = runTest {
        val r = rig(accepted = false)
        r.acceptFails = true
        r.starter.tap(eco)
        runCurrent()
        r.starter.confirmConsent(eco, false)
        runCurrent()
        assertTrue(r.starter.state.value.consentFailed)
        assertFalse(r.starter.state.value.consentWorking)
        assertTrue(r.starts.isEmpty())
        // and the same button tries again
        r.acceptFails = false
        r.starter.confirmConsent(eco, false)
        runCurrent()
        assertEquals(1, r.starts.size)
    }

    @Test
    fun `a second tap while one start is out does nothing`() = runTest {
        val r = rig(accepted = true)
        r.startGate = CompletableDeferred()
        r.starter.tap(eco)
        runCurrent()
        assertEquals("pqp-eco", r.starter.state.value.starting)
        r.starter.tap(eco)
        runCurrent()
        assertEquals(1, r.starts.size)
        r.startGate!!.complete(Unit)
        runCurrent()
        assertEquals(1, r.opened.size)
    }

    @Test
    fun `a start that outlives eight seconds is a failure the person can retry`() = runTest {
        val r = rig(accepted = true)
        r.startGate = CompletableDeferred()
        r.starter.tap(eco)
        runCurrent()
        advanceTimeBy(ActivityStarter.START_TIMEOUT_MS + 1)
        runCurrent()
        assertEquals(ActivityRules.StartFailure.Failed, r.starter.state.value.failure)
        assertNull(r.starter.state.value.starting)
        assertTrue(r.opened.isEmpty())
        r.startGate = null
        r.starter.tap(eco)
        runCurrent()
        assertEquals(1, r.opened.size)
    }

    @Test
    fun `a session somebody started first is adopted and named, never a bare error`() = runTest {
        val r = rig(accepted = true)
        r.startError = StartRefusal.AlreadyLive(liveEco)
        r.starter.tap(eco)
        runCurrent()
        assertEquals(ActivityRules.StartFailure.SessionLive, r.starter.state.value.failure)
        assertEquals("u1", r.starter.state.value.liveByUserId)
        assertEquals(SESSION_ID, r.store.session(CHANNEL)?.id)
        assertTrue("the starter is not opened onto somebody else's room", r.opened.isEmpty())
    }

    @Test
    fun `every refusal has its own class`() {
        assertEquals(ActivityRules.StartFailure.CannotStart, ActivityRules.failureOf(StartRefusal.CannotStart))
        assertEquals(ActivityRules.StartFailure.RateLimited, ActivityRules.failureOf(StartRefusal.RateLimited))
        assertEquals(ActivityRules.StartFailure.Unavailable, ActivityRules.failureOf(StartRefusal.Unavailable("flag-off")))
        assertEquals(ActivityRules.StartFailure.Failed, ActivityRules.failureOf(StartRefusal.Failed(404)))
    }

    @Test
    fun `an unexpected error is a plain failure`() = runTest {
        val r = rig(accepted = true)
        r.startError = java.io.IOException("offline")
        r.starter.tap(eco)
        runCurrent()
        assertEquals(ActivityRules.StartFailure.Failed, r.starter.state.value.failure)
        r.starter.clearFailure()
        assertNull(r.starter.state.value.failure)
    }
}
