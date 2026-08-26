package gg.pqp.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The rule that decides whether a frame which could not leave tears the socket
 * down.
 *
 * The bug this pins is subtle enough to deserve a test of its own: `socket` is
 * non-null from the moment `newWebSocket` returns, all the way through the auth
 * handshake, so "there is no socket" was never true during a reconnect. Every
 * frame sent while one was in progress cancelled the attempt that was about to
 * succeed, which the backoff then punished. With a `typing` frame per keystroke
 * that was one aborted attempt per character.
 */
class RealtimeSendTest {

    @Test
    fun `a connect attempt in flight is waited on, never cancelled`() {
        assertEquals(
            RealtimeClient.SendFallback.Wait,
            RealtimeClient.fallbackFor(ready = false, attemptInFlight = true),
        )
    }

    @Test
    fun `a ready socket that refuses a frame is a dead socket`() {
        // `ready` with a send that returned false means the socket is up as far
        // as this client knows and still would not take the frame. That is the
        // case the reconnect exists for.
        assertEquals(
            RealtimeClient.SendFallback.Reconnect,
            RealtimeClient.fallbackFor(ready = true, attemptInFlight = true),
        )
    }

    @Test
    fun `no socket and nothing trying is a reconnect`() {
        assertEquals(
            RealtimeClient.SendFallback.Reconnect,
            RealtimeClient.fallbackFor(ready = false, attemptInFlight = false),
        )
    }
}
