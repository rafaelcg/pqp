package gg.pqp.app.ui.media

/**
 * The arithmetic behind pinch, pan and double tap in [ImageViewerDialog].
 *
 * Pure and in pixels, so it can be tested without a screen. The picture is
 * drawn `ContentScale.Fit` into the whole viewer and then scaled about its
 * centre, which is why the pan bound is half of what the scale added on each
 * axis: past that, the edge of the picture would leave the edge of the screen
 * and the reader would be panning over black.
 */
internal const val IMAGE_MIN_SCALE = 1f
internal const val IMAGE_MAX_SCALE = 5f

/** Where a double tap on an unzoomed picture lands. */
internal const val IMAGE_DOUBLE_TAP_SCALE = 2.5f

internal data class ImageZoom(
    val scale: Float = IMAGE_MIN_SCALE,
    val offsetX: Float = 0f,
    val offsetY: Float = 0f,
) {
    val zoomed: Boolean get() = scale > IMAGE_MIN_SCALE + 0.01f

    /**
     * One frame of a pinch or a drag. [zoom] is the multiplicative change the
     * gesture reported and [panX] / [panY] the movement of its centroid, both
     * since the previous frame. An unzoomed picture does not pan at all.
     */
    fun transform(
        zoom: Float,
        panX: Float,
        panY: Float,
        width: Float,
        height: Float,
    ): ImageZoom {
        val nextScale = (scale * zoom).coerceIn(IMAGE_MIN_SCALE, IMAGE_MAX_SCALE)
        if (nextScale <= IMAGE_MIN_SCALE) return ImageZoom()
        return ImageZoom(
            scale = nextScale,
            offsetX = clampPan(offsetX + panX, nextScale, width),
            offsetY = clampPan(offsetY + panY, nextScale, height),
        )
    }

    /** In when out, out when in. */
    fun doubleTap(): ImageZoom =
        if (zoomed) ImageZoom() else ImageZoom(scale = IMAGE_DOUBLE_TAP_SCALE)
}

internal fun clampPan(offset: Float, scale: Float, extent: Float): Float {
    val bound = ((scale - 1f) * extent / 2f).coerceAtLeast(0f)
    return offset.coerceIn(-bound, bound)
}

/**
 * A presigned read URL, re-minted at most once.
 *
 * The read URL expires (`ATTACHMENT_URL_TTL_SECONDS`, twelve hours unless the
 * deployment says otherwise), and a transcript can be on screen, or held in
 * memory behind another screen, for longer than that. The first load failure
 * is the best signal there is that it has; a second failure is a real one, and
 * retrying it forever would be a loop against somebody's data plan. The same
 * bound the video player and the iOS client put on the same failure.
 */
internal class RemintOnce(private val mint: (suspend () -> String?)?) {
    private var tried = false

    /** A fresh URL to try, or null when there is nothing more to try. */
    suspend fun next(): String? {
        if (tried) return null
        tried = true
        val fresh = mint ?: return null
        return runCatching { fresh() }.getOrNull()?.takeIf { it.isNotBlank() }
    }
}
