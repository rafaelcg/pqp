package gg.pqp.app.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** When a network coming back is worth cutting the socket's backoff short for. */
class NetworkReconnectTest {

    @Test
    fun `a socket that is trying and not connected is nudged`() {
        assertTrue(NetworkReconnect.shouldRetry(RealtimeState.Reconnecting))
        assertTrue(NetworkReconnect.shouldRetry(RealtimeState.Connecting))
    }

    @Test
    fun `a connected socket has nothing to fix`() {
        assertFalse(NetworkReconnect.shouldRetry(RealtimeState.Ready))
    }

    @Test
    fun `a socket nobody wants is not started by the network coming back`() {
        assertFalse(NetworkReconnect.shouldRetry(RealtimeState.Idle))
    }

    @Test
    fun `a socket the server refused would only be refused again`() {
        assertFalse(NetworkReconnect.shouldRetry(RealtimeState.Refused))
    }
}
