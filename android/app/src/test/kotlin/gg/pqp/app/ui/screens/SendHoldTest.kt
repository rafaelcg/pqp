package gg.pqp.app.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The slow mode countdown's one rule, and the refusal tokens it reacts to.
 *
 * The composer disables send while `remainingWaitSeconds` is above zero and
 * prints the number, so the two halves of that function are "does the button
 * come back" and "does the label ever lie". Both are cheap to pin and both
 * would be invisible in a JVM test of the view model, which has no clock.
 */
class SendHoldTest {

    @Test
    fun `no hold is zero seconds`() {
        assertEquals(0, ChatViewModel.remainingWaitSeconds(untilMs = 0L, nowMs = 5_000L))
    }

    @Test
    fun `a hold that has passed is zero seconds, never negative`() {
        assertEquals(0, ChatViewModel.remainingWaitSeconds(untilMs = 4_000L, nowMs = 5_000L))
    }

    @Test
    fun `the label rounds up, so it never promises a second that is already gone`() {
        // 2.4 seconds left reads as 3, not 2: a "2s" that becomes a refusal
        // because 400ms were truncated is the countdown lying.
        assertEquals(3, ChatViewModel.remainingWaitSeconds(untilMs = 7_400L, nowMs = 5_000L))
        assertEquals(1, ChatViewModel.remainingWaitSeconds(untilMs = 5_001L, nowMs = 5_000L))
        assertEquals(2, ChatViewModel.remainingWaitSeconds(untilMs = 7_000L, nowMs = 5_000L))
    }

    @Test
    fun `every wire token maps to a reason and an unknown one maps to none`() {
        assertEquals(MessageRejectReason.SlowMode, MessageRejectReason.fromWire("slow-mode"))
        assertEquals(MessageRejectReason.RateLimited, MessageRejectReason.fromWire("rate-limited"))
        assertEquals(MessageRejectReason.NoAccess, MessageRejectReason.fromWire("no-access"))
        assertEquals(MessageRejectReason.CannotSend, MessageRejectReason.fromWire("cannot-send"))
        assertEquals(MessageRejectReason.Undeliverable, MessageRejectReason.fromWire("undeliverable"))
        // A token from a newer server is not a crash and not a dropped frame:
        // the row still comes down, under a generic sentence.
        assertNull(MessageRejectReason.fromWire("some-future-reason"))
        assertNull(MessageRejectReason.fromWire(null))
    }
}
