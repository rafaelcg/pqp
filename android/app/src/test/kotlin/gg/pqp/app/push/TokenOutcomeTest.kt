package gg.pqp.app.push

import com.google.android.gms.tasks.Tasks
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Play's second Android crash in October 2026: `RuntimeExecutionException`
 * from `PushController.firebaseToken`, cause `IOException: SERVICE_NOT_AVAILABLE`.
 * The listener read `task.result` before `task.isSuccessful`, and `getResult()`
 * on a failed task throws.
 */
class TokenOutcomeTest {

    @Test
    fun `a failed task is a failure carrying its own cause, not a crash`() {
        val cause = IOException("SERVICE_NOT_AVAILABLE")
        val outcome = tokenOutcome(Tasks.forException(cause))
        assertTrue(outcome.isFailure)
        assertSame(cause, outcome.exceptionOrNull())
        // And it lands on the retrying branch, which is the point of the fix.
        assertEquals(PushFailure.Transient, PushFailures.classifyToken(cause, playServicesPresent = true))
    }

    @Test
    fun `a token is a success`() {
        assertEquals("abc", tokenOutcome(Tasks.forResult("abc")).getOrNull())
    }

    @Test
    fun `an empty token is a failure`() {
        assertTrue(tokenOutcome(Tasks.forResult("")).isFailure)
    }
}
