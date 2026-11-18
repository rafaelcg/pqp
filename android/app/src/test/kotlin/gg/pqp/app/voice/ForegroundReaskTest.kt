package gg.pqp.app.voice

import android.content.pm.ServiceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A call that fell back to a rung without the microphone type (see
 * [ForegroundTypeLadderTest]) stayed there for the rest of the call: Android
 * silences the recording whenever the app is in the background on that rung,
 * returning to the app un-silenced it only while visible, and nothing asked for
 * the full set again. These pin the ask that does, and its limits.
 *
 * [platform] stands in for Android 14's check, as in the ladder tests: it
 * refuses `microphone` while [Platform.micUsable] is false.
 */
class ForegroundReaskTest {

    private val mic = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    private val call = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
    private val projection = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION

    private class Platform(var micUsable: Boolean) {
        val offered = mutableListOf<Int>()
    }

    private fun start(platform: Platform): (Int) -> Unit = { types ->
        platform.offered += types
        if (types and mic != 0 && !platform.micUsable) {
            throw SecurityException("Starting FGS with type microphone requires permissions")
        }
    }

    /** A call that joined from the background and landed on the floor rung. */
    private fun fellBack(sdk: Int = 34, projecting: Boolean = false): Pair<ForegroundRung, List<Int>> {
        val ladder = voiceForegroundTypeLadder(sdk, projecting, microphoneGranted = true)
        val rung = ForegroundRung()
        val accepted = startForegroundOnLadder(ladder, start(Platform(micUsable = false)))
        rung.record(ladder.first(), accepted)
        return rung to ladder
    }

    @Test
    fun `a re-ask on foreground succeeds and upgrades to the full set`() {
        val (rung, ladder) = fellBack()
        assertEquals(call, rung.running)
        assertTrue(rung.lesser)

        val platform = Platform(micUsable = true)
        var asks = 0
        rung.onAppForeground {
            asks += 1
            val accepted = reaskForegroundOnLadder(ladder, rung.running!!, start(platform))
            rung.record(ladder.first(), accepted)
        }

        assertEquals(1, asks)
        assertEquals(mic or call, rung.running)
        assertFalse(rung.lesser)
        assertEquals(listOf(mic or call), platform.offered)
    }

    @Test
    fun `a refused re-ask keeps the rung and neither throws nor downgrades`() {
        val (rung, ladder) = fellBack()
        val platform = Platform(micUsable = false)
        val refused = mutableListOf<Int>()

        val accepted = reaskForegroundOnLadder(
            ladder,
            rung.running!!,
            start(platform),
            onRefused = { types, _ -> refused += types },
        )

        assertEquals(call, accepted)
        assertEquals(listOf(mic or call), refused)
        // It tried the full set, then re-posted the rung it already had.
        assertEquals(listOf(mic or call, call), platform.offered)
    }

    @Test
    fun `a refused re-ask on a share does not trade the microphone for the projection`() {
        // Holding microphone + call, projection wanted and refused: the
        // fallback ladder alone would go on to `call + projection`.
        val ladder = voiceForegroundTypeLadder(34, projecting = true, microphoneGranted = true)
        val running = mic or call
        val platform = Platform(micUsable = true)
        val accepted = reaskForegroundOnLadder(ladder, running, start = { types ->
            platform.offered += types
            if (types and projection != 0) throw SecurityException("no projection")
        })
        assertEquals(running, accepted)
        assertTrue("never offered a rung below the one held", platform.offered.all { it == running || it == ladder.first() })
    }

    @Test
    fun `when even the held rung is refused the re-ask still returns it`() {
        val (rung, ladder) = fellBack()
        val accepted = reaskForegroundOnLadder(ladder, rung.running!!, start = { throw SecurityException("no") })
        assertEquals(call, accepted)
    }

    @Test
    fun `no re-ask when the call is already on the rung it wanted`() {
        val ladder = voiceForegroundTypeLadder(34, projecting = false, microphoneGranted = true)
        val rung = ForegroundRung()
        rung.record(ladder.first(), startForegroundOnLadder(ladder, start(Platform(micUsable = true))))
        var asks = 0
        rung.onAppForeground { asks += 1 }
        rung.onMuteToggled { asks += 1 }
        assertEquals(0, asks)
    }

    @Test
    fun `no re-ask when the microphone was never wanted`() {
        // No permission: the first rung already leaves the type out, so the
        // floor is what was asked for and there is nothing to get back.
        val ladder = voiceForegroundTypeLadder(34, projecting = false, microphoneGranted = false)
        val rung = ForegroundRung()
        rung.record(ladder.first(), startForegroundOnLadder(ladder, start(Platform(micUsable = false))))
        var asks = 0
        rung.onAppForeground { asks += 1 }
        assertEquals(0, asks)
        assertFalse(microphonePaused(ladder.first(), rung.running!!))
    }

    @Test
    fun `no re-ask while there is no service`() {
        val rung = ForegroundRung()
        var asks = 0
        rung.onAppForeground { asks += 1 }
        rung.onMuteToggled { asks += 1 }
        assertEquals(0, asks)
        val (fell, _) = fellBack()
        fell.clear()
        assertNull(fell.running)
        fell.onAppForeground { asks += 1 }
        assertEquals(0, asks)
    }

    @Test
    fun `a mute toggle triggers the re-ask on a lesser rung`() {
        val (rung, ladder) = fellBack()
        val platform = Platform(micUsable = true)
        var asks = 0
        rung.onMuteToggled {
            asks += 1
            rung.record(ladder.first(), reaskForegroundOnLadder(ladder, rung.running!!, start(platform)))
        }
        assertEquals(1, asks)
        assertEquals(mic or call, rung.running)
        // Once granted it stays: the next toggle asks nothing.
        rung.onMuteToggled { asks += 1 }
        assertEquals(1, asks)
    }

    @Test
    fun `a refused re-ask asks again at the next event and never by itself`() {
        val (rung, ladder) = fellBack()
        val platform = Platform(micUsable = false)
        var asks = 0
        val ask = {
            asks += 1
            rung.record(ladder.first(), reaskForegroundOnLadder(ladder, rung.running!!, start(platform)))
        }
        rung.onAppForeground(ask)
        assertEquals(1, asks)
        assertEquals(call, rung.running)
        assertEquals("no loop: nothing re-asks without an event", 1, asks)
        platform.micUsable = true
        rung.onAppForeground(ask)
        assertEquals(2, asks)
        assertEquals(mic or call, rung.running)
    }

    @Test
    fun `an upgrade can land on a middle rung`() {
        // Share on, microphone usable again but projection still refused:
        // better than the floor, short of the full set, and still "lesser".
        val ladder = voiceForegroundTypeLadder(34, projecting = true, microphoneGranted = true)
        val accepted = reaskForegroundOnLadder(ladder, call, start = { types ->
            if (types and projection != 0) throw SecurityException("no projection")
        })
        assertEquals(mic or call, accepted)
        val rung = ForegroundRung()
        rung.record(ladder.first(), accepted)
        assertTrue(rung.lesser)
    }

    @Test
    fun `the ladder a re-ask walks ends on the rung already held`() {
        val ladder = voiceForegroundTypeLadder(34, projecting = true, microphoneGranted = true)
        // From the floor every rung is an improvement; best first.
        assertEquals(listOf(mic or call or projection, call or projection, mic or call, call), reaskLadder(ladder, call))
        // From microphone + call, the no-microphone rung is not.
        assertEquals(listOf(ladder.first(), mic or call), reaskLadder(ladder, mic or call))
        assertEquals(listOf(ladder.first()), reaskLadder(ladder, ladder.first()))
        // A held set that is not on the ladder is asked for nothing better.
        assertEquals(listOf(0x1234), reaskLadder(ladder, 0x1234))
    }

    @Test
    fun `the notification says the microphone is paused only without the type`() {
        val wanted = mic or call
        assertTrue(microphonePaused(wanted, call))
        assertFalse(microphonePaused(wanted, mic or call))
        // A share rung without the microphone is paused too.
        assertTrue(microphonePaused(wanted or projection, call or projection))
        // Android 13 and below never asked for the type.
        assertFalse(microphonePaused(0, 0))
    }
}
