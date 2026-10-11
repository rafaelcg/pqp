package gg.pqp.app.voice

/**
 * The arithmetic of putting a game's sound into the call, kept free of Android
 * so it can be exercised on the JVM.
 *
 * ### Why the game rides the microphone
 *
 * Neither WebRTC build in this app can publish a second, app-fed audio track:
 * both create audio tracks from the one `AudioDeviceModule`, whose recorder is
 * the microphone. What both builds DO offer is a hook on that recorder's
 * buffers before they are encoded (`AudioBufferCallback`), and that is where
 * the device's playback, captured through `AudioPlaybackCapture`, is added in.
 * It is the same route LiveKit's own SDK takes for screen-share audio on
 * Android (`ScreenAudioCapturer`).
 *
 * The consequence everybody else sees: the game arrives as part of the
 * presenter's voice, not as a separate share sound. It follows the presenter's
 * voice volume, and a moderator's server mute silences it too. What it does not
 * follow is the presenter's OWN mute: while the game's sound is live, the track
 * stays on and the microphone half of each buffer is zeroed instead
 * ([mixPcm16]'s `micOn`), so muting yourself to stop talking does not also cut
 * the game the room is watching.
 *
 * ### Why a ring and not a straight read
 *
 * The recorder callback runs on the microphone's own thread, every 10 ms, and
 * anything that blocks it is a gap in the presenter's voice. So the playback
 * recorder is read without blocking, whatever it has is queued here, and each
 * microphone buffer takes what it needs from the queue. Two clocks that are
 * nominally the same rate still drift and jitter against each other; the ring
 * absorbs the jitter, pads an underrun with silence, and drops the oldest audio
 * when it grows past [capacity] so a slow drift can never become a growing
 * delay between the picture and its sound.
 */
class PcmRing(val capacity: Int) {
    private val data = ShortArray(capacity)
    private var head = 0 // next sample to read
    var size = 0
        private set

    init {
        require(capacity > 0) { "capacity must be positive" }
    }

    /**
     * Append [count] samples of [src]. When that would overflow, the OLDEST
     * samples go: late audio is worth less than current audio.
     */
    fun write(src: ShortArray, count: Int) {
        if (count <= 0) return
        // More than the whole ring: only the newest `capacity` samples matter.
        val skip = maxOf(0, count - capacity)
        val n = count - skip
        val overflow = size + n - capacity
        if (overflow > 0) {
            head = (head + overflow) % capacity
            size -= overflow
        }
        var tail = (head + size) % capacity
        for (i in skip until count) {
            data[tail] = src[i]
            tail = if (tail + 1 == capacity) 0 else tail + 1
        }
        size += n
    }

    /** Take up to [count] samples into [dst]; returns how many were there. */
    fun read(dst: ShortArray, count: Int): Int {
        val n = minOf(count, size)
        for (i in 0 until n) {
            dst[i] = data[head]
            head = if (head + 1 == capacity) 0 else head + 1
        }
        size -= n
        return n
    }

    fun clear() {
        head = 0
        size = 0
    }
}

/**
 * Mix [game] into [mic], in place, over the first [count] samples.
 *
 * [gameCount] is how many game samples are real; past it the game is silence,
 * which is what an underrun sounds like and is better than repeating anything.
 * [micOn] false zeroes the microphone half, which is how a muted presenter
 * keeps sending the game and nothing else. The sum saturates at the 16-bit
 * limits: wrapping round would turn a loud moment into a burst of noise.
 */
fun mixPcm16(
    mic: ShortArray,
    count: Int,
    game: ShortArray,
    gameCount: Int,
    micOn: Boolean,
    gameGain: Float = GAME_AUDIO_GAIN,
) {
    for (i in 0 until count) {
        val voice = if (micOn) mic[i].toInt() else 0
        val extra = if (i < gameCount) Math.round(game[i] * gameGain) else 0
        mic[i] = (voice + extra).coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
    }
}

/**
 * How loud the game is against the voice.
 *
 * Below 1 because a game is mastered to fill the scale and a voice through a
 * phone microphone is not: at full level the game buries whoever is talking
 * over it, and the presenter is usually the one talking. A first guess to be
 * settled on a device; see the QA list on the PR that introduced it.
 */
const val GAME_AUDIO_GAIN = 0.7f

/**
 * How much game audio may wait in the ring: 200 ms. Enough for a scheduling
 * hiccup on either thread, short enough that the sound never trails the
 * picture by a noticeable amount.
 */
fun gameAudioRingCapacity(sampleRate: Int, channelCount: Int): Int =
    maxOf(1, sampleRate / 5 * maxOf(1, channelCount))
