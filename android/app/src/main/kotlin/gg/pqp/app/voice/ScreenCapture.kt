package gg.pqp.app.voice

import android.content.Context
import android.os.Build
import android.util.DisplayMetrics
import android.view.WindowManager

/**
 * What the screen is captured at, and what its encoder is allowed to spend.
 *
 * A BITRATE CEILING IS NOT A RESOLUTION. This is the lesson the web client
 * learned the expensive way, and it is written here because Android makes the
 * same mistake available in a different shape. On the web, picking 360p only
 * moved `maxBitrate`, and every rung below 1080p still arrived at the far end
 * as 1920x1080: once the encoder has ramped up to the capture size it stays
 * there and pays a smaller allowance in artefacts rather than in pixels. See
 * `screenScaleFactor` in `client/src/lib/video-quality.ts`.
 *
 * Android hands us the knob the browser refused to: `MediaProjection` builds a
 * VirtualDisplay at whatever size we ask for, so [ScreenCaptureProfile] is a
 * real capture size and not a hint. The bitrate ceiling in [meshScreenBitrate]
 * is then exactly what its name says, a ceiling, and neither number is allowed
 * to stand in for the other.
 *
 * Everything here is a pure function of a display size, so the arithmetic that
 * decides what a viewer sees can be exercised without a device.
 */
data class ScreenCaptureProfile(
    val width: Int,
    val height: Int,
    val frameRate: Int,
)

/**
 * Lines on the **short** side of the capture.
 *
 * Short side rather than height, because a phone is shared in portrait: its
 * height is the long side, and "720p" applied to it would mean 720x322, a
 * letterbox slot of a phone screen. The short side is the dimension that keeps
 * the label meaning the same amount of detail on a phone, on a tablet held
 * either way, and on a desktop mirrored to one.
 */
const val SCREEN_TARGET_SHORT_SIDE = 720

/**
 * 30, matching the web's screen sender.
 *
 * Screen content on this product is games and films at least as often as it is
 * a document, and holding resolution while the framerate collapses turns a
 * game into a slideshow. The bitrate ceiling is what protects a weak uplink,
 * not a framerate that is low for everybody.
 */
const val SCREEN_FRAME_RATE = 30

/**
 * The capture size for a display, preserving its aspect ratio exactly.
 *
 * Exactly, because a VirtualDisplay whose aspect ratio differs from the
 * display's letterboxes the capture: the viewer gets black bars baked into the
 * pixels, which no amount of layout at the far end can remove.
 *
 * Dimensions are rounded to even numbers. H.264 chroma subsampling is defined
 * on 2x2 blocks and an odd dimension is refused outright by some hardware
 * encoders, which presents as a share that starts and sends nothing.
 */
fun screenCaptureProfileFor(
    displayWidth: Int,
    displayHeight: Int,
    targetShortSide: Int = SCREEN_TARGET_SHORT_SIDE,
    frameRate: Int = SCREEN_FRAME_RATE,
): ScreenCaptureProfile {
    if (displayWidth <= 0 || displayHeight <= 0) {
        return ScreenCaptureProfile(targetShortSide, targetShortSide, frameRate)
    }
    val shortSide = minOf(displayWidth, displayHeight)
    // Never an upscale. Capturing a 480-line display at 720 lines spends
    // bitrate inventing pixels that carry no detail, and the honest reading of
    // "up to 720" is "this display, unchanged".
    val scale = if (shortSide <= targetShortSide) 1.0 else targetShortSide.toDouble() / shortSide
    return ScreenCaptureProfile(
        width = even(displayWidth * scale),
        height = even(displayHeight * scale),
        frameRate = frameRate,
    )
}

private fun even(value: Double): Int {
    val rounded = Math.round(value).toInt()
    return maxOf(2, rounded - (rounded % 2))
}

/**
 * Total upload one screen sender is allowed, in bits per second.
 *
 * A CEILING, NOT A TARGET. Nothing here makes anybody send 2 Mbps; WebRTC's
 * congestion controller has its own estimate of what the link carries and
 * sends the lower of the two, revised several times a second. On a link that
 * cannot do 2 Mbps this number is inert.
 *
 * The budget is smaller than the web's 5 Mbps on purpose, and the per-sender
 * cap smaller than its 4 Mbps. This is a phone: it is on a domestic uplink at
 * best and a cellular one at worst, it is encoding in software often enough to
 * matter, and it is spending its own battery to do it. In a mesh the presenter
 * uploads a full copy per peer, so the budget is divided rather than granted
 * per connection.
 */
fun meshScreenBitrate(peerCount: Int): Int {
    val share = SCREEN_UPLOAD_BUDGET_BPS / maxOf(1, peerCount)
    return minOf(SCREEN_MAX_BITRATE_BPS, maxOf(SCREEN_MIN_BITRATE_BPS, share))
}

private const val SCREEN_UPLOAD_BUDGET_BPS = 3_000_000
private const val SCREEN_MIN_BITRATE_BPS = 500_000
private const val SCREEN_MAX_BITRATE_BPS = 2_000_000

/**
 * The size of the display `MediaProjection` will capture.
 *
 * Read from the window manager rather than `resources.displayMetrics`, because
 * the two disagree exactly when it matters: in split screen or a freeform
 * window the app's metrics describe its own slot while the projection captures
 * the whole display, and a capture sized from the wrong one is stretched.
 */
fun displaySizeOf(context: Context): Pair<Int, Int> {
    val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val bounds = windowManager.maximumWindowMetrics.bounds
        return bounds.width() to bounds.height()
    }
    @Suppress("DEPRECATION")
    val metrics = DisplayMetrics().also { windowManager.defaultDisplay.getRealMetrics(it) }
    return metrics.widthPixels to metrics.heightPixels
}
