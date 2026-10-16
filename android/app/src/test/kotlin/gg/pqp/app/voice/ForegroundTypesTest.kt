package gg.pqp.app.voice

import android.content.pm.ServiceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reported bug: "Android would not start the screen capture" on every
 * Android 10 to 13 phone. `MediaProjectionManager.getMediaProjection` needs the
 * RUNNING foreground type to include `mediaProjection`, and the service used to
 * declare none below Android 14.
 */
class ForegroundTypesTest {

    private val mediaProjection = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION

    @Test
    fun `a share names mediaProjection on every release that checks it`() {
        for (sdk in 29..37) {
            val types = voiceForegroundTypes(sdk, projecting = true)
            assertTrue(
                "API $sdk must declare mediaProjection while a share is running",
                types and mediaProjection != 0,
            )
        }
    }

    @Test
    fun `android 10 to 13 are the releases that used to declare nothing`() {
        // Pinned on its own because it is the regression: 0 here is what made
        // every share on these releases fail inside the capturer.
        for (sdk in 29..33) {
            assertTrue(voiceForegroundTypes(sdk, projecting = true) != 0)
        }
    }

    @Test
    fun `an ordinary call is unchanged below android 14`() {
        for (sdk in 26..33) {
            assertEquals(0, voiceForegroundTypes(sdk, projecting = false))
        }
    }

    @Test
    fun `android 14 and later carry the microphone and the call type, plus the share`() {
        val call = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
            ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
        assertEquals(call, voiceForegroundTypes(34, projecting = false))
        assertEquals(call or mediaProjection, voiceForegroundTypes(34, projecting = true))
        assertEquals(call or mediaProjection, voiceForegroundTypes(37, projecting = true))
    }

    @Test
    fun `android 10 can name only the projection, android 11 adds the call types`() {
        assertEquals(mediaProjection, voiceForegroundTypes(29, projecting = true))
        assertEquals(
            mediaProjection or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
            voiceForegroundTypes(30, projecting = true),
        )
    }

    @Test
    fun `below android 10 nothing is declared`() {
        assertEquals(0, voiceForegroundTypes(28, projecting = true))
    }
}
