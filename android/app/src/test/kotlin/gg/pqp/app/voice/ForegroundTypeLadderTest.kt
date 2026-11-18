package gg.pqp.app.voice

import android.content.pm.ServiceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Play vitals on 0.4.28: `SecurityException` from `VoiceService.onStartCommand`.
 * Android 14 refuses `startForeground` with the `microphone` type when
 * RECORD_AUDIO is not granted, or when the app is not in a state where a
 * while-in-use permission counts, and the service passed exactly one type set
 * and let the refusal crash the app.
 *
 * [androidFourteen] stands in for the platform's check, which a JVM test cannot
 * run: it refuses `microphone` unless the microphone is usable, and
 * `mediaProjection` unless a projection grant is live, the two rules that throw.
 */
class ForegroundTypeLadderTest {

    private val mic = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    private val call = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
    private val projection = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION

    private fun androidFourteen(micUsable: Boolean, projectionUsable: Boolean = true): (Int) -> Unit = { types ->
        if (types and mic != 0 && !micUsable) {
            throw SecurityException("Starting FGS with type microphone requires permissions")
        }
        if (types and projection != 0 && !projectionUsable) {
            throw SecurityException("Starting FGS with type mediaProjection requires permissions")
        }
    }

    @Test
    fun `the old single attempt is what crashed`() {
        // 0.4.28 offered this one set and nothing else.
        val old = voiceForegroundTypes(34, projecting = false)
        assertTrue(old and mic != 0)
        try {
            androidFourteen(micUsable = false)(old)
            fail("the platform stand-in should refuse the microphone type")
        } catch (expected: SecurityException) {
            // The crash in Play vitals.
        }
    }

    @Test
    fun `a call with the microphone usable gets exactly what it always got`() {
        for (sdk in 26..37) {
            for (projecting in listOf(false, true)) {
                val ladder = voiceForegroundTypeLadder(sdk, projecting, microphoneGranted = true)
                assertEquals(voiceForegroundTypes(sdk, projecting), ladder.first())
                val accepted = startForegroundOnLadder(ladder, androidFourteen(micUsable = true))
                assertEquals(voiceForegroundTypes(sdk, projecting), accepted)
            }
        }
    }

    @Test
    fun `no microphone permission never offers the microphone type`() {
        for (sdk in 26..37) {
            for (projecting in listOf(false, true)) {
                voiceForegroundTypeLadder(sdk, projecting, microphoneGranted = false).forEach {
                    assertEquals("API $sdk offered microphone without the permission", 0, it and mic)
                }
            }
        }
        val accepted = startForegroundOnLadder(
            voiceForegroundTypeLadder(34, projecting = false, microphoneGranted = false),
            androidFourteen(micUsable = false),
        )
        assertEquals(call, accepted)
    }

    @Test
    fun `a call rebuilt from the background keeps going without the microphone type`() {
        // Permission granted, but Android 14 will not count it from here.
        val refused = mutableListOf<Int>()
        val accepted = startForegroundOnLadder(
            voiceForegroundTypeLadder(34, projecting = false, microphoneGranted = true),
            androidFourteen(micUsable = false),
            onRefused = { types, _ -> refused += types },
        )
        assertEquals(call, accepted)
        assertEquals(listOf(mic or call), refused)
    }

    @Test
    fun `a share keeps its projection when only the microphone is refused`() {
        val accepted = startForegroundOnLadder(
            voiceForegroundTypeLadder(34, projecting = true, microphoneGranted = true),
            androidFourteen(micUsable = false),
        )
        assertEquals(call or projection, accepted)
    }

    @Test
    fun `a refused projection keeps the microphone and drops only the share`() {
        val accepted = startForegroundOnLadder(
            voiceForegroundTypeLadder(34, projecting = true, microphoneGranted = true),
            androidFourteen(micUsable = true, projectionUsable = false),
        )
        assertEquals(mic or call, accepted)
    }

    @Test
    fun `the floor is the call type on android 14 and no type below it`() {
        assertEquals(call, voiceForegroundTypeLadder(34, projecting = true, microphoneGranted = true).last())
        assertEquals(0, voiceForegroundTypeLadder(33, projecting = true, microphoneGranted = true).last())
        assertEquals(listOf(0), voiceForegroundTypeLadder(33, projecting = false, microphoneGranted = true))
    }

    @Test
    fun `when every rung is refused the app fails exactly as before`() {
        val last = SecurityException("no")
        try {
            startForegroundOnLadder(listOf(mic or call, call), start = { throw last })
            fail("expected the last refusal to be rethrown")
        } catch (thrown: SecurityException) {
            assertSame(last, thrown)
        }
    }
}
