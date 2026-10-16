package gg.pqp.app.stories.camera

import gg.pqp.app.stories.StoriesRules
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.roundToInt

/**
 * The camera's rules that have an edge to get wrong, with no CameraX and no
 * Compose, so each one is a JVM test. Same shape as `StoriesRules`.
 *
 * Nothing here reads a clock or an animation: a recording's ring and its
 * 30 s stop are driven by the wall clock the caller passes in, never by a
 * Compose animation. Compose scales every `animateTo` by the system's
 * animator duration scale, so a timer built on one stops at the first frame
 * for somebody who turned "Remove animations" on (the story viewer lost its
 * clock exactly that way, see `RealTimeClock` in `StoryViewer.kt`).
 */
object CaptureRules {

    /** A story's video limit, the shared one. */
    const val MAX_RECORDING_MS = StoriesRules.MAX_VIDEO_MS

    /**
     * How long a finger must stay on the shutter before it is a recording and
     * not a tap. Short enough that "hold" feels immediate, long enough that a
     * firm tap never starts a clip.
     */
    const val HOLD_TO_RECORD_MS = 320L

    /** A clip shorter than this is a tap that ran long: not worth a story. */
    const val MIN_CLIP_MS = 600L

    enum class Lens {
        Back,
        Front,
        ;

        val other: Lens get() = if (this == Back) Front else Back
    }

    enum class Flash {
        Off,
        Auto,
        On,
    }

    /**
     * What the flash button cycles through. The back lens with a flash unit has
     * all three; a front lens has no unit to fire, so its "on" is the screen
     * lighting up and there is no "auto" (a white screen on every daylight
     * selfie would be worse than none). A back lens with no unit has no flash
     * at all.
     */
    fun flashChoices(lens: Lens, hasFlashUnit: Boolean): List<Flash> = when {
        lens == Lens.Front && !hasFlashUnit -> listOf(Flash.Off, Flash.On)
        hasFlashUnit -> listOf(Flash.Off, Flash.Auto, Flash.On)
        else -> emptyList()
    }

    /** The next choice in [choices], round again. A mode that is no longer offered falls back to the first. */
    fun nextFlash(current: Flash, choices: List<Flash>): Flash {
        if (choices.isEmpty()) return Flash.Off
        val at = choices.indexOf(current)
        return if (at < 0) choices.first() else choices[(at + 1) % choices.size]
    }

    /**
     * Which lens to open with: the back one, or the front one when that is all
     * the phone has (a tablet, a Chromebook, an emulator with one webcam).
     */
    fun startingLens(hasBack: Boolean, hasFront: Boolean): Lens? = when {
        hasBack -> Lens.Back
        hasFront -> Lens.Front
        else -> null
    }

    /** The flip control is only worth showing when there is something to flip to. */
    fun canFlip(hasBack: Boolean, hasFront: Boolean): Boolean = hasBack && hasFront

    /** 0..1 around the shutter ring. */
    fun ringProgress(elapsedMs: Long): Float =
        (elapsedMs.toFloat() / MAX_RECORDING_MS).coerceIn(0f, 1f)

    fun reachedLimit(elapsedMs: Long): Boolean = elapsedMs >= MAX_RECORDING_MS

    /** Whole seconds left, rounded up, for the screen reader and the timer chip. */
    fun secondsLeft(elapsedMs: Long): Int =
        (((MAX_RECORDING_MS - elapsedMs).coerceAtLeast(0) + 999) / 1000).toInt()

    /** "0:07": the time recorded so far. */
    fun clock(elapsedMs: Long): String {
        val seconds = (elapsedMs.coerceAtLeast(0) / 1000).toInt()
        return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
    }

    /** Whether a finished clip is long enough to keep. */
    fun keepClip(elapsedMs: Long): Boolean = elapsedMs >= MIN_CLIP_MS

    /** A pinch changes the zoom by its own factor, held inside what the lens can do. */
    fun pinchZoom(current: Float, pinchFactor: Float, min: Float, max: Float): Float =
        (current * pinchFactor).coerceIn(min, max)

    /**
     * Zoom while a finger is held on the shutter and slides up, the way the
     * other story cameras do it: a full [travelPx] up the screen runs the
     * whole range, and the curve is exponential so each centimetre feels like
     * the same amount of zoom (a linear map would crawl from 1x to 2x and
     * race from 5x to 10x).
     */
    fun dragZoom(startRatio: Float, upwardPx: Float, travelPx: Float, min: Float, max: Float): Float {
        if (travelPx <= 0f || min <= 0f || max <= min) return startRatio.coerceIn(min, max)
        val fraction = (upwardPx / travelPx).coerceIn(-1f, 1f)
        val span = ln(max / min)
        return (startRatio * exp(fraction * span)).coerceIn(min, max)
    }

    /** "1.0x", "2.5x": the zoom chip. One decimal, a point, never a comma, it is a unit. */
    fun zoomLabel(ratio: Float): String {
        val tenths = (ratio * 10).roundToInt()
        return "${tenths / 10}.${tenths % 10}x"
    }

    /** What the screen reader says when the shutter is held for video. */
    fun recordingLabel(elapsedMs: Long, secondsLeftLabel: (Int) -> String): String =
        secondsLeftLabel(secondsLeft(elapsedMs))

    /** `ImageCapture` mirrors a front shot so the file matches the preview; the back lens never. */
    fun mirrorsCapture(lens: Lens): Boolean = lens == Lens.Front

    /**
     * The torch is only meant for video: a photo uses the flash. It needs a
     * flash unit, which most front cameras do not have (they use the screen).
     */
    fun torchDuringVideo(flash: Flash, hasFlashUnit: Boolean): Boolean = flash == Flash.On && hasFlashUnit

    /**
     * Where the shutter's touch ended up: a tap or a recording. A finger down
     * for [HOLD_TO_RECORD_MS] is a recording, whatever it does afterwards.
     */
    fun isHold(downMs: Long): Boolean = downMs >= HOLD_TO_RECORD_MS
}
