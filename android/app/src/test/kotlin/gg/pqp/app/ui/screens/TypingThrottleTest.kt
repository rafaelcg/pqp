package gg.pqp.app.ui.screens

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The composer calls `typing()` on every keystroke, because a keystroke is the
 * only event it has. Forwarding all of them put one socket frame per character
 * on the wire, where the web client sends at most one every 2.5 seconds.
 */
class TypingThrottleTest {

    @Test
    fun `the first keystroke of a session always sends`() {
        assertTrue(ChatViewModel.shouldSendTyping(nowMs = 1_000, lastSentMs = 0))
    }

    @Test
    fun `a second keystroke in the same breath does not`() {
        assertFalse(ChatViewModel.shouldSendTyping(nowMs = 1_040, lastSentMs = 1_000))
    }

    @Test
    fun `the window is inclusive at its edge`() {
        assertTrue(
            ChatViewModel.shouldSendTyping(
                nowMs = 1_000 + ChatViewModel.TYPING_THROTTLE_MS,
                lastSentMs = 1_000,
            ),
        )
    }

    @Test
    fun `typing steadily sends once per window, not once per character`() {
        // 60 characters at 40ms apart is 2.4 seconds of typing: one frame, not
        // sixty. The old code sent sixty, and during a reconnect each one
        // aborted an attempt.
        var lastSent = 0L
        var sends = 0
        for (i in 0 until 60) {
            val now = 1L + i * 40L
            if (ChatViewModel.shouldSendTyping(now, lastSent)) {
                lastSent = now
                sends += 1
            }
        }
        assertTrue("expected one frame, sent $sends", sends == 1)
    }
}
